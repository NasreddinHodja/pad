import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ROOT_PADS, SERVER_BYTES, SERVER_SLACK } from './limits.ts';
import { migrate } from './schema.ts';

// PAD_DB is /config/pad.db in the Docker image; ./data/pad.db in dev.
const file = process.env.PAD_DB ?? 'data/pad.db';
mkdirSync(dirname(file), { recursive: true });

export const db = new Database(file, { strict: true });
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
// What's deleted or overwritten is zeroed in the file, and the WAL is cut
// back to nothing each time it starts over, rather than reused with old pages
// past its end: a purged pad leaves no copy on the disk. Measured on the
// laptop: 0 copies of 200 deleted rows left, against 150 in the file and
// 3,233 in the WAL without; a save's 14.5 µs in SQLite becomes 16.2.
db.run('PRAGMA secure_delete = ON');
db.run('PRAGMA journal_size_limit = 0');
migrate(db);
// Off while migrating: a step may rebuild a table others refer to.
db.run('PRAGMA foreign_keys = ON');
const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size;
const usedStmt = db.query<{ pages: number }, []>(
  'SELECT page_count - freelist_count AS pages FROM pragma_page_count, pragma_freelist_count'
);
let ceiling = 0;

/**
 * Pads and links stop growing at `bytes` (`full`); SQLite refuses any write
 * SERVER_SLACK past it, per connection, so a full server still lets people in.
 */
export function setCeiling(bytes: number) {
  ceiling = bytes;
  db.run(`PRAGMA max_page_count = ${Math.ceil((bytes + SERVER_SLACK) / pageSize)}`);
}
setCeiling(SERVER_BYTES);

/** Whether the database has reached its ceiling. */
export function full() {
  return usedStmt.get()!.pages * pageSize >= ceiling;
}

const getStmt = db.query<{ data: Uint8Array; updated_at: number }, [string, string]>(
  'SELECT data, updated_at FROM sealed WHERE root = ? AND id = ? AND deleted_at IS NULL'
);
const versionStmt = db.query<{ updated_at: number }, [string, string]>(
  'SELECT updated_at FROM sealed WHERE root = ? AND id = ? AND deleted_at IS NULL'
);
// Emptied pads included: a version never repeats, even across an emptying.
const lastStmt = db.query<{ updated_at: number }, [string, string]>(
  'SELECT updated_at FROM sealed WHERE root = ? AND id = ?'
);
const putStmt = db.query(
  `INSERT INTO sealed (root, id, name, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT(root, id) DO UPDATE SET name = ?3, data = ?4, updated_at = ?5, deleted_at = NULL`
);
// A pad that has its name: SQLite checks NOT NULL on the row an upsert would
// insert, so keeping the name is an UPDATE of its own.
const rewriteStmt = db.query(
  'UPDATE sealed SET data = ?3, updated_at = ?4, deleted_at = NULL WHERE root = ?1 AND id = ?2'
);
const listStmt = db.query<{ id: string; name: string }, [string]>(
  `SELECT id, name FROM sealed WHERE root = ? AND deleted_at IS NULL ORDER BY id LIMIT ${ROOT_PADS}`
);
// What counts toward a root's quota, kept by triggers (schema.ts, step 3).
const usageStmt = db.query<{ bytes: number; pads: number }, [string]>(
  'SELECT bytes, pads FROM roots WHERE name = ?'
);
const sizeStmt = db.query<{ total: number; name: number }, [string, string]>(
  'SELECT length(data) + length(name) AS total, length(name) AS name FROM sealed WHERE root = ? AND id = ?'
);

export function getSealed(root: string, id: string) {
  return getStmt.get(root, id);
}

/** The pad's version, its last write's time; 0 when it has none. */
export function padVersion(root: string, id: string) {
  return versionStmt.get(root, id)?.updated_at ?? 0;
}

/**
 * Writes the pad, whatever its version (the route checks it), and unmarks an
 * emptied pad. A null name keeps the one it has. Its time is its version, so
 * it only ever grows: two writes in one millisecond still get two.
 */
export function putSealed(root: string, id: string, name: string | null, data: Uint8Array) {
  const now = Math.max(Date.now(), (lastStmt.get(root, id)?.updated_at ?? 0) + 1);
  if (name === null) rewriteStmt.run(root, id, data, now);
  else putStmt.run(root, id, name, data, now);
  return now;
}

export function listSealed(root: string) {
  return listStmt.all(root);
}

/** The bytes and pads the root's quota counts. */
export function usage(root: string) {
  return usageStmt.get(root) ?? { bytes: 0, pads: 0 };
}

/** The bytes the pad counts for now, and its name's; null if it has no row. */
export function padSize(root: string, id: string) {
  return sizeStmt.get(root, id) ?? null;
}
