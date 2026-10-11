// Read-only links: copies of a pad, each sealed by the browser under a key
// only the link has (after its `#`). `sealed_key` is that key sealed under the
// root's, so the root's owners can list the links again; `pad` is the pad's
// id, the HMAC of its path.

import { db } from './db.ts';

/** Links a root can have at once, and the disk their copies take. */
export const MAX_SHARES = 1000;
export const MAX_SHARE_BYTES = 64 * 1024 * 1024;

// A link to an emptied pad is quiet until the pad is saved again or purged.
const getStmt = db.query<{ data: Uint8Array; created_at: number }, [string, string]>(
  `SELECT data, created_at FROM shares s WHERE id = ? AND root = ? AND NOT EXISTS
   (SELECT 1 FROM sealed WHERE root = s.root AND id = s.pad AND deleted_at IS NOT NULL)`
);
const listStmt = db.query<
  { id: string; sealed_key: Uint8Array; created_at: number },
  [string, string]
>('SELECT id, sealed_key, created_at FROM shares WHERE root = ? AND pad = ? ORDER BY created_at');
const countStmt = db.query<{ n: number; bytes: number }, [string]>(
  'SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS bytes FROM shares WHERE root = ?'
);
const addStmt = db.query(
  `INSERT OR IGNORE INTO shares (id, root, pad, sealed_key, data, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const removeStmt = db.query('DELETE FROM shares WHERE id = ? AND root = ?');
const removePadStmt = db.query('DELETE FROM shares WHERE root = ? AND pad = ?');

export function getShare(root: string, id: string) {
  return getStmt.get(id, root);
}

export function listShares(root: string, pad: string) {
  return listStmt.all(root, pad);
}

/** The time it was made; or why it wasn't: the root has too many, or the id is taken. */
export const addShare = db.transaction(
  (root: string, id: string, pad: string, sealedKey: Uint8Array, data: Uint8Array) => {
    const { n, bytes } = countStmt.get(root)!;
    if (n >= MAX_SHARES || bytes + data.length > MAX_SHARE_BYTES) return 'full';
    const now = Date.now();
    return addStmt.run(id, root, pad, sealedKey, data, now).changes === 1 ? now : 'taken';
  }
);

export function removeShare(root: string, id: string) {
  removeStmt.run(id, root);
}

/** Every link to the pad. */
export function removeShares(root: string, pad: string) {
  removePadStmt.run(root, pad);
}
