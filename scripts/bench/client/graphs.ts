// client.org's graphs, as SVG from the raw results in results-2026-10-12/:
// pad among other sites, and typing time per build against the bare
// textarea. Light and dark follow the reader's system.
//
//   bun scripts/bench/client/graphs.ts
//
// Writes docs/architecture/graphs/client-*.svg.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bars, page, type Bar } from '../svg.ts';

const here = import.meta.dir;
const out = join(here, '../../../docs/architecture/graphs');
const results = join(here, 'results-2026-10-12');

const jsonl = (file: string) =>
  readFileSync(join(results, file), 'utf8')
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

// Typing 500 keys at the end of the root pad, one every 30 ms (15 s of keys):
// each build against the bare textarea with the same text.
const cpu = jsonl('cpu.jsonl');
const floor = jsonl('floor-cpu.jsonl');
const builds: Record<string, string> = {
  old: 'old: the JS caret',
  cheap: 'cheap: a lighter JS caret',
  native: 'native: the browser’s (shipped)'
};
{
  let body = '';
  let y = 92;
  for (const [root, chars, label] of [
    ['avg', 249000, 'average root (249,000 characters)'],
    ['max', 524224, 'max root (524,224 characters)']
  ] as const) {
    const rows = cpu
      .filter((d) => d.root === root)
      .map((d): Bar => ({
        label: builds[d.build],
        value: d.typing500.seconds,
        kind: d.build === 'native' ? 'accent' : 'context'
      }));
    const bare = floor.find((d) => d.floor === chars).typing500AtEnd.seconds;
    body += `<text x="16" y="${y - 22}" class="muted">${label}</text>`;
    const panel = bars(rows, {
      x: 220,
      y,
      width: 400,
      max: 80,
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
      'The keys alone take 15 s; past that, the page lags the typist. results-2026-10-12/{cpu,floor-cpu}.jsonl',
      body
    )
  );
}
