// Deletion is a mark, and the mark is undone or made good after GRACE.
//
// An emptied pad is marked, and its sealed text and name go at once: nothing
// could read them (saving it again writes both anew). It drops out of its
// root's list; its links, copies of their own, stay until revoked. A deleted root is marked with every
// pad in it, at one time, and every browser is signed out of it; its old
// password reclaims it, unmarking what was marked with it, and a fresh claim
// purges it first. Whatever is still marked after GRACE is purged: the sealed
// pads' rows and, for a root, its password, unlocks, devices and links.

import { config } from './config.ts';
import { db } from './db.ts';

export const GRACE = config.grace;
/** How often a request may set off a purge. */
const PURGE_EVERY = 60 * 60 * 1000;

// The row stays, empty: it keeps the pad's version growing and counts toward
// the root's pads until it's purged.
const markPadStmt = db.query(
  `UPDATE sealed SET deleted_at = ?, data = x'', name = ''
   WHERE root = ? AND id = ? AND deleted_at IS NULL`
);
const deletedAtStmt = db.query<{ deleted_at: number | null }, [string]>(
  'SELECT deleted_at FROM roots WHERE name = ?'
);
const lastMarkStmt = db.query<{ at: number | null }, [string]>(
  'SELECT max(deleted_at) AS at FROM sealed WHERE root = ?'
);
const markRootStmt = db.query(
  'UPDATE roots SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL'
);
const markPadsStmt = db.query(
  'UPDATE sealed SET deleted_at = ? WHERE root = ? AND deleted_at IS NULL'
);
const signOutStmt = db.query('DELETE FROM unlocks WHERE root = ?');
const unmarkPadsStmt = db.query(
  'UPDATE sealed SET deleted_at = NULL WHERE root = ? AND deleted_at = ?'
);
const unmarkRootStmt = db.query('UPDATE roots SET deleted_at = NULL WHERE name = ?');
// The root's pads, links, unlocks and devices go with it.
const purgeRootStmt = db.query('DELETE FROM roots WHERE name = ?');
const purgeRootsStmt = db.query('DELETE FROM roots WHERE deleted_at <= ?');
const purgePadsStmt = db.query('DELETE FROM sealed WHERE deleted_at <= ?');

/** An emptied pad. Its first emptying counts, not later ones. */
export function markPad(root: string, id: string) {
  markPadStmt.run(Date.now(), root, id);
}

/** When the root was deleted, if it's waiting to be purged. */
export function deletedAt(root: string) {
  return deletedAtStmt.get(root)?.deleted_at ?? null;
}

/** Marks the root and every pad in it, and signs every browser out. */
export const deleteRoot = db.transaction((root: string) => {
  // After every pad already emptied, even within the millisecond, so a
  // reclaim tells them apart.
  const last = lastMarkStmt.get(root)?.at;
  const now = Math.max(Date.now(), (last ?? 0) + 1);
  markRootStmt.run(now, root);
  markPadsStmt.run(now, root);
  signOutStmt.run(root);
});

/** Unmarks the root and the pads marked with it; pads emptied before stay marked. */
export const reclaimRoot = db.transaction((root: string) => {
  const at = deletedAt(root);
  if (at === null) return;
  unmarkPadsStmt.run(root, at);
  unmarkRootStmt.run(root);
});

/** Everything of the root, now. */
export function purgeRoot(root: string) {
  purgeRootStmt.run(root);
}

/** What's been marked longer than GRACE. */
export const purge = db.transaction((now: number) => {
  const before = now - GRACE;
  purgeRootsStmt.run(before);
  purgePadsStmt.run(before);
});

let lastPurge = 0;

/** A purge, at most once every PURGE_EVERY: requests set it off (hooks.server.ts), there's no timer. */
export function purgeDue(now = Date.now()) {
  if (now - lastPurge < PURGE_EVERY) return;
  lastPurge = now;
  purge(now);
}
