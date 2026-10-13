// capacity.org's graph, as SVG from the raw results in results/: page loads
// a second, a page rendered on the server against a shell and its data.
//
//   bun scripts/bench/graphs.ts
//
// Writes docs/architecture/graphs/capacity-*.svg.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bars, page, type Bar } from './svg.ts';

const here = import.meta.dir;
const out = join(here, '../../docs/architecture/graphs');

const runs: { build: string; load: string; perSecond: number }[] = readFileSync(
  join(here, 'results/loads.jsonl'),
  'utf8'
)
  .split('\n')
  .filter((l) => l.startsWith('{'))
  .map((l) => JSON.parse(l));

/** The runs' mean, and each run, for one build's load. */
function bar(label: string, build: string, load: string, kind: Bar['kind']): Bar {
  const each = runs.filter((r) => r.build === build && r.load === load).map((r) => r.perSecond);
  if (!each.length) throw new Error(`no runs of ${build}, ${load}`);
  const value = Math.round(each.reduce((a, b) => a + b, 0) / each.length);
  const n = (v: number) => v.toLocaleString('en');
  return { label, value, kind, text: `${n(value)} (${each.map(n).join(', ')})` };
}

// What a browser asks for before the page shows: a rendered page is one
// request; a shell is one, then its data (/ has none).
const groups: [string, Bar[]][] = [
  [
    '/, which loads no data',
    [bar('rendered', 'rendered', 'home', 'accent'), bar('shell', 'shell', 'home', 'second')]
  ],
  [
    'a claimed root',
    [
      bar('rendered', 'rendered', 'a claimed root', 'accent'),
      bar('shell, then its data', 'shell', 'a claimed root, then its data', 'second')
    ]
  ],
  [
    'an unclaimed root',
    [
      bar('rendered', 'rendered', 'an unclaimed root', 'accent'),
      bar('shell, then its data', 'shell', 'an unclaimed root, then its data', 'second')
    ]
  ]
];

const control = ['rendered', 'shell']
  .map((b) => bar('', b, 'control: robots.txt', 'context').value.toLocaleString('en'))
  .join(' / ');

mkdirSync(out, { recursive: true });
let body = '';
let y = 92;
const max = Math.max(...groups.flatMap(([, rows]) => rows.map((r) => r.value)));
for (const [label, rows] of groups) {
  body += `<text x="16" y="${y - 10}" class="muted">${label}</text>`;
  const panel = bars(rows, { x: 180, y, width: 360, max, unit: '' });
  body += panel.svg;
  y += panel.height + 34;
}
writeFileSync(
  join(out, 'capacity-loads.svg'),
  page(
    720,
    y - 20,
    'Page loads a second: rendered, or a shell and its data',
    `Laptop, 8 at a time, fresh addresses; mean (each run). Control, robots.txt: ${control}`,
    body
  )
);
