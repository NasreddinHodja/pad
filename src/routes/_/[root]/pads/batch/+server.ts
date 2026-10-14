import { error } from '@sveltejs/kit';
import { BATCH_PADS } from '#lib/limits.ts';
import { body, ours, padIdParam, rootParam, unlocked } from '#lib/server/api.ts';
import { getSealed } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

// Many pads in one response, for export and a link's copy: each sealed pad
// after its length (4 bytes, little-endian), in the order asked; 0 for one
// that doesn't exist. A POST for its list of ids, so same-origin only.
//
// Read a pad at a time, as the client takes them: built whole, a root's 16
// MiB sat in memory for as long as a client left it unread
// (docs/architecture/capacity.org). Each pad is as it is when it's read.
export const POST: RequestHandler = async (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const { ids } = await body(event.request);
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BATCH_PADS)
    error(400, `ask for 1 to ${BATCH_PADS} pads`);
  // Each once: a pad asked for 100 times was 100 copies of it in one response.
  if (new Set(ids).size !== ids.length) error(400, 'ask for each pad once');
  const checked = ids.map((id) => padIdParam(typeof id === 'string' ? id : ''));
  let next = 0;
  const pads = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (next === checked.length) return controller.close();
        const data = getSealed(root, checked[next++])?.data;
        const out = new Uint8Array(4 + (data?.length ?? 0));
        new DataView(out.buffer).setUint32(0, data?.length ?? 0, true);
        if (data) out.set(data, 4);
        controller.enqueue(out);
      }
    },
    // Nothing read ahead of the client.
    { highWaterMark: 0 }
  );
  return new Response(pads, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
  });
};
