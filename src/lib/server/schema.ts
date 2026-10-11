// The database's tables, and how a database of any earlier release becomes
// one of this release's.
//
// Each step runs once, in a transaction with its number in `user_version`, so
// a failed step leaves the database as it was before it. A released step is
// never edited: a change is a new step.

import type { Database } from 'bun:sqlite';

const has = (db: Database, table: string, column: string) =>
  db.query('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get(table, column) !== null;

const MIGRATIONS: (string | ((db: Database) => void))[] = [
  // 1. Whatever the tables were before migrations (each module made its own,
  // and added columns as they came), as they were at f7f702c.
  (db) => {
    db.run(`CREATE TABLE IF NOT EXISTS roots (
      name TEXT PRIMARY KEY,
      salt BLOB NOT NULL,
      auth_hash BLOB NOT NULL,
      sealed_key BLOB NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    if (!has(db, 'roots', 'deleted_at')) db.run('ALTER TABLE roots ADD COLUMN deleted_at INTEGER');
    if (!has(db, 'roots', 'theme')) db.run('ALTER TABLE roots ADD COLUMN theme BLOB');
    db.run(`CREATE TABLE IF NOT EXISTS sealed (
      root TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (root, id)
    ) WITHOUT ROWID`);
    if (!has(db, 'sealed', 'deleted_at'))
      db.run('ALTER TABLE sealed ADD COLUMN deleted_at INTEGER');
    db.run(`CREATE TABLE IF NOT EXISTS unlocks (
      token_hash BLOB NOT NULL,
      root TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (token_hash, root)
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE IF NOT EXISTS devices (
      token_hash BLOB NOT NULL,
      root TEXT NOT NULL,
      last_seen INTEGER NOT NULL,
      PRIMARY KEY (token_hash, root)
    ) WITHOUT ROWID`);
    db.run(`CREATE TABLE IF NOT EXISTS shares (
      id TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      pad TEXT NOT NULL,
      sealed_key BLOB NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
  },

  // 2. Everything belongs to a claimed root and goes when it does. The plain
  // pads from before encryption go: the last were migrated before this.
  // Rows of no root were unreadable by anyone.
  `
  DROP TABLE IF EXISTS pads;
  ALTER TABLE roots RENAME TO roots_old;
  ALTER TABLE sealed RENAME TO sealed_old;
  ALTER TABLE unlocks RENAME TO unlocks_old;
  ALTER TABLE devices RENAME TO devices_old;
  ALTER TABLE shares RENAME TO shares_old;

  -- A root pad: the first segment of a path. The password is the browser's;
  -- the server keeps the SHA-256 of what the browser derives from it, the
  -- salt, and the root key sealed under it (see auth.ts).
  CREATE TABLE roots (
    name TEXT PRIMARY KEY,
    salt BLOB NOT NULL,
    auth_hash BLOB NOT NULL,
    sealed_key BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    -- Deleted: when, until it's reclaimed or trash.ts purges it.
    deleted_at INTEGER,
    -- Sealed by the browser, like a pad's text (see theme.ts).
    theme BLOB
  ) WITHOUT ROWID;

  -- id is the HMAC of the pad's path under the root's key; name is the path
  -- and data the text, both sealed by the browser. The server can tell how
  -- many pads a root has and how long each is, nothing more.
  CREATE TABLE sealed (
    root TEXT NOT NULL REFERENCES roots (name) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    -- Emptied, or its root deleted: when, until trash.ts purges it.
    deleted_at INTEGER,
    PRIMARY KEY (root, id)
  ) WITHOUT ROWID;

  -- A browser's unlock of a root: the SHA-256 of its cookie's token.
  CREATE TABLE unlocks (
    token_hash BLOB NOT NULL,
    root TEXT NOT NULL REFERENCES roots (name) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (token_hash, root)
  ) WITHOUT ROWID;

  -- Browsers that have unlocked a root, which back off on their own failures.
  CREATE TABLE devices (
    token_hash BLOB NOT NULL,
    root TEXT NOT NULL REFERENCES roots (name) ON DELETE CASCADE,
    last_seen INTEGER NOT NULL,
    PRIMARY KEY (token_hash, root)
  ) WITHOUT ROWID;

  -- Read-only links. pad is the shared pad's id, which needn't be saved: a
  -- link to a path with only pads under it is as good. Their links go with
  -- a pad when it's purged (trash.ts), not by a foreign key.
  CREATE TABLE shares (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL REFERENCES roots (name) ON DELETE CASCADE,
    pad TEXT NOT NULL,
    sealed_key BLOB NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID;

  INSERT INTO roots SELECT name, salt, auth_hash, sealed_key, created_at, deleted_at, theme
    FROM roots_old;
  INSERT INTO sealed SELECT root, id, name, data, updated_at, deleted_at
    FROM sealed_old WHERE root IN (SELECT name FROM roots);
  INSERT INTO unlocks SELECT token_hash, root, created_at, last_seen
    FROM unlocks_old WHERE root IN (SELECT name FROM roots);
  INSERT INTO devices SELECT token_hash, root, last_seen
    FROM devices_old WHERE root IN (SELECT name FROM roots);
  INSERT INTO shares SELECT id, root, pad, sealed_key, data, created_at
    FROM shares_old WHERE root IN (SELECT name FROM roots);

  DROP TABLE roots_old;
  DROP TABLE sealed_old;
  DROP TABLE unlocks_old;
  DROP TABLE devices_old;
  DROP TABLE shares_old;

  CREATE INDEX sealed_deleted ON sealed (deleted_at) WHERE deleted_at IS NOT NULL;
  CREATE INDEX unlocks_by_root ON unlocks (root);
  CREATE INDEX devices_by_root ON devices (root);
  CREATE INDEX shares_by_pad ON shares (root, pad);
  `,

  // 3. What a root's quota counts, kept on its row by triggers: summing its
  // pads on every save cost 372 µs at 1000 pads, five times the save itself.
  `
  -- Its pads' sealed text and paths, emptied ones too, and its links' copies.
  ALTER TABLE roots ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;
  -- Its pads, emptied ones too.
  ALTER TABLE roots ADD COLUMN pads INTEGER NOT NULL DEFAULT 0;

  UPDATE roots SET
    bytes =
      (SELECT coalesce(sum(length(data) + length(name)), 0) FROM sealed WHERE root = roots.name) +
      (SELECT coalesce(sum(length(data)), 0) FROM shares WHERE root = roots.name),
    pads = (SELECT count(*) FROM sealed WHERE root = roots.name);

  CREATE TRIGGER sealed_added AFTER INSERT ON sealed BEGIN
    UPDATE roots SET bytes = bytes + length(NEW.data) + length(NEW.name), pads = pads + 1
      WHERE name = NEW.root;
  END;
  CREATE TRIGGER sealed_changed AFTER UPDATE OF data, name ON sealed BEGIN
    UPDATE roots SET bytes = bytes + length(NEW.data) + length(NEW.name)
        - length(OLD.data) - length(OLD.name)
      WHERE name = NEW.root;
  END;
  CREATE TRIGGER sealed_removed AFTER DELETE ON sealed BEGIN
    UPDATE roots SET bytes = bytes - length(OLD.data) - length(OLD.name), pads = pads - 1
      WHERE name = OLD.root;
  END;
  CREATE TRIGGER shares_added AFTER INSERT ON shares BEGIN
    UPDATE roots SET bytes = bytes + length(NEW.data) WHERE name = NEW.root;
  END;
  CREATE TRIGGER shares_removed AFTER DELETE ON shares BEGIN
    UPDATE roots SET bytes = bytes - length(OLD.data) WHERE name = OLD.root;
  END;
  `
];

/**
 * Brings `db` up to the last step. A database from a newer release is refused
 * rather than used with a schema this one doesn't know. Foreign keys must be
 * off while it runs (steps rebuild tables), and on after.
 */
export function migrate(db: Database) {
  const { user_version: version } = db
    .query<{ user_version: number }, []>('PRAGMA user_version')
    .get()!;
  if (version > MIGRATIONS.length)
    throw new Error(
      `the database is at version ${version}, from a newer release; this one knows ${MIGRATIONS.length}`
    );
  for (const [n, step] of MIGRATIONS.entries()) {
    if (n < version) continue;
    db.transaction(() => {
      if (typeof step === 'string') db.run(step);
      else step(db);
      if (db.query('PRAGMA foreign_key_check').get())
        throw new Error(`migration ${n + 1} leaves rows of no root`);
      db.run(`PRAGMA user_version = ${n + 1}`);
    })();
  }
}
