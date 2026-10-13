// A copy of pad's database, taken while it runs: VACUUM INTO reads one
// consistent snapshot, with what's committed in the WAL, and syncs the copy
// to disk before it returns (sqlite.org/lang_vacuum.html). The copy is
// checked, then only the newest `keep` copies stay. Needs nothing but Bun.
//
//   bun scripts/backup.ts data/pad.db backups [keep=7]
//
// What a copy holds and how to restore one: docs/guide/install.org, Backups.
import { Database } from 'bun:sqlite';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [file, dir, keep = '7'] = process.argv.slice(2);
if (!file || !dir || !(Number(keep) >= 1)) {
  console.error('usage: bun backup.ts <pad.db> <directory> [copies to keep, 7]');
  process.exit(2);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });
const out = join(dir, `pad-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new Database(file, { readonly: true });
db.run('VACUUM INTO ?', [out]);
db.close();

const copy = new Database(out, { readonly: true });
const check = copy.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
copy.close();
if (check.length !== 1 || check[0].integrity_check !== 'ok') {
  rmSync(out);
  console.error(`the copy failed its integrity check, deleted: ${JSON.stringify(check)}`);
  process.exit(1);
}

const copies = readdirSync(dir)
  .filter((name) => /^pad-.*\.db$/.test(name))
  .sort();
for (const name of copies.slice(0, -Number(keep))) rmSync(join(dir, name));
console.log(out);
