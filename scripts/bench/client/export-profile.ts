// Where export's memory goes: memory-infra dumps of the page's renderer every
// 250 ms of an export, V8's sampled JS allocation over it, and each process's
// PSS. Tracing itself costs memory: export-pss.ts measures without it.
//
//   bun scripts/bench/client/export-profile.ts <base> <root> <password> avg|max|<chars>
//
// Against a build with the root already seeded; prints JSON.
import { readFileSync } from 'fs';
import { launch } from './harness.ts';
import { floorText } from './text.ts';
const [base, root, password, firstArg] = process.argv.slice(2);
// The root pad's text: the floor shows it, and the pad is open once it's all there.
const text = floorText(firstArg);
const first = text.length;
const port = 9200 + Math.floor(Math.random() * 90);
const dir = `/tmp/pad-export-profile-${port}`;
const trace: any[] = [];
let traceDone: () => void = () => {};
// Whether Chromium dropped trace data: its buffer full, dumps lost.
let dataLoss = false;
const { send, S, ev, until, close } = await launch({
  port,
  dir,
  timeout: 120000,
  onEvent: (d) => {
    if (d.method === 'Tracing.dataCollected') trace.push(...d.params.value);
    else if (d.method === 'Tracing.tracingComplete') {
      dataLoss = !!d.params.dataLossOccurred;
      traceDone();
    }
  }
});

if (base === 'floor' || base === 'floor-read') {
  // The floor: a bare page holding the same kind of text in a plain textarea;
  // floor-read also reads its value on every input, as bind:value does.
  const { frameTree } = await S('Page.getFrameTree');
  await S('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: `<!doctype html><textarea style="width:100vw;height:100vh;font:16px monospace"></textarea>`
  });
  await ev(`(() => {
    const s = ${JSON.stringify(text)};
    const t = document.querySelector('textarea');
    t.value = s;
    t.setSelectionRange(0, 0);
    ${base === 'floor-read' ? `t.addEventListener('input', () => { window.v = t.value; });` : ''}
  })()`);
} else {
  await S('Page.navigate', { url: `${base}/${root}` });
  await until(`!!document.querySelector('input[type=password]')`);
  await ev(`(() => { for (const i of document.querySelectorAll('input[type=password]')) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(password)});
    i.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('input[type=password]').form.requestSubmit(); })()`);
}
await until(
  `(() => { const t = document.querySelector('textarea'); return !!t && t.value.length >= ${first}; })()`
);
await Bun.sleep(1500);
await S('HeapProfiler.enable');
await S('HeapProfiler.collectGarbage');
await Bun.sleep(500);

// Memory dumps on demand, in a trace of memory-infra only.
await send('Tracing.start', {
  transferMode: 'ReportEvents',
  traceConfig: {
    includedCategories: ['disabled-by-default-memory-infra'],
    excludedCategories: ['*'],
    memoryDumpConfig: { triggers: [] }
  }
});
const dumps: string[] = [];
let asked = 0;
let lastGuid: string | null = null;
const dump = async () => {
  const r = await send('Tracing.requestMemoryDump', {
    deterministic: false,
    levelOfDetail: 'detailed'
  });
  asked++;
  lastGuid = r.success ? r.dumpGuid : null;
  if (r.success) dumps.push(r.dumpGuid);
};
await dump();

await S('HeapProfiler.startSampling', {
  samplingInterval: 16384,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true
});
const button = `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'export')`;
await until(`!!${button} && !${button}.disabled`);
await ev(
  `(() => { window.__statuses = []; const s = document.querySelector('[aria-live]'); new MutationObserver(() => window.__statuses.push(s.textContent)).observe(s, { subtree: true, characterData: true, childList: true }); })()`
);
// PSS of each Chromium process every 50 ms, by pid and type, from the click to 1.5 s after.
const pss = (pid: number) => {
  try {
    const t = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const g = (k: string) => +(t.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm'))?.[1] ?? 0);
    return { pss: g('Pss'), anon: g('Pss_Anon'), file: g('Pss_File'), shmem: g('Pss_Shmem') };
  } catch {
    return null;
  }
};
const peaks = new Map<number, any>();
let sampling = true;
(async () => {
  while (sampling) {
    const { processInfo } = await send('SystemInfo.getProcessInfo');
    for (const p of processInfo) {
      const m = pss(p.id);
      if (!m) continue;
      const was = peaks.get(p.id);
      if (!was) peaks.set(p.id, { type: p.type, first: m, peak: m });
      else if (m.pss > was.peak.pss) was.peak = m;
    }
    await Bun.sleep(50);
  }
})();
await Bun.sleep(300);
const t0 = Date.now();
await ev(`${button}.click()`);
// A dump every 250 ms of the export, then one 1.5 s after it. Five minutes
// without one done is an export that won't be: costs.ts waits as long.
while (!(await ev(`(window.__statuses ?? []).some((t) => /^exported|^►/.test(t))`))) {
  if (Date.now() - t0 > 300000) throw new Error('timeout: export');
  await dump();
  await Bun.sleep(250);
}
const status = await ev(`document.querySelector('[aria-live]')?.textContent`);
await Bun.sleep(1500);
await dump();
sampling = false;
const ms = Date.now() - t0;
const { profile } = await S('HeapProfiler.stopSampling');
// A dump reaches the trace only once later ones are taken: the last ones
// before the end never do (on a blank page 2 or 3 of 8, 22 or 30 asked, a 3 s
// wait or not; here 5 of 10 taken 500 ms apart after the run). Ten light
// ones, not counted, carry the run's own through; dumpsLost says if not.
for (let i = 0; i < 10; i++) {
  await Bun.sleep(500);
  await send('Tracing.requestMemoryDump', { deterministic: false, levelOfDetail: 'light' });
}
// Waited for before it's asked: the end can come with Tracing.end's own answer.
const traced = new Promise<void>((r) => (traceDone = r));
await send('Tracing.end');
await traced;

// The renderer's allocators at each dump.
const { processInfo } = await send('SystemInfo.getProcessInfo');
const renderers = new Set(
  processInfo.filter((p: any) => p.type === 'renderer').map((p: any) => p.id)
);
const hex = (v: any) => (typeof v === 'string' ? parseInt(v, 16) : Number(v ?? 0));
type Dump = Record<string, number>;
const byGuid = new Map<string, Map<number, Dump>>();
for (const e of trace) {
  if (e.ph !== 'v' || !e.args?.dumps?.allocators) continue;
  const all: Record<string, any> = e.args.dumps.allocators;
  const d: Dump = {};
  for (const [name, a] of Object.entries(all)) {
    // Top-level allocators, and partition_alloc's and blink_gc's partitions, by their own size.
    const parts = name.split('/');
    const keep =
      parts.length === 1 ||
      (parts[0] === 'partition_alloc' && parts[1] === 'partitions' && parts.length === 3) ||
      (parts[0] === 'v8' && parts[1] === 'main' && parts[2] === 'heap' && parts.length === 4);
    if (keep && a.attrs?.size) d[name] = hex(a.attrs.size.value);
  }
  const m = byGuid.get(e.id) ?? new Map();
  m.set(e.pid, d);
  byGuid.set(e.id, m);
}
// The page's renderer: the one whose v8 grew the most.
const series = dumps.map((g) => byGuid.get(g)).filter(Boolean) as Map<number, Dump>[];
let pid = 0;
let grew = -1;
for (const p of renderers) {
  const v = series.map((m) => m.get(p as number)?.v8 ?? 0);
  const g = Math.max(...v) - v[0];
  if (g > grew) [grew, pid] = [g, p as number];
}
const total = (d: Dump) =>
  Object.entries(d)
    .filter(([k]) => !k.includes('/'))
    .reduce((a, [, v]) => a + v, 0);
const own = series.map((m) => m.get(pid) ?? {});
const peakAt = own.reduce((best, d, i) => (total(d) > total(own[best]) ? i : best), 0);
const mib = (n: number) => +(n / 2 ** 20).toFixed(2);
const names = [...new Set(own.flatMap((d) => Object.keys(d)))].sort();
const allocators = Object.fromEntries(
  names
    .map(
      (n) =>
        [
          n,
          {
            before: mib(own[0][n] ?? 0),
            peak: mib(Math.max(...own.map((d) => d[n] ?? 0))),
            after: mib(own.at(-1)![n] ?? 0)
          }
        ] as const
    )
    .filter(([, v]) => Math.max(v.before, v.peak, v.after) >= 0.5)
    .sort((a, b) => b[1].peak - b[1].before - (a[1].peak - a[1].before))
);

// JS allocation by function over the whole typing run.
const fns = new Map<string, number>();
const walk = (n: any) => {
  const f = n.callFrame;
  const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
  fns.set(key, (fns.get(key) ?? 0) + n.selfSize);
  for (const c of n.children) walk(c);
};
walk(profile.head);
const allocated = [...fns.values()].reduce((a, b) => a + b, 0);
const topJs = [...fns.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 15)
  .map(([k, v]) => [k, mib(v)]);

console.log(
  JSON.stringify(
    {
      base,
      root,
      ms,
      status,
      dumpsAsked: asked,
      dumpsTaken: dumps.length,
      dumps: own.length,
      // Which of the dumps taken never reached the trace, by their order.
      dumpsLost: dumps.flatMap((g, i) => (byGuid.has(g) ? [] : [i])),
      dataLoss,
      // "after" is the last dump only if that one reached the trace.
      afterIsLastDump: !!lastGuid && byGuid.has(lastGuid),
      peakDump: peakAt,
      rendererTotalMiB: {
        before: mib(total(own[0])),
        peak: mib(total(own[peakAt])),
        after: mib(total(own.at(-1)!))
      },
      allocators,
      pssKiB: [...peaks].map(([pid, v]) => ({ pid, ...v })),
      overTime: own.map((d) => mib(total(d))),
      jsAllocatedMiB: mib(allocated),
      topJsAllocators: topJs
    },
    null,
    1
  )
);
await close();
process.exit(0);
