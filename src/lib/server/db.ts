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
migrate(db);
// Off while migrating: a step may rebuild a table others refer to.
db.run('PRAGMA foreign_keys = ON');
// SQLite's own ceiling, per connection: past it every write fails. Pads and
// links stop growing at SERVER_BYTES (`full`), short of it.
const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size;
db.run(`PRAGMA max_page_count = ${Math.floor((SERVER_BYTES + SERVER_SLACK) / pageSize)}`);
const usedStmt = db.query<{ pages: number }, []>(
  'SELECT page_count - freelist_count AS pages FROM pragma_page_count, pragma_freelist_count'
);

/** Whether the database has reached SERVER_BYTES. */
export function full() {
  return usedStmt.get()!.pages * pageSize >= SERVER_BYTES;
}

const getStmt = db.query<{ data: Uint8Array; updated_at: number }, [string, string]>(
  'SELECT data, updated_at FROM sealed WHERE root = ? AND id = ? AND deleted_at IS NULL'
);
const putStmt = db.query(
  `INSERT INTO sealed (root, id, name, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT(root, id) DO UPDATE SET name = ?3, data = ?4, updated_at = ?5, deleted_at = NULL`
);
// `size`, the sealed text's, for an export to know what it's in for.
const listStmt = db.query<{ id: string; name: string; size: number }, [string]>(
  `SELECT id, name, length(data) AS size FROM sealed WHERE root = ? AND deleted_at IS NULL ORDER BY id LIMIT ${ROOT_PADS}`
);
// What counts toward a root's quota: every pad, emptied ones too until
// they're purged, and every link. length() of a blob doesn't read it.
const usageStmt = db.query<{ bytes: number; pads: number }, [string]>(
  `SELECT
     (SELECT coalesce(sum(length(data) + length(name)), 0) FROM sealed WHERE root = ?1) +
     (SELECT coalesce(sum(length(data)), 0) FROM shares WHERE root = ?1) AS bytes,
     (SELECT count(*) FROM sealed WHERE root = ?1) AS pads`
);
const sizeStmt = db.query<{ size: number }, [string, string]>(
  'SELECT length(data) + length(name) AS size FROM sealed WHERE root = ? AND id = ?'
);

export function getSealed(root: string, id: string) {
  return getStmt.get(root, id);
}

/** Last write wins, and unmarks an emptied pad. */
export function putSealed(root: string, id: string, name: string, data: Uint8Array) {
  const now = Date.now();
  putStmt.run(root, id, name, data, now);
  return now;
}

export function listSealed(root: string) {
  return listStmt.all(root);
}

/** The bytes and pads the root's quota counts. */
export function usage(root: string) {
  return usageStmt.get(root)!;
}

/** The bytes the pad counts for now; null if it doesn't exist. */
export function padSize(root: string, id: string) {
  return sizeStmt.get(root, id)?.size ?? null;
}
