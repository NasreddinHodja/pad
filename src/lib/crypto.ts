// End-to-end encryption of a root's pads. Runs in the browser only: the
// server never sees a password, a key, a pad's text or a subpad's name.
//
//   password ─Argon2id(salt)─► master ─HKDF─┬─► auth: proves the password to the server
//                                            └─► wrap key: seals the root key
//   root key (random, one per root) ─HKDF─┬─► content key: AES-GCM over text and names
//                                          └─► name key: HMAC of a path, its id in the DB
//
// The server keeps the salt, Argon2id's cost, a hash of auth and the sealed
// root key. A password change re-seals the same root key, so no pad is
// re-encrypted.

import { argon2, type Argon2 } from './limits.ts';
import { padded } from './padme.ts';

const IV = 12;
/**
 * Sealed text is padded to at least this, names to at least the other (all
 * of dev's names fit in it): docs/architecture/encryption.org, Padding.
 */
const FLOOR = { text: 256, name: 128 } as const;

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

/**
 * What a password gives: the proof for the server, and the key that seals the
 * root key. A cost under the floor is refused: a server asking for one would
 * get an `auth` it can guess the password from cheaply.
 */
export async function fromPassword(password: string, salt: Bytes, cost: Argon2) {
  const checked = argon2(cost);
  if (!checked)
    throw new Error('the server asks for a password hash pad refuses: too weak, or too slow');
  // Loaded here, not with the page: only a password needs it, and a second
  // visit (keys from IndexedDB) or a read-only link has none.
  const { argon2id } = await import('hash-wasm');
  const master = await argon2id({
    password: password.normalize('NFC'),
    salt,
    iterations: checked.iterations,
    parallelism: checked.parallelism,
    memorySize: checked.memory,
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

// Padded: the plain bytes, a 0x80 marker, then zeros up to padme.ts's size.
// Seals from before padding have no marker, and text can end in 0x80, so
// padded ones say so in their associated data; the old ones still open.
async function sealPadded(key: CryptoKey, plain: Bytes, aad: string, floor: number) {
  const out = new Uint8Array(padded(plain.length + 1, floor));
  out.set(plain);
  out[plain.length] = 0x80;
  return seal(key, out, `${aad} padded`);
}

async function openPadded(key: CryptoKey, data: Bytes, aad: string) {
  const plain = await open(key, data, `${aad} padded`).catch(() => null);
  if (!plain) return { plain: await open(key, data, aad), padded: false };
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 0x80) throw new Error("the server's copy doesn't decrypt: it's malformed");
  return { plain: plain.subarray(0, end), padded: true };
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
  sealPadded(keys.content, utf8.encode(text), `pad text\n${id}`, FLOOR.text);
/** The pad's text as UTF-8, for what only stores it (export). */
export const openTextBytes = async (keys: Keys, id: string, data: Bytes) =>
  (await openPadded(keys.content, data, `pad text\n${id}`)).plain;
export const openText = async (keys: Keys, id: string, data: Bytes) =>
  utf8Decode.decode(await openTextBytes(keys, id, data));
export const sealName = async (keys: Keys, id: string, path: string) =>
  toBase64(await sealPadded(keys.content, utf8.encode(path), `pad name\n${id}`, FLOOR.name));
/** `padded` false: sealed before padding, its length shows; the next save re-seals it. */
export async function openName(keys: Keys, id: string, sealed: string) {
  const { plain, padded } = await openPadded(keys.content, fromBase64(sealed), `pad name\n${id}`);
  return { path: utf8Decode.decode(plain), padded };
}

// The root's theme, which isn't any one pad's. Not padded: it's always
// `{bg, fg, ink}`, the same length (api.ts).
export const sealTheme = async (keys: Keys, json: string) =>
  seal(keys.content, utf8.encode(json), 'pad theme');
export const openTheme = async (keys: Keys, data: Bytes) =>
  utf8Decode.decode(await open(keys.content, data, 'pad theme'));

// A signed-in browser's label ("Firefox on Linux", auth.ts), padded to 64
// bytes: one length for all, so the server can't tell browsers by it.
export const LABEL_BYTES = 63;
export const sealLabel = async (keys: Keys, label: string) =>
  sealPadded(keys.content, utf8.encode(label).subarray(0, LABEL_BYTES), 'pad browser label', 64);
export const openLabel = async (keys: Keys, data: Bytes) =>
  utf8Decode.decode((await openPadded(keys.content, data, 'pad browser label')).plain);

// A read-only link: a copy of a pad and those under it, sealed under a key of
// its own, which the link carries after its `#`, so the server never gets it.
// The root keeps the key too, sealed, for its owners to list the links again.
const shareKey = (key: Bytes, usage: KeyUsage) =>
  crypto.subtle.importKey('raw', key, 'AES-GCM', false, [usage]);

// What `api.share` makes: the pads, deflated.
export const sealShare = async (key: Bytes, id: string, plain: Bytes) =>
  sealPadded(await shareKey(key, 'encrypt'), plain, `pad share tree\n${id}`, FLOOR.text);
export const openShare = async (key: Bytes, id: string, data: Bytes) =>
  (await openPadded(await shareKey(key, 'decrypt'), data, `pad share tree\n${id}`)).plain;

// The root keeps a byte before the key: 1 if the link has a password, so its
// owners get the link back as it was made. Keys from before have no byte.
export const sealShareKey = (keys: Keys, id: string, key: Bytes, password: boolean) =>
  seal(keys.content, Uint8Array.of(password ? 1 : 0, ...key), `pad share key\n${id}`);
export async function openShareKey(keys: Keys, id: string, sealed: Bytes) {
  const plain = await open(keys.content, sealed, `pad share key\n${id}`);
  return plain.length === 32
    ? { key: plain, password: false }
    : { key: plain.subarray(1), password: plain[0] === 1 };
}

/**
 * A link with a password is sealed under this, not the key in its `#`: both
 * are needed. Argon2id of the password, salted with the link's id, at
 * ARGON2's cost as it was when links got passwords (19 MiB, 2, 1): raising it
 * would need the link to say which cost it was made at.
 */
export async function linkKey(key: Bytes, password: string, id: string) {
  const { argon2id } = await import('hash-wasm');
  const stretched = await argon2id({
    password: password.normalize('NFC'),
    salt: utf8.encode(`pad share password\n${id}`),
    iterations: 2,
    parallelism: 1,
    memorySize: 19 * 1024,
    hashLength: 32,
    outputType: 'binary'
  });
  const base = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { ...hkdf('pad share password'), salt: new Uint8Array(stretched) },
    base,
    256
  );
  return new Uint8Array(bits);
}

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
