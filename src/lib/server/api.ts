import { error, type RequestEvent } from '@sveltejs/kit';
import { access, sameOrigin } from './auth.ts';
import { full, usage } from './db.ts';
import { meterGrowth, normalizePath, ROOT_BYTES, ROOT_PADS } from './limits.ts';

/** The `[root]` param, if it names a root. */
export function rootParam(raw: string) {
  const root = normalizePath(raw);
  if (!root || root.includes('/')) error(400, 'not a valid root');
  return root;
}

/** For every request that changes something: only our own page may send it. */
export function ours(event: RequestEvent) {
  if (!sameOrigin(event)) error(403, 'cross-site request refused');
}

/**
 * For every read: another site's request is refused, a same-site one too
 * (another nassu.online subdomain sends the cookie, SameSite being per
 * domain). Without Sec-Fetch-Site it passes: curl sends none, and a browser
 * too old to send it still has CORP and the cookie's SameSite.
 */
export function notCrossSite({ request }: RequestEvent) {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'none')
    error(403, 'cross-site request refused');
}

export function unlocked(event: RequestEvent, root: string) {
  if (access(event.cookies, root) !== 'unlocked') error(401, `/${root} is locked`);
}

/** Base64url (no padding) of exactly `length` bytes. */
export function bytes(value: unknown, length: number) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) error(400, 'malformed body');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== length) error(400, 'malformed body');
  return new Uint8Array(decoded);
}

export async function body(request: Request) {
  const json = await request.json().catch(() => null);
  if (!json || typeof json !== 'object') error(400, 'malformed body');
  return json as Record<string, unknown>;
}

/** The body's bytes, refused past `cap` even if content-length is missing or lies. */
export async function readCapped(request: Request, cap: number, tooBigMessage: string) {
  const tooBig = () => error(413, tooBigMessage);
  if (Number(request.headers.get('content-length') ?? 0) > cap) tooBig();
  if (!request.body) error(400, 'empty body');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > cap) tooBig();
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * Refuses a write adding `bytes` and `pads` to `root` if the server is full,
 * the root would pass its quota, or the address has written its day's worth.
 * A write that adds nothing always passes, so a full root can still be edited
 * down.
 */
export function allowGrowth(event: RequestEvent, root: string, bytes: number, pads = 0) {
  if (bytes <= 0 && pads <= 0) return;
  if (full()) error(507, 'this server is full');
  const used = usage(root);
  // Emptied pads count until they're purged: their rows are still there.
  if (used.pads + pads > ROOT_PADS)
    error(413, `/${root} has ${ROOT_PADS} pads, emptied ones included until they're purged`);
  // Kept versions give way instead: db.ts, fit.
  if (used.bytes - used.history + bytes > ROOT_BYTES)
    error(413, `/${root} is at its ${ROOT_BYTES / 1024 / 1024} MiB`);
  meterGrowth(event, bytes);
}

/** A pad's id is the base64url of its 32-byte HMAC. */
export function padIdParam(raw: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) error(400, 'not a valid pad id');
  return raw;
}

/** A read-only link's id: 16 random bytes, base64url. */
export function shareIdParam(raw: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(raw)) error(400, 'not a valid link');
  return raw;
}
