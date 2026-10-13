import { error, json } from '@sveltejs/kit';
import { allowGrowth, ours, padIdParam, readCapped, rootParam, unlocked } from '#lib/server/api.ts';
import { getSealed, padSize, padVersion, putSealed } from '#lib/server/db.ts';
import { MAX_SEALED, MAX_SEALED_NAME, meterWrite } from '#lib/server/limits.ts';
import { markPad } from '#lib/server/trash.ts';
import type { RequestEvent, RequestHandler } from './$types';

function target(event: RequestEvent) {
  const root = rootParam(event.params.root);
  unlocked(event, root);
  return { root, id: padIdParam(event.params.id) };
}

// A write names the version it was made over (If-Match, as the GET's ETag),
// and is refused over any other: a browser that missed a write can't drop it.
function current(event: RequestEvent, root: string, id: string) {
  const over = event.request.headers.get('if-match');
  if (over === null) error(428, 'say which version this was made over');
  if (over !== `"${padVersion(root, id)}"`) error(412, 'changed elsewhere');
}

// The pad's version (its last write's time) is its ETag: the editor's poll
// sends the one it has, and gets 304 and no body while it's current.
export const GET: RequestHandler = (event) => {
  const { root, id } = target(event);
  const known = event.request.headers.get('if-none-match');
  if (known !== null && known === `"${padVersion(root, id)}"`)
    return new Response(null, {
      status: 304,
      headers: { etag: known, 'cache-control': 'no-store' }
    });
  const row = getSealed(root, id);
  const version = row?.updated_at ?? 0;
  return new Response(row ? new Uint8Array(row.data) : null, {
    status: row ? 200 : 204,
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      etag: `"${version}"`,
      'x-updated-at': String(version)
    }
  });
};

// The editor's autosave: the sealed text as the body, the sealed path in a
// header. Nothing awaits between the version's check and the write.
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
  current(event, root, id);
  return json({ updatedAt: putSealed(root, id, name, data) });
};

// An emptied pad: marked, and purged in 30 days unless it's saved again.
export const DELETE: RequestHandler = (event) => {
  ours(event);
  const { root, id } = target(event);
  meterWrite(event, root);
  current(event, root, id);
  markPad(root, id);
  return new Response(null, { status: 204 });
};
