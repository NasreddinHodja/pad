import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { migrate } from './schema.ts';

/** The tables as f7f702c's modules made them, before migrations. */
function f7f702c({ columns = true } = {}) {
  const db = new Database(':memory:', { strict: true });
  db.run(`
    CREATE TABLE pads (path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE sealed (root TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (root, id)) WITHOUT ROWID;
    CREATE TABLE roots (name TEXT PRIMARY KEY, salt BLOB NOT NULL, auth_hash BLOB NOT NULL,
      sealed_key BLOB NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE TABLE unlocks (token_hash BLOB NOT NULL, root TEXT NOT NULL, created_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, PRIMARY KEY (token_hash, root)) WITHOUT ROWID;
    CREATE INDEX unlocks_by_root ON unlocks (root);
    CREATE TABLE devices (token_hash BLOB NOT NULL, root TEXT NOT NULL, last_seen INTEGER NOT NULL,
      PRIMARY KEY (token_hash, root)) WITHOUT ROWID;
    CREATE TABLE shares (id TEXT PRIMARY KEY, root TEXT NOT NULL, pad TEXT NOT NULL,
      sealed_key BLOB NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;
    CREATE INDEX shares_by_pad ON shares (root, pad);
  `);
  if (columns)
    db.run(`
      ALTER TABLE sealed ADD COLUMN deleted_at INTEGER;
      CREATE INDEX sealed_deleted ON sealed (deleted_at) WHERE deleted_at IS NOT NULL;
      ALTER TABLE roots ADD COLUMN deleted_at INTEGER;
      ALTER TABLE roots ADD COLUMN theme BLOB;
    `);
  return db;
}

const schema = (db: Database) =>
  db.query('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all();

const fresh = () => {
  const db = new Database(':memory:', { strict: true });
  migrate(db);
  return db;
};

test('a database from before migrations keeps its rows', () => {
  const db = f7f702c();
  const key = new Uint8Array([1, 2, 3]);
  db.run(`INSERT INTO pads VALUES ('a/b', 'plain', 1)`);
  db.query(`INSERT INTO roots VALUES ('a', ?1, ?1, ?1, 1, 2, ?1)`).run(key);
  db.query(`INSERT INTO sealed VALUES ('a', 'p', 'n', ?, 3, NULL)`).run(key);
  db.query(`INSERT INTO unlocks VALUES (?, 'a', 4, 5)`).run(key);
  db.query(`INSERT INTO devices VALUES (?, 'a', 6)`).run(key);
  db.query(`INSERT INTO shares VALUES ('s', 'a', 'p', ?1, ?1, 7)`).run(key);
  const before = Date.now();
  migrate(db);
  const after = Date.now();

  expect(schema(db)).toEqual(schema(fresh()));
  expect(db.query('SELECT * FROM roots').all()).toEqual([
    {
      name: 'a',
      salt: key,
      auth_hash: key,
      sealed_key: key,
      created_at: 1,
      deleted_at: 2,
      theme: key,
      // Its pad's text and name, 3 + 1, and its link's copy, 3.
      bytes: 7,
      pads: 1,
      history: 0,
      // What every root before migration 4 was derived with.
      argon2_memory: 19 * 1024,
      argon2_iterations: 2,
      argon2_parallelism: 1,
      used_at: expect.any(Number)
    }
  ]);
  // Used at the upgrade, so retention counts from then.
  const { used_at } = db.query<{ used_at: number }, []>('SELECT used_at FROM roots').get()!;
  expect(used_at).toBeGreaterThanOrEqual(before);
  expect(used_at).toBeLessThanOrEqual(after);
  expect(db.query('SELECT * FROM sealed').all()).toEqual([
    { root: 'a', id: 'p', name: 'n', data: key, updated_at: 3, deleted_at: null }
  ]);
  expect(db.query('SELECT * FROM unlocks').all()).toEqual([
    // An id of its own since migration 8, and no label until its browser sends one.
    {
      token_hash: key,
      root: 'a',
      created_at: 4,
      last_seen: 5,
      id: expect.stringMatching(/^[\w-]{22}$/),
      label: null
    }
  ]);
  expect(db.query('SELECT * FROM devices').all()).toEqual([
    { token_hash: key, root: 'a', last_seen: 6 }
  ]);
  expect(db.query('SELECT * FROM shares').all()).toEqual([
    {
      id: 's',
      root: 'a',
      pad: 'p',
      sealed_key: key,
      data: key,
      created_at: 7,
      expires_at: null,
      once: 0
    }
  ]);
});

test('one from before the deleted_at and theme columns gets them', () => {
  const db = f7f702c({ columns: false });
  migrate(db);
  expect(schema(db)).toEqual(schema(fresh()));
});

test('rows of no root are dropped', () => {
  const db = f7f702c();
  const key = new Uint8Array([1]);
  db.query(`INSERT INTO sealed VALUES ('none', 'p', 'n', ?, 3, NULL)`).run(key);
  db.query(`INSERT INTO shares VALUES ('s', 'none', 'p', ?1, ?1, 7)`).run(key);
  migrate(db);
  expect(db.query('SELECT count(*) AS n FROM sealed').get()).toEqual({ n: 0 });
  expect(db.query('SELECT count(*) AS n FROM shares').get()).toEqual({ n: 0 });
});

test('a purged root takes everything of its own with it', () => {
  const db = fresh();
  db.run('PRAGMA foreign_keys = ON');
  const key = new Uint8Array([1]);
  for (const root of ['a', 'b']) {
    db.query(
      `INSERT INTO roots VALUES (?1, ?2, ?2, ?2, 1, NULL, NULL, 0, 0, 19456, 2, 1, 1, 0)`
    ).run(root, key);
    db.query(`INSERT INTO sealed VALUES (?1, 'p', 'n', ?2, 3, NULL)`).run(root, key);
    db.query(`INSERT INTO versions VALUES (?1, 'p', 2, ?2)`).run(root, key);
    db.query(
      `INSERT INTO unlocks (token_hash, root, created_at, last_seen) VALUES (?2, ?1, 4, 5)`
    ).run(root, key);
    db.query(`INSERT INTO devices VALUES (?2, ?1, 6)`).run(root, key);
    db.query(`INSERT INTO shares VALUES (?1, ?1, 'p', ?2, ?2, 7, NULL, 0)`).run(root, key);
  }
  db.run(`DELETE FROM roots WHERE name = 'a'`);
  for (const table of ['sealed', 'versions', 'unlocks', 'devices', 'shares'])
    expect(db.query(`SELECT root FROM ${table}`).all()).toEqual([{ root: 'b' }]);
});

test('a database from a newer release is refused', () => {
  const db = fresh();
  db.run('PRAGMA user_version = 99');
  expect(() => migrate(db)).toThrow('newer release');
});

test('migrating twice changes nothing', () => {
  const db = fresh();
  const before = schema(db);
  migrate(db);
  expect(schema(db)).toEqual(before);
});

test("a root's counts follow every write, as a recount gives them", () => {
  const db = fresh();
  const blob = (n: number) => new Uint8Array(n);
  const counts = () =>
    db
      .query<{ bytes: number; history: number; pads: number }, []>(
        "SELECT bytes, history, pads FROM roots WHERE name = 'r'"
      )
      .get();
  const recount = () =>
    db
      .query<{ bytes: number; history: number; pads: number }, []>(
        `SELECT
           (SELECT coalesce(sum(length(data) + length(name)), 0) FROM sealed WHERE root = 'r') +
           (SELECT coalesce(sum(length(data)), 0) FROM shares WHERE root = 'r') +
           (SELECT coalesce(sum(length(data)), 0) FROM versions WHERE root = 'r') AS bytes,
           (SELECT coalesce(sum(length(data)), 0) FROM versions WHERE root = 'r') AS history,
           (SELECT count(*) FROM sealed WHERE root = 'r') AS pads`
      )
      .get();
  const put = db.query(
    `INSERT INTO sealed (root, id, name, data, updated_at) VALUES ('r', ?1, ?2, ?3, 0)
     ON CONFLICT (root, id) DO UPDATE SET name = ?2, data = ?3`
  );
  db.query(
    `INSERT INTO roots (name, salt, auth_hash, sealed_key, created_at) VALUES ('r', ?1, ?1, ?1, 0)`
  ).run(blob(1));
  const steps = [
    () => put.run('a', 'nn', blob(10)),
    () => put.run('b', 'n', blob(100)),
    () => db.query("INSERT INTO versions VALUES ('r', 'a', 1, ?)").run(blob(20)),
    () => db.query("INSERT INTO versions VALUES ('r', 'b', 1, ?)").run(blob(30)),
    () => put.run('a', 'nnnn', blob(3)),
    () => db.run("UPDATE sealed SET deleted_at = 1 WHERE id = 'b'"),
    () =>
      db
        .query(
          `INSERT INTO shares (id, root, pad, sealed_key, data, created_at)
           VALUES ('s', 'r', 'a', ?1, ?2, 0)`
        )
        .run(blob(1), blob(50)),
    () => db.run("DELETE FROM sealed WHERE id = 'b'"),
    () => db.run('DELETE FROM versions'),
    () => db.run("DELETE FROM shares WHERE id = 's'")
  ];
  for (const step of steps) {
    step();
    expect(counts()).toEqual(recount());
  }
  expect(counts()).toEqual({ bytes: 7, history: 0, pads: 1 });
});
