import { error, json } from '@sveltejs/kit';
import { notCrossSite, ours, readCapped, rootParam, unlocked } from '#lib/server/api.ts';
import { browsers, labelBrowser, SEALED_LABEL_BYTES } from '#lib/server/auth.ts';
import { meterWrite } from '#lib/server/limits.ts';
import type { RequestHandler } from './$types';

// The browsers signed in to the root: an id, when it signed in and was last
// used, the label it sealed (null before it sent one), and which one is asking.
export const GET: RequestHandler = (event) => {
  notCrossSite(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  return json(browsers(event.cookies, root), { headers: { 'cache-control': 'no-store' } });
};

// This browser's sealed label: on the unlock's row, not counted in the root's quota.
export const PUT: RequestHandler = async (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const label = await readCapped(event.request, SEALED_LABEL_BYTES, 'label is too big');
  // Exactly its size: every label padded alike, none tells the browser by its length.
  if (label.length !== SEALED_LABEL_BYTES) error(400, 'malformed label');
  meterWrite(event, root, label.length);
  labelBrowser(event.cookies, root, label);
  return new Response(null, { status: 204 });
};
