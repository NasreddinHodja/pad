// The browser's side of `/_/…`: everything sent is sealed first.

import {
  fromBase64,
  fromPassword,
  openLabel,
  openName,
  openRootKey,
  linkKey,
  openShareKey,
  openShare,
  openText,
  openTextBytes,
  openTheme,
  padId,
  padKeys,
  random,
  sealLabel,
  sealName,
  sealRootKey,
  sealShareKey,
  sealShare,
  sealText,
  sealTheme,
  toBase64,
  type Keys
} from './crypto.ts';
import { browserLabel } from './browser-label.ts';
import { deflate, inflate } from './deflate.ts';
import type { Pad } from './export.ts';
import {
  ARGON2,
  BATCH_PADS,
  canonical,
  MAX_SHARE,
  MAX_SHARE_PLAIN,
  normalizePath,
  type Argon2
} from './limits.ts';
import { parseTheme, type Theme } from './theme.ts';

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder();

/**
 * What a read-only link holds: the pad it was made at, and it and those under
 * it; and the root's theme.
 */
export type Shared = { path: string; pads: Pad[]; theme: Theme };

const base = (root: string) => '/_/' + encodeURIComponent(root);

/** A refused request: the server's message, its status, and how long it asked us to wait, if it did. */
export class Refused extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Milliseconds, from Retry-After. */
    readonly retryAfter?: number
  ) {
    super(message);
  }
}

const call = async (url: string, init: RequestInit = {}) => check(await fetch(url, init));

async function check(res: Response) {
  // 304 is an answer too: what was asked about hasn't changed.
  if (!res.ok && res.status !== 304) {
    const message = (await res.json().catch(() => null))?.message;
    const wait = Number(res.headers.get('retry-after'));
    throw new Refused(
      message ?? `request failed (${res.status})`,
      res.status,
      wait > 0 ? wait * 1000 : undefined
    );
  }
  return res;
}

// A DELETE has no body, and without a content-type SvelteKit's CSRF check
// takes it for a form's: under our no-referrer policy Chromium's Origin isn't
// ours, and it's refused (403). The server's own check is Sec-Fetch-Site.
const del = (url: string, headers: Record<string, string> = {}) =>
  call(url, {
    method: 'DELETE',
    headers: { 'content-type': 'application/octet-stream', ...headers }
  });

const post = (url: string, data: unknown) =>
  call(url, {
    method: 'POST',
    body: JSON.stringify(data),
    headers: { 'content-type': 'application/json' }
  });

/** What the browser derives a root's password with: the root's own, from the server. */
export type Kdf = { salt: string; argon2: Argon2 };

/** A fresh salt, and the root key sealed under the password it gives at today's cost. */
async function seal(password: string, root: string, rootKey: Uint8Array<ArrayBuffer>) {
  const salt = random(16);
  const { auth, wrap } = await fromPassword(password, salt, ARGON2);
  return {
    salt: toBase64(salt),
    argon2: ARGON2,
    auth: toBase64(auth),
    sealedKey: toBase64(await sealRootKey(wrap, rootKey, root))
  };
}

export async function claim(root: string, password: string) {
  const rootKey = random(32);
  await post(`${base(root)}/auth/claim`, await seal(password, root, rootKey));
  return padKeys(rootKey);
}

/** The root key, after checking the password with the server. */
async function rootKey(root: string, password: string, kdf: Kdf) {
  const { auth, wrap } = await fromPassword(password, fromBase64(kdf.salt), kdf.argon2);
  const res = await post(`${base(root)}/auth/unlock`, { auth: toBase64(auth) });
  const key = await openRootKey(wrap, fromBase64((await res.json()).sealedKey), root);
  // The server said yes to a password its own sealed key doesn't open under.
  if (!key) throw new Error("the server's copy of the key doesn't match, refusing it");
  return { key, auth };
}

export async function unlock(root: string, password: string, kdf: Kdf) {
  return padKeys((await rootKey(root, password, kdf)).key);
}

/** The same root key, sealed under the new password: no pad changes. */
export async function changePassword(root: string, current: string, next: string, kdf: Kdf) {
  const { key, auth } = await rootKey(root, current, kdf);
  await post(`${base(root)}/auth/password`, {
    current: toBase64(auth),
    ...(await seal(next, root, key))
  });
}

export const lock = (root: string) => post(`${base(root)}/auth/lock`, {});

/** Marks the root and its pads deleted, and signs every browser out; its password reclaims it. */
export const remove = (root: string) => post(`${base(root)}/auth/delete`, {});

// What this tab has opened, decrypted, with the version or ETag the server
// gave it, so that asking "still this?" gets 304 and no body: moving between
// pads doesn't download the root's names, or a pad just left, again.
// Plaintext: it goes with the root's keys (forget). Pads' text, at most
// CACHE_CHARS, the oldest opened going first.
const CACHE_CHARS = 1 << 20;
const pads = new Map<string, { text: string; version: number }>();
const lists = new Map<string, { etag: string; paths: string[] }>();
/** `root\npath` of names sealed before padding (crypto.ts): their next save re-seals them. */
const unpadded = new Set<string>();
let cached = 0;

function remember(root: string, path: string, text: string, version: number) {
  const key = root + '\n' + path;
  const was = pads.get(key);
  if (was) cached -= was.text.length;
  pads.delete(key);
  pads.set(key, { text, version });
  cached += text.length;
  for (const [k, v] of pads) {
    if (cached <= CACHE_CHARS) break;
    pads.delete(k);
    cached -= v.text.length;
  }
}

/** Drops what this tab keeps of the root's pads and names: for when its keys go. */
export function forget(root: string) {
  for (const [k, v] of pads)
    if (k.startsWith(root + '\n')) {
      pads.delete(k);
      cached -= v.text.length;
    }
  lists.delete(root);
  for (const k of unpadded) if (k.startsWith(root + '\n')) unpadded.delete(k);
}

/** Every pad path in the root. */
export async function list(root: string, keys: Keys) {
  const known = lists.get(root);
  const res = await call(`${base(root)}/pads`, {
    headers: known ? { 'if-none-match': known.etag } : {},
    cache: 'no-store'
  });
  if (res.status === 304 && known) return [...known.paths];
  const sealed = ((await res.json()) as { pads: { id: string; name: string }[] }).pads;
  const names = await Promise.all(sealed.map((p) => openName(keys, p.id, p.name)));
  for (const { path, padded } of names) if (!padded) unpadded.add(root + '\n' + path);
  const paths = names.map((n) => n.path);
  const etag = res.headers.get('etag');
  if (etag) lists.set(root, { etag, paths });
  return [...paths];
}

/**
 * The pad, unless it's still at `version`: null then. Its version comes with
 * it, for the next ask.
 */
export async function loadSince(root: string, keys: Keys, path: string, version: number) {
  const id = await padId(keys, path);
  const res = await call(`${base(root)}/pads/${id}`, {
    headers: { 'if-none-match': `"${version}"` },
    cache: 'no-store'
  });
  if (res.status === 304) return null;
  const now = Number(res.headers.get('etag')?.slice(1, -1)) || 0;
  const text =
    res.status === 204 ? '' : await openText(keys, id, new Uint8Array(await res.arrayBuffer()));
  remember(root, path, text, now);
  return { text, version: now };
}

/** The pad: this tab's copy if the server says it's still current. */
export async function openPad(root: string, keys: Keys, path: string) {
  const known = pads.get(root + '\n' + path);
  // No version is -1: without a copy, always the pad itself.
  return (await loadSince(root, keys, path, known?.version ?? -1)) ?? known!;
}

/**
 * Up to BATCH_PADS pads in one request, their texts as UTF-8 in the order of
 * `paths`: empty for one that doesn't exist. Bytes, not strings: export only
 * stores them.
 */
export async function loadMany(root: string, keys: Keys, paths: string[]) {
  if (paths.length > BATCH_PADS) throw new Error(`at most ${BATCH_PADS} pads at once`);
  const ids = await Promise.all(paths.map((p) => padId(keys, p)));
  const res = await post(`${base(root)}/pads/batch`, { ids });
  const all = new Uint8Array(await res.arrayBuffer());
  const view = new DataView(all.buffer);
  const texts: Promise<Uint8Array<ArrayBuffer>>[] = [];
  let at = 0;
  for (const id of ids) {
    const length = view.getUint32(at, true);
    const sealed = all.subarray(at + 4, at + 4 + length);
    texts.push(length ? openTextBytes(keys, id, sealed) : Promise.resolve(new Uint8Array()));
    at += 4 + length;
  }
  return Promise.all(texts);
}

/**
 * An empty pad is deleted. `over`: the version the text was made over, or 0
 * for a pad that doesn't exist; refused (412) if the server's is newer.
 * `keep`: the text it overwrites is kept as a version, however recent. The
 * pad's new version: 0 once deleted.
 */
export async function save(
  root: string,
  keys: Keys,
  path: string,
  text: string,
  over: number,
  keep = false
) {
  const id = await padId(keys, path);
  const url = `${base(root)}/pads/${id}`;
  if (text === '') {
    await del(url, { 'if-match': `"${over}"` });
    remember(root, path, '', 0);
    return 0;
  }
  const res = await call(url, {
    method: 'PUT',
    body: await sealText(keys, id, text),
    headers: {
      'content-type': 'application/octet-stream',
      'if-match': `"${over}"`,
      ...(keep && { 'x-keep': '1' }),
      // Only a pad the server has no row for, an emptied one, or one whose
      // name shows its length needs its name: a fresh seal of it on every
      // save would change the root's list.
      ...((over === 0 || unpadded.has(root + '\n' + path)) && {
        'x-pad-name': await sealName(keys, id, path)
      })
    }
  });
  unpadded.delete(root + '\n' + path);
  const { updatedAt } = (await res.json()) as { updatedAt: number };
  remember(root, path, text, updatedAt);
  return updatedAt;
}

/** The pad's kept versions, newest first: each one's time (its version) and sealed size. */
export async function versions(root: string, keys: Keys, path: string) {
  const res = await call(`${base(root)}/pads/${await padId(keys, path)}/versions`);
  return ((await res.json()) as { versions: { at: number; bytes: number }[] }).versions;
}

/** One kept version's text. */
export async function version(root: string, keys: Keys, path: string, at: number) {
  const id = await padId(keys, path);
  const res = await call(`${base(root)}/pads/${id}/versions/${at}`);
  return openText(keys, id, new Uint8Array(await res.arrayBuffer()));
}

/** A browser signed in to a root (auth.ts); `label` is null until it sends one. */
export type Browser = {
  id: string;
  createdAt: number;
  lastSeen: number;
  label: string | null;
  mine: boolean;
};

/** The browsers signed in to `root`, their labels opened; one that won't open is null. */
export async function browsers(root: string, keys: Keys): Promise<Browser[]> {
  const rows: Browser[] = await (await call(`${base(root)}/browsers`)).json();
  return Promise.all(
    rows.map(async (b) => ({
      ...b,
      label: b.label ? await openLabel(keys, fromBase64(b.label)).catch(() => null) : null
    }))
  );
}

/** Tells the server what to call this browser, sealed. */
export async function labelBrowser(root: string, keys: Keys) {
  await call(`${base(root)}/browsers`, {
    method: 'PUT',
    body: await sealLabel(keys, browserLabel(navigator.userAgent)),
    headers: { 'content-type': 'application/octet-stream' }
  });
}

export const signOut = (root: string, id: string) => del(`${base(root)}/browsers/${id}`);

/** The root's theme; null if it's never been picked. */
export async function theme(root: string, keys: Keys) {
  const res = await call(`${base(root)}/theme`);
  if (res.status === 204) return null;
  return parseTheme(JSON.parse(await openTheme(keys, new Uint8Array(await res.arrayBuffer()))));
}

export async function setTheme(root: string, keys: Keys, { bg, fg, ink }: Theme) {
  await call(`${base(root)}/theme`, {
    method: 'PUT',
    body: await sealTheme(keys, JSON.stringify({ bg, fg, ink })),
    headers: { 'content-type': 'application/octet-stream' }
  });
}

export type Share = {
  id: string;
  url: string;
  createdAt: number;
  /** Null: never. */
  expiresAt: number | null;
  once: boolean;
  password: boolean;
};

/** How a new link is made: milliseconds it lasts (LINK_LIFETIMES) or null, and its password, if any. */
export type LinkOptions = { lifetime: number | null; once: boolean; password: string };

/**
 * The link's own page, with its key where the server never sees it: `#<key>`,
 * or `#!<key>` if it has a password too (`!` is outside base64's alphabet).
 */
const shareUrl = (root: string, id: string, key: Uint8Array, password: boolean) =>
  `${location.origin}${base(root)}/s/${id}#${password ? '!' : ''}${toBase64(key)}`;

/** A read-only link to a copy of the pad and those under it, as they are now. */
export async function share(
  root: string,
  keys: Keys,
  path: string,
  pads: Pad[],
  theme: Theme,
  { lifetime, once, password }: LinkOptions
) {
  const id = toBase64(random(16));
  const key = random(32);
  const json = utf8.encode(JSON.stringify({ path, pads, theme } satisfies Shared));
  if (json.length > MAX_SHARE_PLAIN)
    throw new Error(
      `/${path} and its pads come to ${Math.ceil(json.length / 1024 / 1024)} MiB, over the ${MAX_SHARE_PLAIN / 1024 / 1024} MiB a link holds`
    );
  const plain = await deflate(json);
  const body = await sealShare(password ? await linkKey(key, password, id) : key, id, plain);
  if (body.length > MAX_SHARE)
    throw new Error(
      `/${path} and its pads come to ${Math.ceil(body.length / 1024)} KiB compressed, over the ${MAX_SHARE / 1024} KiB a link holds`
    );
  const res = await call(`${base(root)}/shares/${id}`, {
    method: 'PUT',
    body,
    headers: {
      'content-type': 'application/octet-stream',
      'x-pad-id': await padId(keys, path),
      'x-share-key': toBase64(await sealShareKey(keys, id, key, !!password)),
      ...(lifetime === null ? {} : { 'x-expires-in': String(lifetime) }),
      ...(once ? { 'x-once': '1' } : {})
    }
  });
  const { createdAt } = await res.json();
  return {
    id,
    url: shareUrl(root, id, key, !!password),
    createdAt,
    expiresAt: lifetime === null ? null : createdAt + lifetime,
    once,
    password: !!password
  } satisfies Share;
}

/** The pad's links, oldest first. */
export async function shares(root: string, keys: Keys, path: string) {
  const res = await call(`${base(root)}/pads/${await padId(keys, path)}/shares`);
  const { shares } = (await res.json()) as {
    shares: {
      id: string;
      sealedKey: string;
      createdAt: number;
      expiresAt: number | null;
      once: boolean;
    }[];
  };
  return Promise.all(
    shares.map(async ({ id, sealedKey, createdAt, expiresAt, once }) => {
      const { key, password } = await openShareKey(keys, id, fromBase64(sealedKey));
      return {
        id,
        url: shareUrl(root, id, key, password),
        createdAt,
        expiresAt,
        once,
        password
      } satisfies Share;
    })
  );
}

export const revoke = (root: string, id: string) => del(`${base(root)}/shares/${id}`);

export const revokeAll = async (root: string, keys: Keys, path: string) =>
  del(`${base(root)}/pads/${await padId(keys, path)}/shares`);

/** What a link's `#` holds: its key, and whether it has a password too. Null if it's no key. */
export function linkFragment(fragment: string) {
  const password = fragment.startsWith('!');
  const key = password ? fragment.slice(1) : fragment;
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
  return { key: fromBase64(key), password };
}

/**
 * A link's sealed copy; 'once' if it opens once and `once` wasn't said: asked
 * again with it, the server deletes it as it sends it.
 */
export async function fetchShare(root: string, id: string, once = false) {
  const res = await fetch(`${base(root)}/shares/${id}`, {
    headers: once ? { 'x-open': 'once' } : {}
  });
  if (res.status === 409 && !once) return 'once';
  await check(res);
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    createdAt: Number(res.headers.get('x-created-at'))
  };
}

/**
 * A link's copy, opened with its key, or the key its password gives
 * (`linkKey`). Its path is whatever the link's maker wrote: one outside the
 * link's root is refused, or the page would name, and its edit button lead
 * to, another root's pad.
 */
export async function openShared(
  root: string,
  id: string,
  key: Uint8Array<ArrayBuffer>,
  data: Uint8Array<ArrayBuffer>
) {
  const plain = await openShare(key, id, data);
  const shared: Shared = JSON.parse(utf8Decode.decode(await inflate(plain, MAX_SHARE_PLAIN)));
  const path = normalizePath(String(shared.path));
  if (path !== shared.path || path.split('/')[0] !== canonical(root))
    throw new Error("malformed: the link's copy names a pad outside its root");
  return { ...shared, theme: parseTheme(shared.theme) };
}
