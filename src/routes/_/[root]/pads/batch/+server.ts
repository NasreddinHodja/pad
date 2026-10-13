import { error } from '@sveltejs/kit';
import { BATCH_PADS } from '#lib/limits.ts';
import { body, ours, padIdParam, rootParam, unlocked } from '#lib/server/api.ts';
import { getSealed } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

// Many pads in one response, for export and a link's copy: each sealed pad
// after its length (4 bytes, little-endian), in the order asked; 0 for one
// that doesn't exist. A POST for its list of ids, so same-origin only.
export const POST: RequestHandler = async (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const { ids } = await body(event.request);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BATCH_PADS)
    error(400, `ask for 1 to ${BATCH_PADS} pads`);
  const pads = ids.map((id) => getSealed(root, padIdParam(typeof id === 'string' ? id : ''))?.data);
  const out = new Uint8Array(pads.reduce((n, p) => n + 4 + (p?.length ?? 0), 0));
  const view = new DataView(out.buffer);
  let at = 0;
  for (const p of pads) {
    view.setUint32(at, p?.length ?? 0, true);
    if (p) out.set(p, at + 4);
    at += 4 + (p?.length ?? 0);
  }
  return new Response(out, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
  });
};
