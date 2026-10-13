import { notCrossSite, ours, readCapped, rootParam, unlocked } from '#lib/server/api.ts';
import { MAX_THEME, meterWrite } from '#lib/server/limits.ts';
import { getTheme, setTheme } from '#lib/server/theme.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => {
  notCrossSite(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  const theme = getTheme(root);
  return new Response(theme ? new Uint8Array(theme) : null, {
    status: theme ? 200 : 204,
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
  });
};

export const PUT: RequestHandler = async (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  unlocked(event, root);
  // At most 256 bytes on the root's row: metered, not counted in its quota.
  const theme = await readCapped(event.request, MAX_THEME, 'theme is too big');
  meterWrite(event, root, theme.length);
  setTheme(root, theme);
  return new Response(null, { status: 204 });
};
