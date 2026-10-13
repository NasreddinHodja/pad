// The browser's side of `/_/…`: everything sent is sealed first.

import {
  fromBase64,
  fromPassword,
  openName,
  openRootKey,
  openShareKey,
  openShare,
  openText,
  openTextBytes,
  openTheme,
  padId,
  padKeys,
  random,
  sealName,
  sealRootKey,
  sealShareKey,
  sealShare,
  sealText,
  sealTheme,
  toBase64,
  type Keys
} from './crypto.ts';
import { deflate, inflate } from './deflate.ts';
import type { Pad } from './export.ts';
import { BATCH_PADS, MAX_SHARE } from './limits.ts';
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

async function call(url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
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

const post = (url: string, data: unknown) =>
  call(url, {
    method: 'POST',
    body: JSON.stringify(data),
    headers: { 'content-type': 'application/json' }
  });

/** A fresh salt, and the root key sealed under the password it gives. */
async function seal(password: string, root: string, rootKey: Uint8Array<ArrayBuffer>) {
  const salt = random(16);
  const { auth, wrap } = await fromPassword(password, salt);
  return {
    salt: toBase64(salt),
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
async function rootKey(root: string, password: string, salt: string) {
  const { auth, wrap } = await fromPassword(password, fromBase64(salt));
  const res = await post(`${base(root)}/auth/unlock`, { auth: toBase64(auth) });
  const key = await openRootKey(wrap, fromBase64((await res.json()).sealedKey), root);
  // The server said yes to a password its own sealed key doesn't open under.
  if (!key) throw new Error("the server's copy of the key doesn't match, refusing it");
  return { key, auth };
}

export async function unlock(root: string, password: string, salt: string) {
  return padKeys((await rootKey(root, password, salt)).key);
}

/** The same root key, sealed under the new password: no pad changes. */
export async function changePassword(root: string, current: string, next: string, salt: string) {
  const { key, auth } = await rootKey(root, current, salt);
  await post(`${base(root)}/auth/password`, {
    current: toBase64(auth),
    ...(await seal(next, root, key))
  });
}

export const lock = (root: string) => post(`${base(root)}/auth/lock`, {});

/** Marks the root and its pads deleted, and signs every browser out; its password reclaims it. */
export const remove = (root: string) => post(`${base(root)}/auth/delete`, {});

/** Every pad path in the root. */
export async function list(root: string, keys: Keys) {
  const { pads } = (await (await call(`${base(root)}/pads`)).json()) as {
    pads: { id: string; name: string }[];
  };
  return Promise.all(pads.map((p) => openName(keys, p.id, p.name)));
}

export async function load(root: string, keys: Keys, path: string) {
  const id = await padId(keys, path);
  const res = await call(`${base(root)}/pads/${id}`);
  if (res.status === 204) return '';
  return openText(keys, id, new Uint8Array(await res.arrayBuffer()));
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
  const now = Number(res.headers.get('x-updated-at')) || 0;
  if (res.status === 204) return { text: '', version: now };
  return { text: await openText(keys, id, new Uint8Array(await res.arrayBuffer())), version: now };
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

/** An empty pad is deleted. The pad's new version: 0 once deleted. */
export async function save(root: string, keys: Keys, path: string, text: string) {
  const id = await padId(keys, path);
  const url = `${base(root)}/pads/${id}`;
  if (text === '') {
    await call(url, { method: 'DELETE' });
    return 0;
  }
  const res = await call(url, {
    method: 'PUT',
    body: await sealText(keys, id, text),
    headers: {
      'content-type': 'application/octet-stream',
      'x-pad-name': await sealName(keys, id, path)
    }
  });
  return ((await res.json()) as { updatedAt: number }).updatedAt;
}

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

export type Share = { id: string; url: string; createdAt: number };

/** The link's own page, with its key where the server never sees it. */
const shareUrl = (root: string, id: string, key: Uint8Array) =>
  `${location.origin}${base(root)}/s/${id}#${toBase64(key)}`;

/** A read-only link to a copy of the pad and those under it, as they are now. */
export async function share(root: string, keys: Keys, path: string, pads: Pad[], theme: Theme) {
  const id = toBase64(random(16));
  const key = random(32);
  const plain = await deflate(utf8.encode(JSON.stringify({ path, pads, theme } satisfies Shared)));
  const body = await sealShare(key, id, plain);
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
      'x-share-key': toBase64(await sealShareKey(keys, id, key))
    }
  });
  const { createdAt } = await res.json();
  return { id, url: shareUrl(root, id, key), createdAt } satisfies Share;
}

/** The pad's links, oldest first. */
export async function shares(root: string, keys: Keys, path: string) {
  const res = await call(`${base(root)}/pads/${await padId(keys, path)}/shares`);
  const { shares } = (await res.json()) as {
    shares: { id: string; sealedKey: string; createdAt: number }[];
  };
  return Promise.all(
    shares.map(async ({ id, sealedKey, createdAt }) => ({
      id,
      url: shareUrl(root, id, await openShareKey(keys, id, fromBase64(sealedKey))),
      createdAt
    }))
  );
}

export const revoke = (root: string, id: string) =>
  call(`${base(root)}/shares/${id}`, { method: 'DELETE' });

export const revokeAll = async (root: string, keys: Keys, path: string) =>
  call(`${base(root)}/pads/${await padId(keys, path)}/shares`, { method: 'DELETE' });

/** A link's copy, opened with the key from its `#`. */
export async function readShare(root: string, id: string, key: string) {
  const res = await call(`${base(root)}/shares/${id}`);
  const plain = await openShare(fromBase64(key), id, new Uint8Array(await res.arrayBuffer()));
  const shared: Shared = JSON.parse(utf8Decode.decode(await inflate(plain)));
  return {
    ...shared,
    theme: parseTheme(shared.theme),
    createdAt: Number(res.headers.get('x-created-at'))
  };
}
