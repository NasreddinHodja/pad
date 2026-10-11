// Every limit the server keeps, in one place. Why each number is what it is:
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

export { MAX_DEPTH, MAX_PATH, MAX_SEGMENT, normalizePath };

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const DAY = 24 * 60 * 60 * 1000;

export const MAX_BYTES = 512 * KiB;
/** A pad's text once sealed: AES-GCM adds a 12-byte nonce and a 16-byte tag. */
export const MAX_SEALED = MAX_BYTES + 28;
/** A sealed path, in base64: 255 characters of up to 4 bytes, sealed. */
export const MAX_SEALED_NAME = 1400;
/** `{"bg":"#rrggbb","fg":"#rrggbb","ink":"#rrggbb"}` is 45 bytes; sealed, 73. */
export const MAX_THEME = 256;
/** Links a root can have at once. Their bytes count toward ROOT_BYTES. */
export const MAX_SHARES = 1000;

/** The database's size past which no pad or link grows. */
export const SERVER_BYTES = 5 * GiB;
/**
 * Room above SERVER_BYTES for unlocks, devices and roots, so a full server
 * still lets people in. SQLite refuses any write past it (db.ts).
 */
export const SERVER_SLACK = 64 * MiB;
/** A root's pads (sealed text and path, emptied ones too until purged) and links. */
export const ROOT_BYTES = 16 * MiB;
/** A root's pads, emptied ones too: the list (db.ts) returns at most this many. */
export const ROOT_PADS = 5000;

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

type Bucket = { burst: number; perSecond: number; floor: number };

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

/** Writes to a root, by anyone unlocked there. */
export const WRITES: Bucket = { burst: 16 * MiB, perSecond: 1 * MiB, floor: 16 * KiB };
/** What anyone may do without a password: claim, unlock, lock, read a link. */
export const OPEN: Bucket = { burst: 16 * MiB, perSecond: 1 * MiB, floor: 16 * KiB };
/**
 * New bytes an address adds to pads and links, across every root: 1 GiB a
 * day, but at most 64 MiB at once, or a few fresh addresses could fill the
 * server in seconds.
 */
export const GROWTH: Bucket = { burst: 64 * MiB, perSecond: GiB / (DAY / 1000), floor: 0 };

/**
 * Every request an address sends, counted not weighed. A tab polls 0.2 a
 * second and saves at most 1.7, so 200 is a thousand people's; the VPS takes
 * about 1,900 a second, so one address can't take it alone. 5000 at once
 * lets an export read a full root.
 */
export const REQUESTS: Bucket = { burst: 5000, perSecond: 200, floor: 1 };

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
export function requestWait(address: string) {
  return Math.ceil(requests.take(limitKey(address), 1) / 1000);
}

/** Meters a write to `root`. */
export function meterWrite(event: RequestEvent, root: string, bytes = 0) {
  refuse(event, writes.take(root, bytes), `/${root} is writing too fast`);
}

/** Meters a request anyone may send. */
export function meterOpen(event: RequestEvent, bytes = 0) {
  refuse(event, open.take(limitKey(event.getClientAddress()), bytes), 'too many requests');
}

/** Meters `bytes` of new data from the request's address. */
export function meterGrowth(event: RequestEvent, bytes: number) {
  if (bytes <= 0) return;
  const key = limitKey(event.getClientAddress());
  refuse(event, growth.take(key, bytes), 'this address has written too much today');
}

// Failed password attempts back off, per device or per address (auth.ts's
// attemptKeys): a few free, then a wait that doubles up to 15 minutes. In
// memory: a restart forgets the counts, which costs an attacker a restart
// they can't cause.
export const BACKOFF_FREE = 5;
export const BACKOFF_MAX = 15 * 60 * 1000;
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
