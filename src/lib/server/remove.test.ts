// scripts/remove.ts, run as an operator would, on a database file of its own.
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from './schema.ts';

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const LINK = 'L'.repeat(22);
const OTHER = 'M'.repeat(22);
// Bytes to look for in the file once they're removed.
const MARK = new TextEncoder().encode('pad-remove-test-mark');

function database() {
  dir = mkdtempSync(join(tmpdir(), 'pad-remove-'));
  const file = join(dir, 'pad.db');
  const db = new Database(file, { strict: true });
  db.run('PRAGMA journal_mode = WAL');
  migrate(db);
  db.run('PRAGMA foreign_keys = ON');
  const key = new Uint8Array(1);
  for (const root of ['bad', 'fine']) {
    db.query(
      'INSERT INTO roots (name, salt, auth_hash, sealed_key, created_at) VALUES (?1, ?2, ?2, ?2, 1)'
    ).run(root, key);
    db.query(`INSERT INTO sealed VALUES (?, 'p', 'n', ?, 1, NULL)`).run(root, MARK);
    db.query(`INSERT INTO unlocks VALUES (?, ?, 1, 1)`).run(key, root);
  }
  db.query(`INSERT INTO shares VALUES (?, 'bad', 'p', ?2, ?2, 1, NULL, 0)`).run(LINK, MARK);
  db.query(`INSERT INTO shares VALUES (?, 'bad', 'p', ?2, ?2, 1, NULL, 0)`).run(OTHER, key);
  db.close();
  return file;
}

function remove(file: string, ...args: string[]) {
  const run = Bun.spawnSync(['bun', 'scripts/remove.ts', file, ...args]);
  return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString() };
}

const rows = (file: string, sql: string) => {
  const db = new Database(file, { readonly: true });
  const all = db.query(sql).all();
  db.close();
  return all;
};

/** Whether `bytes` is anywhere in the file or its WAL. */
function holds(file: string, bytes: Uint8Array) {
  const text = (path: string) => {
    try {
      return readFileSync(path).toString('latin1');
    } catch {
      return '';
    }
  };
  const needle = Buffer.from(bytes).toString('latin1');
  return text(file).includes(needle) || text(file + '-wal').includes(needle);
}

test('a root, named by a pad address written another way, goes with all of its own', () => {
  const file = database();
  expect(holds(file, MARK)).toBe(true);
  const { code, out } = remove(file, 'root', 'https://pad.example/B%41d/Some/Pad');
  expect(code).toBe(0);
  expect(out).toContain('removed /bad: 1 pads, 2 links');
  expect(rows(file, 'SELECT name FROM roots')).toEqual([{ name: 'fine' }]);
  expect(rows(file, "SELECT root FROM sealed WHERE root = 'bad'")).toEqual([]);
  expect(rows(file, "SELECT root FROM unlocks WHERE root = 'bad'")).toEqual([]);
  expect(rows(file, 'SELECT id FROM shares')).toEqual([]);
  // The other root's pad still holds the mark: take it out to check the file.
  expect(remove(file, 'root', 'fine').code).toBe(0);
  expect(holds(file, MARK)).toBe(false);
});

test('a link, by the address a reporter sends, goes alone', () => {
  const file = database();
  const { code, out } = remove(file, 'link', `https://pad.example/_/bad/s/${LINK}#somekey`);
  expect(code).toBe(0);
  expect(out).toContain(`removed link ${LINK} of /bad`);
  expect(rows(file, 'SELECT id FROM shares')).toEqual([{ id: OTHER }]);
  expect(rows(file, 'SELECT name FROM roots')).toHaveLength(2);
  expect(remove(file, 'link', OTHER).code).toBe(0);
});

test('a link of the old form, with a place in the copy after its id, too', () => {
  const file = database();
  const { code, out } = remove(file, 'link', `https://pad.example/_/bad/s/${LINK}/a/b#somekey`);
  expect(code).toBe(0);
  expect(out).toContain(`removed link ${LINK} of /bad`);
});

test('what is not there, or is not a name, is said and changes nothing', () => {
  const file = database();
  expect(remove(file, 'root', 'nobody')).toMatchObject({ code: 1, out: 'no root /nobody\n' });
  expect(remove(file, 'link', 'N'.repeat(22)).code).toBe(1);
  expect(remove(file, 'link', 'short').code).toBe(2);
  expect(remove(file, 'root', '_').code).toBe(2);
  expect(remove(file, 'pad', 'bad').code).toBe(2);
  expect(rows(file, 'SELECT name FROM roots')).toHaveLength(2);
});
