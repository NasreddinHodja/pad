// Root pads and their passwords.
//
// The first segment of a path is its root: `/a/b/c` belongs to `a`. Whoever
// first saves under a root sets its password, and from then on reading or
// writing anything under it needs that password.
//
// The password never leaves the browser (see `#lib/crypto.ts`). What the
// server gets is `auth`, 32 bytes the browser derives from it with Argon2id,
// and keeps only its SHA-256: auth is as hard to guess as the password is
// through Argon2id, so a slow hash here would add nothing. It also keeps the
// salt, which anyone may have, and the root key sealed under the password,
// which only an unlocked browser gets.
//
// Unlocking gives the browser one opaque token in an HttpOnly cookie; the
// database keeps only its SHA-256, per root it unlocks, so a copy of the file
// opens nothing.
//
// Wrong passwords back off, but only ever on the one who sent them: a browser
// that has unlocked the root before on its own failures, by a device token
// that outlives locking (konigslibrary's), any other on its address's. There
// is no count per root, which anyone could run up to keep everyone else out.

import { dev } from '$app/env';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.ts';
import { purgeRoot } from './trash.ts';

export const SALT_BYTES = 16;
export const AUTH_BYTES = 32;
/** A 32-byte key, AES-GCM's 12-byte nonce and 16-byte tag. */
export const SEALED_KEY_BYTES = 60;

const DAY = 24 * 60 * 60 * 1000;
/** An unlock unused this long, or this old, is over. */
const IDLE = 30 * DAY;
const ABSOLUTE = 180 * DAY;
/** last_seen is written at most this often. */
const TOUCH_EVERY = 60 * 60 * 1000;

// __Host-: only this host, over https, on every path. Dev runs on plain http.
const COOKIE = dev ? 'pad' : '__Host-pad';
const DEVICE_COOKIE = dev ? 'pad-device' : '__Host-pad-device';
/** A device not seen at a root this long is a stranger there again. */
const DEVICE_IDLE = 180 * DAY;

type Root = {
  salt: Uint8Array;
  auth_hash: Uint8Array;
  sealed_key: Uint8Array;
  deleted_at: number | null;
};
const rootStmt = db.query<Root, [string]>(
  'SELECT salt, auth_hash, sealed_key, deleted_at FROM roots WHERE name = ?'
);
const claimStmt = db.query(
  `INSERT OR IGNORE INTO roots (name, salt, auth_hash, sealed_key, created_at)
   VALUES (?, ?, ?, ?, ?)`
);
const setPasswordStmt = db.query(
  'UPDATE roots SET salt = ?, auth_hash = ?, sealed_key = ? WHERE name = ?'
);
const unlockedStmt = db.query<{ last_seen: number }, [Uint8Array, string, number]>(
  `SELECT last_seen FROM unlocks
   WHERE token_hash = ?1 AND root = ?2 AND last_seen > ?3 - ${IDLE} AND created_at > ?3 - ${ABSOLUTE}`
);
const touchStmt = db.query('UPDATE unlocks SET last_seen = ? WHERE token_hash = ? AND root = ?');
const moveStmt = db.query('UPDATE OR REPLACE unlocks SET token_hash = ? WHERE token_hash = ?');
const addStmt = db.query(
  `INSERT OR REPLACE INTO unlocks (token_hash, root, created_at, last_seen) VALUES (?1, ?2, ?3, ?3)`
);
const removeStmt = db.query('DELETE FROM unlocks WHERE token_hash = ? AND root = ?');
const revokeOthersStmt = db.query('DELETE FROM unlocks WHERE root = ? AND token_hash != ?');
const expireStmt = db.query(
  `DELETE FROM unlocks WHERE last_seen <= ?1 - ${IDLE} OR created_at <= ?1 - ${ABSOLUTE}`
);
const deviceStmt = db.query<{ last_seen: number }, [Uint8Array, string, number]>(
  `SELECT last_seen FROM devices WHERE token_hash = ?1 AND root = ?2 AND last_seen > ?3 - ${DEVICE_IDLE}`
);
const rememberStmt = db.query(
  'INSERT OR REPLACE INTO devices (token_hash, root, last_seen) VALUES (?, ?, ?)'
);
const expireDevicesStmt = db.query(`DELETE FROM devices WHERE last_seen <= ? - ${DEVICE_IDLE}`);

export const rootOf = (path: string) => path.split('/')[0];

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest();
const tokenHash = sha256;

/** What the browser needs to turn a password into keys; public. */
export function saltOf(root: string) {
  return rootStmt.get(root)?.salt ?? null;
}

/** Sets the root's password unless someone already has. A deleted root is purged first. */
export const claim = db.transaction(
  (root: string, salt: Uint8Array, auth: Uint8Array, sealedKey: Uint8Array) => {
    if (rootStmt.get(root)?.deleted_at != null) purgeRoot(root);
    return claimStmt.run(root, salt, sha256(auth), sealedKey, Date.now()).changes === 1;
  }
);

/** The sealed root key, if `auth` is the root's. */
export function verify(root: string, auth: Uint8Array) {
  const row = rootStmt.get(root);
  if (!row) return null;
  return timingSafeEqual(sha256(auth), row.auth_hash) ? row.sealed_key : null;
}

/** Signs every other browser out of the root. */
export function setPassword(
  root: string,
  next: { salt: Uint8Array; auth: Uint8Array; sealedKey: Uint8Array },
  keep: Cookies
) {
  db.transaction(() => {
    setPasswordStmt.run(next.salt, sha256(next.auth), next.sealedKey, root);
    revokeOthersStmt.run(root, tokenHash(keep.get(COOKIE) ?? ''));
  })();
}

export type Access = 'open' | 'deleted' | 'unlocked' | 'locked';

/** Open: no one has claimed the root yet. Deleted: claimable, or its password reclaims it. */
export function access(cookies: Cookies, root: string): Access {
  const claimed = rootStmt.get(root);
  if (!claimed) return 'open';
  if (claimed.deleted_at !== null) return 'deleted';
  const token = cookies.get(COOKIE);
  if (!token) return 'locked';
  const now = Date.now();
  const hash = tokenHash(token);
  const row = unlockedStmt.get(hash, root, now);
  if (!row) return 'locked';
  if (now - row.last_seen > TOUCH_EVERY) touchStmt.run(now, hash, root);
  return 'unlocked';
}

/**
 * Unlocks `root` for this browser. The token is new every time, carrying over
 * the roots the old one had, so one planted before the unlock is worth nothing.
 */
export function unlock(cookies: Cookies, root: string) {
  const now = Date.now();
  expireStmt.run(now);
  const token = randomBytes(32).toString('base64url');
  const hash = tokenHash(token);
  const old = cookies.get(COOKIE);
  if (old) moveStmt.run(hash, tokenHash(old));
  addStmt.run(hash, root, now);
  cookies.set(COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: !dev,
    sameSite: 'lax',
    maxAge: ABSOLUTE / 1000
  });
}

/** Whose failures a password attempt counts against: the device's own, if it's been here. */
export function attemptKeys(cookies: Cookies, root: string, address: string) {
  const token = cookies.get(DEVICE_COOKIE);
  if (token) {
    const hash = tokenHash(token);
    if (deviceStmt.get(hash, root, Date.now())) return ['device:' + hash.toString('base64url')];
  }
  return ['ip:' + limitKey(address)];
}

/**
 * The address, or for IPv6 its /64, which one host can have all of; an
 * IPv4-mapped one as the IPv4 address. (konigslibrary's `limit_key`.)
 */
export function limitKey(address: string) {
  const ip = address.replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const groups = (part?: string) => (part ? part.split(':') : []);
  // A trailing IPv4 part fills two groups.
  const count = (part: string[]) => part.length + (part.at(-1)?.includes('.') ? 1 : 0);
  const h = groups(head);
  const t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(8 - count(h) - count(t)).fill('0'), ...t];
  return (
    all
      .slice(0, 4)
      .map((g) => parseInt(g, 16).toString(16))
      .join(':') + '::/64'
  );
}

/** Marks this browser as one that has unlocked `root`. */
export function rememberDevice(cookies: Cookies, root: string) {
  const now = Date.now();
  expireDevicesStmt.run(now);
  const token = cookies.get(DEVICE_COOKIE) ?? randomBytes(32).toString('base64url');
  rememberStmt.run(tokenHash(token), root, now);
  cookies.set(DEVICE_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: !dev,
    sameSite: 'lax',
    maxAge: DEVICE_IDLE / 1000
  });
}

/** Forgets `root` on this browser. */
export function lock(cookies: Cookies, root: string) {
  const token = cookies.get(COOKIE);
  if (token) removeStmt.run(tokenHash(token), root);
}

/**
 * Whether a write carrying our cookie was sent by our own page. SameSite
 * keeps other sites' requests from carrying it, but not other nassu.online
 * subdomains': they're the same site. `Sec-Fetch-Site` is set by the browser;
 * browsers too old to send it are judged by `Origin`.
 */
export function sameOrigin({ request, url }: RequestEvent) {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  return request.headers.get('origin') === url.origin;
}

// Failed unlocks back off, per device or per address, as konigslibrary's do: a
// few free, then a wait that doubles up to 15 minutes. In memory: a restart
// forgets the counts, which costs an attacker a restart they can't cause.
const FREE = 5;
const MAX_WAIT = 15 * 60 * 1000;
const MAX_ENTRIES = 10_000;
const FORGET_AFTER = 60 * 60 * 1000;
const failures = new Map<string, { count: number; until: number; last: number }>();

/** Milliseconds `keys` must still wait before another try, if any. */
export function owedWait(keys: string[]) {
  const now = Date.now();
  const until = Math.max(0, ...keys.map((k) => failures.get(k)?.until ?? 0));
  return until > now ? until - now : 0;
}

export function failed(keys: string[]) {
  const now = Date.now();
  for (const key of keys) {
    if (failures.size >= MAX_ENTRIES && !failures.has(key)) {
      for (const [k, e] of failures) if (now - e.last > FORGET_AFTER) failures.delete(k);
      // A flood of fresh keys: dropping them all only frees their own counts.
      if (failures.size >= MAX_ENTRIES) failures.clear();
    }
    const entry = failures.get(key) ?? { count: 0, until: now, last: now };
    entry.count++;
    entry.until =
      entry.count < FREE
        ? now
        : now + Math.min(1000 * 2 ** Math.min(entry.count - FREE, 20), MAX_WAIT);
    entry.last = now;
    failures.set(key, entry);
  }
}

export function succeeded(keys: string[]) {
  for (const key of keys) failures.delete(key);
}
