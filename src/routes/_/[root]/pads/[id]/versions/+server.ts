import { json } from '@sveltejs/kit';
import { notCrossSite, padIdParam, rootParam, unlocked } from '#lib/server/api.ts';
import { listVersions } from '#lib/server/db.ts';
import type { RequestHandler } from './$types';

// The pad's kept versions, newest first: each one's time and sealed size.
export const GET: RequestHandler = (event) => {
  notCrossSite(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const versions = listVersions(root, padIdParam(event.params.id));
  return json({ versions }, { headers: { 'cache-control': 'no-store' } });
};
