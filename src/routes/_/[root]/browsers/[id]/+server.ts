import { error } from '@sveltejs/kit';
import { browserIdParam, ours, rootParam, unlocked } from '#lib/server/api.ts';
import { signOut } from '#lib/server/auth.ts';
import { meterWrite } from '#lib/server/limits.ts';
import type { RequestHandler } from './$types';

// Signs a browser out of the root, this one included.
export const DELETE: RequestHandler = (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  meterWrite(event, root);
  if (!signOut(root, browserIdParam(event.params.id)))
    error(404, `no such browser signed in to /${root}`);
  return new Response(null, { status: 204 });
};
