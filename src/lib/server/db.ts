import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// PAD_DB is /config/pad.db in the Docker image; ./data/pad.db in dev.
const file = process.env.PAD_DB ?? 'data/pad.db';
mkdirSync(dirname(file), { recursive: true });

export const db = new Database(file, { strict: true });
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
// `id` is the HMAC of the pad's path under the root's key; `name` is the path
// and `data` the text, both sealed by the browser. The server can tell how
// many pads a root has and how long each is, nothing more.
db.run(`CREATE TABLE IF NOT EXISTS sealed (
  root TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (root, id)
) WITHOUT ROWID`);
// Emptied pads and those of deleted roots: when, until trash.ts purges them.
if (!db.query("SELECT 1 FROM pragma_table_info('sealed') WHERE name = 'deleted_at'").get())
  db.run('ALTER TABLE sealed ADD COLUMN deleted_at INTEGER');
db.run(
  'CREATE INDEX IF NOT EXISTS sealed_deleted ON sealed (deleted_at) WHERE deleted_at IS NOT NULL'
);

const getStmt = db.query<{ data: Uint8Array; updated_at: number }, [string, string]>(
  'SELECT data, updated_at FROM sealed WHERE root = ? AND id = ? AND deleted_at IS NULL'
);
const putStmt = db.query(
  `INSERT INTO sealed (root, id, name, data, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
   ON CONFLICT(root, id) DO UPDATE SET name = ?3, data = ?4, updated_at = ?5, deleted_at = NULL`
);
// `size`, the sealed text's, for an export to know what it's in for.
const listStmt = db.query<{ id: string; name: string; size: number }, [string]>(
  'SELECT id, name, length(data) AS size FROM sealed WHERE root = ? AND deleted_at IS NULL ORDER BY id LIMIT 5000'
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
