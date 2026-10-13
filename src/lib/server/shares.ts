// Read-only links: copies of a pad, each sealed by the browser under a key
// only the link has (after its `#`). `sealed_key` is that key sealed under the
// root's, so the root's owners can list the links again; `pad` is the pad's
// id, the HMAC of its path. A link may expire (`expires_at`), after which it's
// read as gone and the purge deletes it, or open once (`once`): the read that
// takes its copy deletes it.

import { db } from './db.ts';
import { MAX_SHARES } from './limits.ts';

type Row = { data: Uint8Array; created_at: number; once: number };

const getStmt = db.query<Row, [string, string, number]>(
  `SELECT data, created_at, once FROM shares
   WHERE id = ? AND root = ? AND (expires_at IS NULL OR expires_at > ?)`
);
const takeStmt = db.query<Row, [string, string, number]>(
  `DELETE FROM shares
   WHERE id = ? AND root = ? AND (expires_at IS NULL OR expires_at > ?)
   RETURNING data, created_at, once`
);
const listStmt = db.query<
  {
    id: string;
    sealed_key: Uint8Array;
    created_at: number;
    expires_at: number | null;
    once: number;
  },
  [string, string, number]
>(
  `SELECT id, sealed_key, created_at, expires_at, once FROM shares
   WHERE root = ? AND pad = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at`
);
const countStmt = db.query<{ n: number }, [string, number]>(
  'SELECT count(*) AS n FROM shares WHERE root = ? AND (expires_at IS NULL OR expires_at > ?)'
);
const addStmt = db.query(
  `INSERT OR IGNORE INTO shares (id, root, pad, sealed_key, data, created_at, expires_at, once)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const removeStmt = db.query('DELETE FROM shares WHERE id = ? AND root = ?');
const removePadStmt = db.query('DELETE FROM shares WHERE root = ? AND pad = ?');
const expiredStmt = db.query('DELETE FROM shares WHERE expires_at <= ?');

/** The link's copy, unless it expired. */
export function getShare(root: string, id: string, now = Date.now()) {
  return getStmt.get(id, root, now);
}

/** The link's copy, deleted as it's read: of two reads at once, only one gets it. */
export function takeShare(root: string, id: string, now = Date.now()) {
  return takeStmt.get(id, root, now);
}

export function listShares(root: string, pad: string, now = Date.now()) {
  return listStmt.all(root, pad, now);
}

export type Made = { lifetime: number | null; once: boolean };

/** The time it was made; or why it wasn't: the root has MAX_SHARES, or the id is taken. */
export const addShare = db.transaction(
  (
    root: string,
    id: string,
    pad: string,
    sealedKey: Uint8Array,
    data: Uint8Array,
    { lifetime, once }: Made = { lifetime: null, once: false }
  ) => {
    const now = Date.now();
    if (countStmt.get(root, now)!.n >= MAX_SHARES) return 'full';
    const expires = lifetime === null ? null : now + lifetime;
    // `changes` counts the trigger's update of the root too.
    return addStmt.run(id, root, pad, sealedKey, data, now, expires, once ? 1 : 0).changes > 0
      ? now
      : 'taken';
  }
);

export function removeShare(root: string, id: string) {
  removeStmt.run(id, root);
}

/** Every link to the pad. */
export function removeShares(root: string, pad: string) {
  removePadStmt.run(root, pad);
}

/** Links past their expiry (trash.ts's purge). */
export function removeExpired(now: number) {
  expiredStmt.run(now);
}
