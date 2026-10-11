import { json } from '@sveltejs/kit';
import { rootParam, unlocked } from '#lib/server/api.ts';
import { listSealed } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

// Every pad of the root, sealed, for the browser to list.
export const GET: RequestHandler = (event) => {
  const root = rootParam(event.params.root);
  unlocked(event, root);
  return json({ pads: listSealed(root) }, { headers: { 'cache-control': 'no-store' } });
};
