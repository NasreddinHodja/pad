// SQLite on this machine's disk, with db.ts's pragmas: new and overwritten
// blobs of pad sizes, and the quota's sum over 2,000 rows. Writes about 2 GiB
// to the file given, then deletes it.
//
//   bun scripts/bench/sqlite.ts /var/tmp/pad-bench.db
//
// Results are in docs/architecture/capacity.org.
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
const file = process.argv[2];
for (const f of [file, file + '-wal', file + '-shm']) rmSync(f, { force: true });
const db = new Database(file, { strict: true });
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');
db.run(
  'CREATE TABLE sealed (root TEXT, id TEXT, name TEXT, data BLOB, updated_at INTEGER, PRIMARY KEY (root, id))'
);
const put = db.query(
  `INSERT INTO sealed VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(root, id) DO UPDATE SET data = ?4, updated_at = ?5`
);
const sum = db.query('SELECT sum(length(data)) b, count(*) n FROM sealed WHERE root = ?');
function run(label: string, size: number, n: number, sameId: boolean) {
  const data = crypto.getRandomValues(new Uint8Array(size));
  const t = performance.now();
  for (let i = 0; i < n; i++)
    put.run('r', sameId ? 'x' : 'id' + i + label, 'n'.repeat(64), data, i);
  const s = (performance.now() - t) / 1000;
  console.log(
    label,
    `${(n / s).toFixed(0)} writes/s`,
    `${((n * size) / s / 2 ** 20).toFixed(0)} MiB/s`
  );
}
run('3KiB overwrite', 3 * 1024, 20000, true);
run('512KiB overwrite', 512 * 1024, 2000, true);
run('512KiB new rows', 512 * 1024, 2000, false);
const t = performance.now();
for (let i = 0; i < 1000; i++) sum.get('r');
console.log(
  'quota sum over',
  sum.get('r'),
  ((performance.now() - t) / 1000).toFixed(3) + 'ms each'
);
db.close();
for (const f of [file, file + '-wal', file + '-shm']) rmSync(f, { force: true });
