// What padding sealed pads to size steps would cost, and how many distinct
// sizes would still show, over one root's live pads in a copy of the
// database. Read-only. Each step function pads the plaintext plus a 1-byte
// end marker (as Signal's 0x80), then adds the seal's 28 bytes.
//
//   bun scripts/bench/padding.ts data/pad.db nassu
//
// Results are in docs/architecture/encryption.org, Padding.
import { Database } from 'bun:sqlite';
const db = new Database(process.argv[2], { readonly: true });
const rows = db
  .query('SELECT length(data) d, length(name) n FROM sealed WHERE root=?1 AND deleted_at IS NULL')
  .all(process.argv[3]) as { d: number; n: number }[];
const T = 28; // nonce + tag
const padme = (L: number) => {
  if (L < 2) return L;
  const E = Math.floor(Math.log2(L));
  const S = Math.floor(Math.log2(E)) + 1;
  const z = E - S;
  const m = (1 << z) - 1;
  return (L + m) & ~m;
};
const p2 = (min: number) => (L: number) => Math.max(min, 2 ** Math.ceil(Math.log2(Math.max(L, 1))));
const blk = (b: number) => (L: number) => Math.max(b, b * Math.ceil(L / b));
const fns: Record<string, (L: number) => number> = {
  none: (L) => L,
  Padmé: padme,
  'Padmé min 256': (L) => padme(Math.max(L, 256)),
  'pow2 min 256': p2(256),
  'blocks 80 (Signal)': blk(80),
  'blocks 4096': blk(4096),
  'Padmé min 64': (L) => padme(Math.max(L, 64)),
  'Padmé min 128': (L) => padme(Math.max(L, 128))
};
// +1 byte: an end marker inside the seal, as Signal's 0x80, so the browser can strip the padding
for (const [label, col] of [
  ['text', 'd'],
  ['name', 'n']
] as const) {
  const Ls = rows.map((r) => r[col] - T);
  const raw = Ls.reduce((a, b) => a + b + T, 0);
  console.log(
    `\n${label}: ${rows.length} rows, ${raw} B sealed now, max plaintext ${Math.max(...Ls)}`
  );
  for (const [k, f] of Object.entries(fns)) {
    const out = Ls.map((L) => (k === 'none' ? L : f(L + 1)) + T);
    const tot = out.reduce((a, b) => a + b, 0);
    const counts = new Map<number, number>();
    for (const s of out) counts.set(s, (counts.get(s) ?? 0) + 1);
    const unique = [...counts.values()].filter((c) => c === 1).length;
    console.log(
      `${k.padEnd(20)} ${String(tot).padStart(9)} B  ${((tot / raw - 1) * 100).toFixed(1).padStart(7)}%  sizes ${String(counts.size).padStart(4)}  unique ${unique} (${((unique / out.length) * 100).toFixed(0)}%)`
    );
  }
}
