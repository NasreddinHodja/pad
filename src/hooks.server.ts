import type { Handle } from '@sveltejs/kit/hooks';
import { purgeDue } from '#lib/server/trash.ts';

// Before anything reads a root, so none is seen past its purge.
export const handle: Handle = ({ event, resolve }) => {
  purgeDue();
  return resolve(event);
};
