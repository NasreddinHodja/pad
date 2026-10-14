// The limits an operator can change, from the JSON file PAD_CONFIG names.
// Keys are GET /_/limits's: sizes in bytes, times in milliseconds. A key left
// out keeps its default; an unknown key or a bad value stops the server, so a
// typo isn't a limit silently left as it was. Why each default is what it is:
// docs/architecture/capacity.org.

import { readFileSync } from 'node:fs';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;
const DAY = 24 * 60 * 60 * 1000;

export type Bucket = { burst: number; perSecond: number; floor: number };

export const DEFAULTS = {
  /** A pad's text, before encryption. */
  padBytes: 512 * KiB,
  /** Links a root can have at once. Their bytes count toward rootBytes. */
  linksPerRoot: 1000,
  /** The database's size past which no pad or link grows. */
  serverBytes: 5 * GiB,
  /** A root's pads (sealed text and path) and links. */
  rootBytes: 16 * MiB,
  /** A root's pads, emptied ones too: the list returns at most this many. */
  rootPads: 5000,
  /** Writes to a root, by anyone unlocked there. */
  writes: { burst: 16 * MiB, perSecond: 1 * MiB, floor: 16 * KiB } as Bucket,
  /** What anyone may do without a password: claim, unlock, lock, read a link. */
  open: { burst: 16 * MiB, perSecond: 1 * MiB, floor: 16 * KiB } as Bucket,
  /**
   * New bytes an address adds to pads and links, across every root: 1 GiB a
   * day, but at most 64 MiB at once, or a few fresh addresses could fill the
   * server in seconds.
   */
  growth: { burst: 64 * MiB, perSecond: GiB / (DAY / 1000), floor: 0 } as Bucket,
  /**
   * Every request an address sends, counted not weighed. A tab polls 0.2 a
   * second and saves at most 1.7, so 200 is a thousand people's; the VPS takes
   * about 1,900 a second, so one address can't take it alone. 5000 at once
   * lets an export read a full root.
   */
  requests: { burst: 5000, perSecond: 200, floor: 1 } as Bucket,
  /** Wrong passwords: `free` tries, then a wait that doubles up to `maxWait`. */
  backoff: { free: 5, maxWait: 15 * 60 * 1000 },
  /** How long an emptied pad or a deleted root waits before it's purged. */
  grace: 30 * DAY,
  /**
   * How long a root may go without an unlock before it's deleted, as its
   * owner would (then purged after `grace`). 0: never.
   */
  retention: 0,
  /** Earlier texts kept of each pad, the oldest dropped past it. 0: none. */
  versions: 10,
  /**
   * A save keeps the text it overwrites once the newest kept is this old: one
   * every 10 minutes of typing, and the last before a pause.
   */
  versionGap: 10 * 60 * 1000
};

export type Config = typeof DEFAULTS;

/** Counts, not sizes or times: whole numbers. */
const WHOLE = new Set(['linksPerRoot', 'rootPads', 'requests.burst', 'backoff.free', 'versions']);
/** Divided by, or a cap nothing fits under: more than 0. */
const POSITIVE = new Set([
  'padBytes',
  'rootBytes',
  'rootPads',
  'serverBytes',
  'perSecond',
  'burst'
]);

/** DEFAULTS with `text`'s values over them. Throws on anything it can't take. */
export function parseConfig(text: string): Config {
  const fail = (why: string): never => {
    throw new Error(`PAD_CONFIG: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    fail(`not JSON (${(e as Error).message})`);
  }
  const merge = (defaults: Record<string, unknown>, given: unknown, at: string) => {
    if (typeof given !== 'object' || given === null || Array.isArray(given))
      fail(`${at || 'the file'} must be an object`);
    const out: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(given as object)) {
      const path = at ? `${at}.${key}` : key;
      if (!(key in defaults)) fail(`unknown key ${path}`);
      if (typeof defaults[key] === 'object') {
        out[key] = merge(defaults[key] as Record<string, unknown>, value, path);
        continue;
      }
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        fail(`${path} must be a number, 0 or more`);
      if (WHOLE.has(path) && !Number.isInteger(value)) fail(`${path} must be a whole number`);
      if ((POSITIVE.has(path) || POSITIVE.has(key)) && value === 0)
        fail(`${path} must be more than 0`);
      out[key] = value;
    }
    return out;
  };
  return merge(DEFAULTS, raw, '') as Config;
}

const file = process.env.PAD_CONFIG;
export const config = file ? parseConfig(readFileSync(file, 'utf8')) : DEFAULTS;
