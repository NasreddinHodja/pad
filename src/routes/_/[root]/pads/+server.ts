import { notCrossSite, rootParam, unlocked } from '#lib/server/api.ts';
import { listSealed } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

// Every pad of the root, sealed, for the browser to list. Its ETag is a hash
// of what it sends: a browser that has this list gets 304 and no body.
export const GET: RequestHandler = (event) => {
  notCrossSite(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const body = JSON.stringify({ pads: listSealed(root) });
  const etag = `"${Bun.hash(body).toString(36)}"`;
  const headers = { 'cache-control': 'no-store', etag };
  if (event.request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, 'content-type': 'application/json' } });
};
