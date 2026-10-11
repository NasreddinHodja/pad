// Deletion is a mark, and the mark is undone or made good after GRACE.
//
// An emptied pad is marked: it drops out of its root's list and its links go
// quiet, and saving it again unmarks it. A deleted root is marked with every
// pad in it, at one time, and every browser is signed out of it; its old
// password reclaims it, unmarking what was marked with it, and a fresh claim
// purges it first. Whatever is still marked after GRACE is purged: the sealed
// pads, their links and, for a root, its password, unlocks and devices.
//
// The tables are made by db.ts, shares.ts and auth.ts; these statements are
// prepared on first use, so this module only needs the database.

import { db } from './db.ts';

const DAY = 24 * 60 * 60 * 1000;
export const GRACE = 30 * DAY;
/** How often a request may set off a purge. */
const PURGE_EVERY = 60 * 60 * 1000;

/** An emptied pad. Its first emptying counts, not later ones. */
export function markPad(root: string, id: string) {
  db.query('UPDATE sealed SET deleted_at = ? WHERE root = ? AND id = ? AND deleted_at IS NULL').run(
    Date.now(),
    root,
    id
  );
}

/** When the root was deleted, if it's waiting to be purged. */
export function deletedAt(root: string) {
  return (
    db
      .query<{ deleted_at: number | null }, [string]>('SELECT deleted_at FROM roots WHERE name = ?')
      .get(root)?.deleted_at ?? null
  );
}

/** Marks the root and every pad in it, and signs every browser out. */
export const deleteRoot = db.transaction((root: string) => {
  // After every pad already emptied, even within the millisecond, so a
  // reclaim tells them apart.
  const last = db
    .query<{ at: number | null }, [string]>(
      'SELECT max(deleted_at) AS at FROM sealed WHERE root = ?'
    )
    .get(root)?.at;
  const now = Math.max(Date.now(), (last ?? 0) + 1);
  db.query('UPDATE roots SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL').run(now, root);
  db.query('UPDATE sealed SET deleted_at = ? WHERE root = ? AND deleted_at IS NULL').run(now, root);
  db.query('DELETE FROM unlocks WHERE root = ?').run(root);
});

/** Unmarks the root and the pads marked with it; pads emptied before stay marked. */
export const reclaimRoot = db.transaction((root: string) => {
  const at = deletedAt(root);
  if (at === null) return;
  db.query('UPDATE sealed SET deleted_at = NULL WHERE root = ? AND deleted_at = ?').run(root, at);
  db.query('UPDATE roots SET deleted_at = NULL WHERE name = ?').run(root);
});

/** Everything of the root, now. */
export const purgeRoot = db.transaction((root: string) => {
  for (const table of ['sealed', 'shares', 'unlocks', 'devices'])
    db.query(`DELETE FROM ${table} WHERE root = ?`).run(root);
  db.query('DELETE FROM roots WHERE name = ?').run(root);
});

/** What's been marked longer than GRACE. */
export const purge = db.transaction((now: number) => {
  const before = now - GRACE;
  const roots = db
    .query<{ name: string }, [number]>('SELECT name FROM roots WHERE deleted_at <= ?')
    .all(before);
  for (const { name } of roots) purgeRoot(name);
  db.query(
    `DELETE FROM shares WHERE (root, pad) IN (SELECT root, id FROM sealed WHERE deleted_at <= ?)`
  ).run(before);
  db.query('DELETE FROM sealed WHERE deleted_at <= ?').run(before);
});

let lastPurge = 0;

/** A purge, at most once every PURGE_EVERY: requests set it off, there's no timer. */
export function purgeDue(now = Date.now()) {
  if (now - lastPurge < PURGE_EVERY) return;
  lastPurge = now;
  purge(now);
}
