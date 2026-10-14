// What a save costs in SQLite, through db.ts's putSealed with its triggers
// and, from 8c4d2c0, its kept versions: 20,000 saves of 3 KiB over 500 pads
// of one root, in memory. Takes the src/lib to measure, so two trees can be
// compared (a checkout of each, e.g. from `git archive <rev> src/lib`):
//
//   bun scripts/bench/saves.ts <dir with src/lib>
//
// Results are in docs/architecture/capacity.org.
import { resolve } from 'node:path';

process.env.PAD_DB = ':memory:';
const dir = resolve(process.argv[2]);
const { db, putSealed } = await import(`${dir}/src/lib/server/db.ts`);

db.query(
  `INSERT INTO roots (name, salt, auth_hash, sealed_key, created_at) VALUES ('r', x'00', x'00', x'00', 0)`
).run();
const data = crypto.getRandomValues(new Uint8Array(3 * 1024));
const SAVES = 20_000;
const PADS = 500;
const t = performance.now();
for (let i = 0; i < SAVES; i++) putSealed('r', 'pad' + (i % PADS), 'name', data);
console.log(`${(((performance.now() - t) / SAVES) * 1000).toFixed(1)} µs a save`);
