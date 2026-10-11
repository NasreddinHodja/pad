import type { Handle } from '@sveltejs/kit/hooks';
import { requestWait } from '#lib/server/limits.ts';
import { purgeDue } from '#lib/server/trash.ts';

export const handle: Handle = ({ event, resolve }) => {
  // First, so a refused request costs as little as can be.
  const wait = requestWait(event.getClientAddress());
  if (wait)
    return Response.json(
      { status: 429, message: `too many requests, wait ${wait}s` },
      { status: 429, headers: { 'retry-after': String(wait) } }
    );
  // Before anything reads a root, so none is seen past its purge.
  purgeDue();
  return resolve(event);
};
