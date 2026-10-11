import { json } from '@sveltejs/kit';
import { rootParam, unlocked } from '#lib/server/api.ts';
import { usage } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

// What the root's quota counts so far, for a client to check before a big
// write (the quota's in GET /_/limits).
export const GET: RequestHandler = (event) => {
  const root = rootParam(event.params.root);
  unlocked(event, root);
  return json(usage(root), { headers: { 'cache-control': 'no-store' } });
};
