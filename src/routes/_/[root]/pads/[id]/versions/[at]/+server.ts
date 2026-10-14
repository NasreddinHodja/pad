import { error } from '@sveltejs/kit';
import { notCrossSite, padIdParam, rootParam, unlocked } from '#lib/server/api.ts';
import { getVersion } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

// One kept version's sealed text, sealed to the pad's id as the pad's is.
export const GET: RequestHandler = (event) => {
  notCrossSite(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  if (!/^[1-9][0-9]{0,14}$/.test(event.params.at)) error(400, 'not a version');
  const data = getVersion(root, padIdParam(event.params.id), Number(event.params.at));
  if (!data) error(404, 'no such version');
  return new Response(new Uint8Array(data), {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
  });
};
