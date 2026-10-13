import { json } from '@sveltejs/kit';
import { notCrossSite, ours, padIdParam, rootParam, unlocked } from '#lib/server/api.ts';
import { meterWrite } from '#lib/server/limits.ts';
import { listShares, removeShares } from '#lib/server/shares.ts';
import type { RequestHandler } from './$types';

// The pad's read-only links, with their keys sealed under the root's.
export const GET: RequestHandler = (event) => {
  notCrossSite(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const shares = listShares(root, padIdParam(event.params.id)).map((s) => ({
    id: s.id,
    sealedKey: Buffer.from(s.sealed_key).toString('base64url'),
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    once: s.once === 1
  }));
  return json({ shares }, { headers: { 'cache-control': 'no-store' } });
};

// Revokes every link to the pad.
export const DELETE: RequestHandler = (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  meterWrite(event, root);
  removeShares(root, padIdParam(event.params.id));
  return new Response(null, { status: 204 });
};
