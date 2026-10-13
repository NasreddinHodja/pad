import { error, json } from '@sveltejs/kit';
import {
  allowGrowth,
  bytes,
  notCrossSite,
  ours,
  padIdParam,
  readCapped,
  rootParam,
  shareIdParam,
  unlocked
} from '#lib/server/api.ts';
import { SEALED_KEY_BYTES } from '#lib/server/auth.ts';
import { LINK_LIFETIMES, MAX_SHARE } from '#lib/limits.ts';
import { MAX_SHARES, meterOpen, meterWrite } from '#lib/server/limits.ts';
import { addShare, getShare, removeShare, takeShare } from '#lib/server/shares.ts';
import { deletedAt } from '#lib/server/trash.ts';
import type { RequestHandler } from './$types';

// A read-only link's copy, for anyone with the link: without the key after
// its `#` it's noise.
// A deleted root's links are quiet until it's reclaimed. One that opens once
// is 409 until asked for with `x-open: once`, which deletes it: a script
// that loads the page, as some link previews run, doesn't spend it.
export const GET: RequestHandler = (event) => {
  notCrossSite(event);
  const root = rootParam(event.params.root);
  const id = shareIdParam(event.params.share);
  let row = deletedAt(root) === null ? getShare(root, id) : null;
  // Before it's taken: a refusal mustn't spend it.
  meterOpen(event, row?.data.length);
  if (row?.once) {
    if (event.request.headers.get('x-open') !== 'once') error(409, 'this link opens once');
    row = takeShare(root, id);
  }
  if (!row) error(404, 'this link expired, was revoked, or never was');
  return new Response(new Uint8Array(row.data), {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-created-at': String(row.created_at)
    }
  });
};

// A new link: the sealed copy as the body; the pad's id, the link's key
// sealed under the root's, and how long it lasts or whether it opens once in
// headers. A key from before links had a password is 32 bytes, now 33.
export const PUT: RequestHandler = async (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const id = shareIdParam(event.params.share);
  const pad = padIdParam(event.request.headers.get('x-pad-id') ?? '');
  const sealedKey = shareKey(event.request.headers.get('x-share-key'));
  const made = { lifetime: lifetime(event.request.headers.get('x-expires-in')), once: false };
  const once = event.request.headers.get('x-once');
  if (once !== null && once !== '1') error(400, 'x-once is 1 or absent');
  made.once = once === '1';
  const data = await readCapped(event.request, MAX_SHARE, 'the link is over 1 MiB');
  meterWrite(event, root, data.length);
  allowGrowth(event, root, data.length);
  const added = addShare(root, id, pad, sealedKey, data, made);
  if (added === 'full') error(409, `/${root} has ${MAX_SHARES} links, revoke some first`);
  if (added === 'taken') error(409, 'that link id is taken, try again');
  return json({ createdAt: added });
};

function shareKey(value: string | null) {
  const length = value === null ? 0 : Buffer.from(value, 'base64url').length;
  return bytes(value, length === SEALED_KEY_BYTES ? SEALED_KEY_BYTES : SEALED_KEY_BYTES + 1);
}

/** Milliseconds, one of LINK_LIFETIMES; null, absent: never expires. */
function lifetime(value: string | null) {
  if (value === null) return null;
  const ms = Number(value);
  if (!(Object.values(LINK_LIFETIMES) as number[]).includes(ms))
    error(400, `a link lasts one of ${Object.keys(LINK_LIFETIMES).join(', ')}, or never expires`);
  return ms;
}

export const DELETE: RequestHandler = (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  meterWrite(event, root);
  removeShare(root, shareIdParam(event.params.share));
  return new Response(null, { status: 204 });
};
