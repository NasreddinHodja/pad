import { error, json } from '@sveltejs/kit';
import { allowGrowth, ours, padIdParam, readCapped, rootParam, unlocked } from '#lib/server/api.ts';
import { getSealed, padSize, putSealed } from '#lib/server/db.ts';
import { MAX_SEALED, MAX_SEALED_NAME, meterWrite } from '#lib/server/limits.ts';
import { markPad } from '#lib/server/trash.ts';
import type { RequestEvent, RequestHandler } from './$types';

function target(event: RequestEvent) {
  const root = rootParam(event.params.root);
  unlocked(event, root);
  return { root, id: padIdParam(event.params.id) };
}

export const GET: RequestHandler = (event) => {
  const { root, id } = target(event);
  const row = getSealed(root, id);
  return new Response(row ? new Uint8Array(row.data) : null, {
    status: row ? 200 : 204,
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-updated-at': String(row?.updated_at ?? 0)
    }
  });
};

// The editor's autosave: the sealed text as the body, the sealed path in a
// header.
export const PUT: RequestHandler = async (event) => {
  ours(event);
  const { root, id } = target(event);
  const name = event.request.headers.get('x-pad-name') ?? '';
  if (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > MAX_SEALED_NAME)
    error(400, 'malformed pad name');
  const data = await readCapped(event.request, MAX_SEALED, 'pad is over 512 KiB');
  const size = data.length + name.length;
  meterWrite(event, root, size);
  const before = padSize(root, id);
  allowGrowth(event, root, size - (before ?? 0), before === null ? 1 : 0);
  return json({ updatedAt: putSealed(root, id, name, data) });
};

// An emptied pad: marked, and purged in 30 days unless it's saved again.
export const DELETE: RequestHandler = (event) => {
  ours(event);
  const { root, id } = target(event);
  meterWrite(event, root);
  markPad(root, id);
  return new Response(null, { status: 204 });
};
