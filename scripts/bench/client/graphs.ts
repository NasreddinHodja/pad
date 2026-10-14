// client.org's graphs, as SVG from the raw results: pad among other sites
// (results-2026-10-12/), and pad against the bare textarea holding the same
// text, at rest and typing (results-2026-10-14/). Light and dark follow the
// reader's system.
//
//   bun scripts/bench/client/graphs.ts
//
// Writes docs/architecture/graphs/client-*.svg.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bars, page, type Bar } from '../svg.ts';

const here = import.meta.dir;
const out = join(here, '../../../docs/architecture/graphs');
const jsonl = (file: string, dir = 'results-2026-10-12') =>
  readFileSync(join(here, dir, file), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));

mkdirSync(out, { recursive: true });

// Pad among other sites: the renderers above blank, idle, each in a fresh profile.
const names: Record<string, string> = {
  'http://localhost:5601/': 'pad, landing page',
  'http://localhost:5601/avgroot': 'pad, password page',
  'https://news.ycombinator.com/': 'Hacker News',
  'https://lite.duckduckgo.com/lite/': 'lite.duckduckgo.com',
  'https://text.npr.org/': 'text.npr.org',
  'https://sr.ht/': 'sourcehut',
  'https://privatebin.net/': 'PrivateBin',
  'https://dontpad.com/': 'dontpad',
  'https://en.wikipedia.org/wiki/Notepad': 'Wikipedia, "Notepad"',
  'https://github.com/NasreddinHodja/pad.nassu.online': "pad's GitHub page",
  'https://www.youtube.com/': 'YouTube',
  'https://www.google.com/': 'google.com'
};
const sites: Bar[] = jsonl('sites.jsonl')
  .map((d): Bar => ({
    label: names[d.url] ?? d.url,
    value: Math.round((d.open.rendererMiB - d.blank.rendererMiB) * 10) / 10,
    kind: d.url.startsWith('http://localhost') ? 'accent' : 'context'
  }))
  .sort((a, b) => a.value - b.value);
{
  const { svg, height } = bars(sites, { x: 180, y: 72, width: 420, max: 130, unit: ' MiB' });
  writeFileSync(
    join(out, 'client-sites.svg'),
    page(
      720,
      72 + height + 12,
      'Memory a page takes, idle, above a blank page',
      'Chromium 153, renderers’ PSS, one run each: results-2026-10-12/sites.jsonl',
      svg
    )
  );
}

const NOW = 'results-2026-10-14';
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1];
const r1 = (n: number) => Math.round(n * 10) / 10;
const ROOTS = [
  ['avg', 'average root (249,000 characters)'],
  ['max', 'max root (507,903 characters)']
] as const;

// What a page keeps at rest, above a blank page: pad and the bare textarea
// with the same text, the median of three runs.
{
  const floor = jsonl('floor.jsonl', NOW).filter((d) => d.mode === 'headless');
  const drive = jsonl('drive.jsonl', NOW).filter((d) => d.mode === 'headless');
  const above = (d: any) => d.open.rendererMiB - d.blank.rendererMiB;
  const rows: Bar[] = [];
  for (const [label, pad, bare] of [
    ['empty', 'claim', '0'],
    ['average root', 'avg-type', 'avg'],
    ['max root', 'max-type', 'max']
  ]) {
    const p = r1(median(drive.filter((d) => d.scenario === pad).map(above)));
    const f = r1(median(floor.filter((d) => d.text === bare).map(above)));
    rows.push({ label: `${label}: pad`, value: p, kind: 'accent' });
    rows.push({ label: `${label}: bare textarea`, value: f, kind: 'context' });
  }
  const { svg, height } = bars(rows, { x: 220, y: 72, width: 400, max: 80, unit: ' MiB' });
  writeFileSync(
    join(out, 'client-rest.svg'),
    page(
      720,
      72 + height + 12,
      'Memory an open page keeps, at rest, above a blank page',
      `Chromium 154, renderers’ PSS, median of 3 runs: ${NOW}/{drive,floor}.jsonl`,
      svg
    )
  );
}

// Typing 500 keys at the end of the root pad, one every 30 ms (15 s of keys):
// pad's three runs against the bare textarea with the same text.
{
  const cpu = jsonl('cpu.jsonl', NOW);
  const floor = jsonl('floor-cpu.jsonl', NOW);
  let body = '';
  let y = 92;
  for (const [root, label] of ROOTS) {
    const rows = cpu
      .filter((d) => d.root === root)
      .map((d): Bar => ({
        label: `pad, run ${d.rep}`,
        value: d.typing500.seconds,
        kind: 'accent'
      }));
    const bare = median(floor.filter((d) => d.text === root).map((d) => d.typing500AtEnd.seconds));
    body += `<text x="16" y="${y - 22}" class="muted">${label}</text>`;
    const panel = bars(rows, {
      x: 220,
      y,
      width: 400,
      max: 30,
      unit: ' s',
      reference: { value: bare, label: `bare textarea, ${bare} s` }
    });
    body += panel.svg;
    y += panel.height + 52;
  }
  writeFileSync(
    join(out, 'client-typing.svg'),
    page(
      720,
      y - 30,
      'Seconds to type 500 keys, one every 30 ms',
      `The keys alone take 15 s; past that, the page lags the typist. ${NOW}/{cpu,floor-cpu}.jsonl`,
      body
    )
  );
}
