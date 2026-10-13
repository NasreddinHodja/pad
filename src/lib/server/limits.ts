// Every limit the server keeps, in one place; the ones an operator can change
// come from config.ts. Why each number is what it is:
// docs/architecture/capacity.org.
//
// Only claiming, unlocking, locking and reading a link are open to anyone;
// everything else needs the root's password. So: what fills the disk is
// capped by quotas (per root, per address per day, per server), what keeps
// the one database writer busy is metered per root, and what anyone can send
// is metered per address. A flood of plain requests is the proxy's to stop
// (docs/guide/install.org).

import { error, type RequestEvent } from '@sveltejs/kit';
import { MAX_DEPTH, MAX_PATH, MAX_SEGMENT, normalizePath } from '../limits.ts';
import { address } from './address.ts';
import { config, type Bucket } from './config.ts';

export { MAX_DEPTH, MAX_PATH, MAX_SEGMENT, normalizePath };

const MiB = 1024 * 1024;

export const MAX_BYTES = config.padBytes;
/** A pad's text once sealed: AES-GCM adds a 12-byte nonce and a 16-byte tag. */
export const MAX_SEALED = MAX_BYTES + 28;
/** A sealed path, in base64: 255 characters of up to 4 bytes, sealed. */
export const MAX_SEALED_NAME = 1400;
/** `{"bg":"#rrggbb","fg":"#rrggbb","ink":"#rrggbb"}` is 45 bytes; sealed, 73. */
export const MAX_THEME = 256;
export const MAX_SHARES = config.linksPerRoot;

export const SERVER_BYTES = config.serverBytes;
/**
 * Room above SERVER_BYTES for unlocks, devices and roots, so a full server
 * still lets people in. SQLite refuses any write past it (db.ts).
 */
export const SERVER_SLACK = 64 * MiB;
export const ROOT_BYTES = config.rootBytes;
export const ROOT_PADS = config.rootPads;

/**
 * Most keys a meter remembers, about 400 bytes each; past it, the least
 * recently seen is forgotten.
 */
const MAX_KEYS = 20_000;

/** A Map that forgets its least recently used key past `max`. */
export function lru<V>(max = MAX_KEYS) {
  const map = new Map<string, V>();
  return {
    get(key: string) {
      const value = map.get(key);
      if (value !== undefined) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key: string, value: V) {
      map.delete(key);
      map.set(key, value);
      if (map.size > max) map.delete(map.keys().next().value!);
    },
    delete: (key: string) => map.delete(key),
    get size() {
      return map.size;
    }
  };
}

/**
 * A token bucket per key: `burst` to start with, refilled at `perSecond`;
 * each request costs its bytes, never less than `floor`, so a flood of empty
 * requests costs too.
 */
export function meter({ burst, perSecond, floor }: Bucket, max = MAX_KEYS) {
  const buckets = lru<{ tokens: number; at: number }>(max);
  return {
    /** Takes `bytes` from `key`'s bucket; if it hasn't enough, takes nothing and gives the wait in ms. */
    take(key: string, bytes: number, now = Date.now()) {
      const cost = Math.max(bytes, floor);
      const b = buckets.get(key) ?? { tokens: burst, at: now };
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
      b.at = now;
      buckets.set(key, b);
      if (cost > burst) return Infinity;
      if (b.tokens < cost) return Math.ceil(((cost - b.tokens) / perSecond) * 1000);
      b.tokens -= cost;
      return 0;
    }
  };
}

export const WRITES: Bucket = config.writes;
export const OPEN: Bucket = config.open;
export const GROWTH: Bucket = config.growth;
export const REQUESTS: Bucket = config.requests;

const writes = meter(WRITES);
const open = meter(OPEN);
const growth = meter(GROWTH);
const requests = meter(REQUESTS);

/** 429 with a Retry-After, if `wait` ms is owed. */
function refuse(event: RequestEvent, wait: number, message: string) {
  if (!wait) return;
  if (wait === Infinity) error(413, message);
  const seconds = Math.ceil(wait / 1000);
  event.setHeaders({ 'retry-after': String(seconds) });
  error(429, `${message}, wait ${seconds}s`);
}

/** Seconds the request's address must wait before another request, or 0. */
export function requestWait(event: RequestEvent) {
  return Math.ceil(requests.take(limitKey(address(event)), 1) / 1000);
}

/** Meters a write to `root`. */
export function meterWrite(event: RequestEvent, root: string, bytes = 0) {
  refuse(event, writes.take(root, bytes), `/${root} is writing too fast`);
}

/** Meters a request anyone may send. */
export function meterOpen(event: RequestEvent, bytes = 0) {
  refuse(event, open.take(limitKey(address(event)), bytes), 'too many requests');
}

/** Meters `bytes` of new data from the request's address. */
export function meterGrowth(event: RequestEvent, bytes: number) {
  if (bytes <= 0) return;
  const key = limitKey(address(event));
  refuse(event, growth.take(key, bytes), 'this address has written too much today');
}

// Failed password attempts back off, per device or per address (auth.ts's
// attemptKeys): a few free, then a wait that doubles up to BACKOFF_MAX. In
// memory: a restart forgets the counts, which costs an attacker a restart
// they can't cause.
export const BACKOFF_FREE = config.backoff.free;
export const BACKOFF_MAX = config.backoff.maxWait;
const failures = lru<{ count: number; until: number }>();

/** Milliseconds `keys` must still wait before another try, if any. */
export function owedWait(keys: string[]) {
  const now = Date.now();
  const until = Math.max(0, ...keys.map((k) => failures.get(k)?.until ?? 0));
  return until > now ? until - now : 0;
}

export function failed(keys: string[]) {
  const now = Date.now();
  for (const key of keys) {
    const entry = failures.get(key) ?? { count: 0, until: now };
    entry.count++;
    entry.until =
      entry.count < BACKOFF_FREE
        ? now
        : now + Math.min(1000 * 2 ** Math.min(entry.count - BACKOFF_FREE, 20), BACKOFF_MAX);
    failures.set(key, entry);
  }
}

export function succeeded(keys: string[]) {
  for (const key of keys) failures.delete(key);
}

/**
 * The address, or for IPv6 its /64, which one host can have all of; an
 * IPv4-mapped one as the IPv4 address.
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
