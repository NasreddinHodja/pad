// Limits the browser and the server both keep.

/** A read-only link's copy, deflated and sealed: the server takes bodies of 1 MiB. */
export const MAX_SHARE = 1024 * 1024;

const HOUR = 60 * 60 * 1000;
/** How long a new link may last, in milliseconds: the dialog offers these, the server takes no other. */
export const LINK_LIFETIMES = {
  '1 hour': HOUR,
  '1 day': 24 * HOUR,
  '1 week': 7 * 24 * HOUR,
  '1 month': 30 * 24 * HOUR,
  '1 year': 365 * 24 * HOUR
} as const;

export const MAX_PATH = 255;
export const MAX_SEGMENT = 64;
export const MAX_DEPTH = 10;

/**
 * How names are compared: `Notes` and `notes`, or a composed `é` and a
 * decomposed one, are one name, so no one can claim a root that looks like
 * another's that way. A lookalike from another script (a Cyrillic `о`) is
 * still another name.
 */
export const canonical = (name: string) => name.toLowerCase().normalize('NFC');

/** `a//B/` → `a/b`. Null if it can't be a pad. */
export function normalizePath(raw: string): string | null {
  const segments = canonical(raw)
    .split('/')
    .filter((s) => s !== '');
  // `/_/…` is the API's.
  if (segments[0] === '_') return null;
  const path = segments.join('/');
  if (path.length > MAX_PATH || segments.length > MAX_DEPTH) return null;
  for (const s of segments) {
    // eslint-disable-next-line no-control-regex
    if (s.length > MAX_SEGMENT || s === '.' || s === '..' || /[\u0000-\u001f\u007f]/.test(s))
      return null;
  }
  return path;
}

/** Pads one batch read returns (export, a link's copy): a root of 5000 is 50 requests. */
export const BATCH_PADS = 100;

/** Argon2id's cost: memory in KiB, passes, lanes. */
export type Argon2 = { memory: number; iterations: number; parallelism: number };

/** What a new password is derived with. Raising it leaves older roots on theirs. */
export const ARGON2: Argon2 = { memory: 19 * 1024, iterations: 2, parallelism: 1 };

// The browser refuses anything outside these from the server, and the server
// from a browser: below the floor (OWASP's minimum), a copy of the database is
// cheap to guess against; above the ceiling, the tab hangs. 256 MiB at 8
// passes is about 2 s on the author's laptop (hash-wasm, 0.6 s at 2 passes).
const FLOOR: Argon2 = ARGON2;
const CEILING: Argon2 = { memory: 256 * 1024, iterations: 8, parallelism: 4 };

/** `value` if it's an Argon2 cost within bounds, else null. */
export function argon2(value: unknown): Argon2 | null {
  if (!value || typeof value !== 'object') return null;
  const cost = value as Record<string, unknown>;
  for (const key of ['memory', 'iterations', 'parallelism'] as const) {
    const n = cost[key];
    if (!Number.isInteger(n) || (n as number) < FLOOR[key] || (n as number) > CEILING[key])
      return null;
  }
  const { memory, iterations, parallelism } = cost as Argon2;
  return { memory, iterations, parallelism };
}
