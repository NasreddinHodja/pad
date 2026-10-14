import { error, redirect } from '@sveltejs/kit';
import { href } from '#lib/href.ts';
import { access, kdfOf } from '#lib/server/auth.ts';
import { normalizePath } from '#lib/server/limits.ts';
import { deletedAt, GRACE } from '#lib/server/trash.ts';
import type { PageServerLoad } from './$types';

// Only the root's state: the pad itself is sealed, and the browser opens it.
// The path under the root is after the `#` (href.ts), so it never gets here;
// an address from before that, `/a/b`, moves to `/a#b`.
export const load: PageServerLoad = ({ params, cookies }) => {
  const path = normalizePath(params.path);
  if (path === null) error(400, 'not a valid pad path');
  if (path === '') redirect(308, '/');
  if (path !== params.path || path.includes('/')) redirect(308, href(path.split('/')));
  const root = path;
  const state = access(cookies, root);
  const kdf = kdfOf(root);
  const deleted = deletedAt(root);
  return {
    root,
    state,
    kdf: kdf && { salt: Buffer.from(kdf.salt).toString('base64url'), argon2: kdf.argon2 },
    /** A deleted root's: when it's purged, unless its password reclaims it first. */
    purgeAt: deleted === null ? null : deleted + GRACE,
    /** How long a deleted root waits to be purged (the delete dialog says). */
    grace: GRACE
  };
};
