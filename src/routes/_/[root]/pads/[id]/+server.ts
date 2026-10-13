import { error, json } from '@sveltejs/kit';
import { allowGrowth, ours, padIdParam, readCapped, rootParam, unlocked } from '#lib/server/api.ts';
import { getSealed, padSize, padVersion, putSealed } from '#lib/server/db.ts';
import { MAX_BYTES, MAX_SEALED, MAX_SEALED_NAME, meterWrite } from '#lib/server/limits.ts';
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
      etag: `"${version}"`
    }
  });
};

// The editor's autosave: the sealed text as the body, and the sealed path in
// a header when the pad is new or emptied; a pad that has one keeps it.
// Nothing awaits between the version's check and the write.
export const PUT: RequestHandler = async (event) => {
  ours(event);
  const { root, id } = target(event);
  const name = event.request.headers.get('x-pad-name');
  if (name !== null && (!/^[A-Za-z0-9_-]+$/.test(name) || name.length > MAX_SEALED_NAME))
    error(400, 'malformed pad name');
  const data = await readCapped(event.request, MAX_SEALED, `pad is over ${MAX_BYTES / 1024} KiB`);
  const before = padSize(root, id);
  const size = data.length + (name?.length ?? before?.name ?? 0);
  meterWrite(event, root, size);
  allowGrowth(event, root, size - (before?.total ?? 0), before === null ? 1 : 0);
  current(event, root, id);
  // Past the version's check: a stale browser gets 412, not this.
  if (name === null && padVersion(root, id) === 0) error(400, 'a new pad needs its name');
  return json({ updatedAt: putSealed(root, id, name, data) });
};

// An emptied pad: its text and name go now, its row in 30 days unless it's
// saved again.
export const DELETE: RequestHandler = (event) => {
  ours(event);
  const { root, id } = target(event);
  meterWrite(event, root);
  current(event, root, id);
  markPad(root, id);
  return new Response(null, { status: 204 });
};
