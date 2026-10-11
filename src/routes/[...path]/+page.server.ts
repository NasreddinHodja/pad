import { error, redirect } from '@sveltejs/kit';
import { href } from '#lib/href.ts';
import { access, rootOf, saltOf } from '#lib/server/auth.ts';
import { normalizePath } from '#lib/server/limits.ts';
import { deletedAt, GRACE } from '#lib/server/trash.ts';
import type { PageServerLoad } from './$types';

// Only the root's state: the pad itself is sealed, and the browser opens it.
export const load: PageServerLoad = ({ params, cookies }) => {
  const path = normalizePath(params.path);
  if (path === null) error(400, 'not a valid pad path');
  if (path === '') redirect(308, '/');
  if (path !== params.path) redirect(308, href(path.split('/')));
  const root = rootOf(path);
  const state = access(cookies, root);
  const salt = saltOf(root);
  const deleted = deletedAt(root);
  return {
    path,
    root,
    state,
    salt: salt && Buffer.from(salt).toString('base64url'),
    /** A deleted root's: when it's purged, unless its password reclaims it first. */
    purgeAt: deleted === null ? null : deleted + GRACE
  };
};
