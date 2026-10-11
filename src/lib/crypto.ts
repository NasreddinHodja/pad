// End-to-end encryption of a root's pads. Runs in the browser only: the
// server never sees a password, a key, a pad's text or a subpad's name.
//
//   password ─Argon2id(salt)─► master ─HKDF─┬─► auth: proves the password to the server
//                                            └─► wrap key: seals the root key
//   root key (random, one per root) ─HKDF─┬─► content key: AES-GCM over text and names
//                                          └─► name key: HMAC of a path, its id in the DB
//
// The server keeps the salt, a hash of auth and the sealed root key. A
// password change re-seals the same root key, so no pad is re-encrypted.

import { argon2id } from 'hash-wasm';

// OWASP's minimum for Argon2id, as the server used before.
const ARGON2 = { iterations: 2, parallelism: 1, memorySize: 19 * 1024 } as const;
const IV = 12;

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 256;

export type Keys = { content: CryptoKey; name: CryptoKey };
type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

export const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export function fromBase64(text: string) {
  const bin = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Why a new password can't be used, if it can't. Counted in characters. */
export function checkPassword(password: string) {
  const length = [...password].length;
  if (length < MIN_PASSWORD) return `the password needs at least ${MIN_PASSWORD} characters`;
  if (length > MAX_PASSWORD) return `the password can have at most ${MAX_PASSWORD} characters`;
  return null;
}

function hkdf(info: string) {
  return { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: utf8.encode(info) };
}

/** What a password gives: the proof for the server, and the key that seals the root key. */
export async function fromPassword(password: string, salt: Bytes) {
  const master = await argon2id({
    password: password.normalize('NFC'),
    salt,
    ...ARGON2,
    hashLength: 32,
    outputType: 'binary'
  });
  const base = await crypto.subtle.importKey('raw', new Uint8Array(master), 'HKDF', false, [
    'deriveBits',
    'deriveKey'
  ]);
  const auth = new Uint8Array(await crypto.subtle.deriveBits(hkdf('pad auth'), base, 256));
  const wrap = await crypto.subtle.deriveKey(
    hkdf('pad wrap'),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  return { auth, wrap };
}

async function seal(key: CryptoKey, plain: Bytes, aad: string) {
  const iv = random(IV);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8.encode(aad) },
    key,
    plain
  );
  const out = new Uint8Array(IV + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV);
  return out;
}

/** Throws if the data was changed, or sealed for another place. */
async function open(key: CryptoKey, data: Bytes, aad: string) {
  const plain = await crypto.subtle
    .decrypt(
      { name: 'AES-GCM', iv: data.subarray(0, IV), additionalData: utf8.encode(aad) },
      key,
      data.subarray(IV)
    )
    .catch(() => {
      throw new Error("the server's copy doesn't decrypt: it was changed, or is damaged");
    });
  return new Uint8Array(plain);
}

// The root's name is in every seal, so nothing sealed for one root opens in another.
export const sealRootKey = (wrap: CryptoKey, rootKey: Bytes, root: string) =>
  seal(wrap, rootKey, `pad root key\n${root}`);

/** Null if the password was wrong. */
export async function openRootKey(wrap: CryptoKey, sealed: Bytes, root: string) {
  return open(wrap, sealed, `pad root key\n${root}`).catch(() => null);
}

/** The keys a root's pads use; they can be used but never read back out. */
export async function padKeys(rootKey: Bytes): Promise<Keys> {
  const base = await crypto.subtle.importKey('raw', rootKey, 'HKDF', false, ['deriveKey']);
  const content = await crypto.subtle.deriveKey(
    hkdf('pad content'),
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const name = await crypto.subtle.deriveKey(
    hkdf('pad name'),
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign']
  );
  return { content, name };
}

/** The id a pad is stored under: the same path always gives the same id. */
export async function padId(keys: Keys, path: string) {
  return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', keys.name, utf8.encode(path))));
}

// Text and name are sealed to their id, so the server can't swap two pads'
// contents or names without the browser noticing.
export const sealText = async (keys: Keys, id: string, text: string) =>
  seal(keys.content, utf8.encode(text), `pad text\n${id}`);
export const openText = async (keys: Keys, id: string, data: Bytes) =>
  utf8Decode.decode(await open(keys.content, data, `pad text\n${id}`));
export const sealName = async (keys: Keys, id: string, path: string) =>
  toBase64(await seal(keys.content, utf8.encode(path), `pad name\n${id}`));
export const openName = async (keys: Keys, id: string, sealed: string) =>
  utf8Decode.decode(await open(keys.content, fromBase64(sealed), `pad name\n${id}`));

// The root's theme, which isn't any one pad's.
export const sealTheme = async (keys: Keys, json: string) =>
  seal(keys.content, utf8.encode(json), 'pad theme');
export const openTheme = async (keys: Keys, data: Bytes) =>
  utf8Decode.decode(await open(keys.content, data, 'pad theme'));

// A read-only link: a copy of a pad and those under it, sealed under a key of
// its own, which the link carries after its `#`, so the server never gets it.
// The root keeps the key too, sealed, for its owners to list the links again.
const shareKey = (key: Bytes, usage: KeyUsage) =>
  crypto.subtle.importKey('raw', key, 'AES-GCM', false, [usage]);

// What `api.share` makes: the pads, deflated.
export const sealShare = async (key: Bytes, id: string, plain: Bytes) =>
  seal(await shareKey(key, 'encrypt'), plain, `pad share tree\n${id}`);
export const openShare = async (key: Bytes, id: string, data: Bytes) =>
  open(await shareKey(key, 'decrypt'), data, `pad share tree\n${id}`);

export const sealShareKey = (keys: Keys, id: string, key: Bytes) =>
  seal(keys.content, key, `pad share key\n${id}`);
export const openShareKey = (keys: Keys, id: string, sealed: Bytes) =>
  open(keys.content, sealed, `pad share key\n${id}`);

// The keys stay in this browser between visits, in IndexedDB, as keys it
// can use but not export: a script on the page could decrypt with them while
// it runs, but can't carry them off.
const DB = 'pad';
const STORE = 'keys';

function idb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await idb();
  return new Promise<T>((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export const storedKeys = (root: string) =>
  tx<Keys | undefined>('readonly', (s) => s.get(root)).catch(() => undefined);
export const storeKeys = (root: string, keys: Keys) => tx('readwrite', (s) => s.put(keys, root));
export const forgetKeys = (root: string) => tx('readwrite', (s) => s.delete(root));
