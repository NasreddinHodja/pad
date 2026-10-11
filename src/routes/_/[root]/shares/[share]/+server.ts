import { error, json } from '@sveltejs/kit';
import {
  allowGrowth,
  bytes,
  ours,
  padIdParam,
  readCapped,
  rootParam,
  shareIdParam,
  unlocked
} from '#lib/server/api.ts';
import { SEALED_KEY_BYTES } from '#lib/server/auth.ts';
import { MAX_SHARE } from '#lib/limits.ts';
import { MAX_SHARES, meterOpen, meterWrite } from '#lib/server/limits.ts';
import { addShare, getShare, removeShare } from '#lib/server/shares.ts';
import { deletedAt } from '#lib/server/trash.ts';
import type { RequestHandler } from './$types';

// A read-only link's copy, for anyone with the link: without the key after
// its `#` it's noise.
// A deleted root's links are quiet until it's reclaimed.
export const GET: RequestHandler = (event) => {
  const root = rootParam(event.params.root);
  const row = deletedAt(root) === null ? getShare(root, shareIdParam(event.params.share)) : null;
  meterOpen(event, row?.data.length);
  if (!row) error(404, 'this link was revoked, or never was');
  return new Response(new Uint8Array(row.data), {
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-created-at': String(row.created_at)
    }
  });
};

// A new link: the sealed copy as the body, the pad's id and the link's key
// sealed under the root's in headers.
export const PUT: RequestHandler = async (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const id = shareIdParam(event.params.share);
  const pad = padIdParam(event.request.headers.get('x-pad-id') ?? '');
  const sealedKey = bytes(event.request.headers.get('x-share-key'), SEALED_KEY_BYTES);
  const data = await readCapped(event.request, MAX_SHARE, 'the link is over 1 MiB');
  meterWrite(event, root, data.length);
  allowGrowth(event, root, data.length);
  const made = addShare(root, id, pad, sealedKey, data);
  if (made === 'full') error(409, `/${root} has ${MAX_SHARES} links, revoke some first`);
  if (made === 'taken') error(409, 'that link id is taken, try again');
  return json({ createdAt: made });
};

export const DELETE: RequestHandler = (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  meterWrite(event, root);
  removeShare(root, shareIdParam(event.params.share));
  return new Response(null, { status: 204 });
};
