// Where typing's memory goes: Chromium's memory-infra dumps of the page's
// renderer (by allocator) before and at the peak of typing, and V8's sampling
// heap profile of what JS allocated while typing, collected objects included.
//
//   bun scripts/bench/client/typing-profile.ts <base> <root> <password> <chars of the root pad>
//
// Against a build with the root already seeded; prints JSON.
const [base, root, password, firstArg] = process.argv.slice(2);
const first = Number(firstArg);
const port = 9200 + Math.floor(Math.random() * 90);
const dir = `/tmp/pad-typing-profile-${port}`;
const chrome = Bun.spawn(
  [
    'chromium',
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--disable-extensions',
    '--disable-features=SpareRendererForSitePerProcess',
    'about:blank'
  ],
  { stderr: 'ignore', stdout: 'ignore' }
);
// Whatever ends this script, the browser and its profile go with it: one left
// running shares its pages and CPU with the next measurement.
const closeBrowser = () => {
  try {
    chrome.kill();
  } catch {
    // Already gone.
  }
  Bun.spawnSync(['rm', '-rf', dir]);
};
process.on('exit', closeBrowser);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(130));
for (const event of ['uncaughtException', 'unhandledRejection'] as const)
  process.on(event, (e) => {
    console.error(e);
    process.exit(1);
  });
let ver: any;
for (let i = 0; i < 100 && !ver; i++) {
  await Bun.sleep(100);
  ver = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then((r) => r.json())
    .catch(() => null);
}
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
// The browser gone, nothing left to measure: stop, rather than wait forever.
ws.onclose = () => process.exit(1);
let id = 0;
const pending = new Map<number, (d: any) => void>();
const trace: any[] = [];
let traceDone: () => void = () => {};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data as string);
  if (d.id) {
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  } else if (d.method === 'Tracing.dataCollected') trace.push(...d.params.value);
  else if (d.method === 'Tracing.tracingComplete') traceDone();
};
const send = (method: string, params: any = {}, sessionId?: string): Promise<any> =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (d) =>
      d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result)
    );
    ws.send(JSON.stringify({ id: i, method, params, sessionId }));
  });
const { targetInfos } = await send('Target.getTargets');
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
for (const t of targetInfos)
  if (t.type === 'page') await send('Target.closeTarget', { targetId: t.targetId });
const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
const S = (m: string, p: any = {}) => send(m, p, s);

// A key as a keyboard sends it (keyDown/keyUp), not Input.insertText: that one
// takes Chromium's IME commit path, ~43× slower a key at the end of a long
// textarea (typing-path.ts), which no keyboard pays.
async function typeKey(ch: string) {
  const enter = ch === '\n';
  const code = enter
    ? 'Enter'
    : ch === '/'
      ? 'Slash'
      : /\d/.test(ch)
        ? 'Digit' + ch
        : 'Key' + ch.toUpperCase();
  const vk = enter ? 13 : ch === '/' ? 191 : ch.toUpperCase().charCodeAt(0);
  const key = enter ? 'Enter' : ch;
  await S('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key,
    code,
    windowsVirtualKeyCode: vk,
    text: enter ? '\r' : ch
  });
  await S('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
}

await S('Page.enable');
await S('Runtime.enable');
const ev = async (expr: string) =>
  (await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
    .result.value;
async function until(expr: string, ms = 120000) {
  const t = Date.now();
  while (!(await ev(expr))) {
    if (Date.now() - t > ms) throw new Error('timeout: ' + expr);
    await Bun.sleep(50);
  }
}

if (base === 'floor' || base === 'floor-read') {
  // The floor: a bare page holding the same kind of text in a plain textarea;
  // floor-read also reads its value on every input, as bind:value does.
  const { frameTree } = await S('Page.getFrameTree');
  await S('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: `<!doctype html><textarea style="width:100vw;height:100vh;font:16px monospace"></textarea>`
  });
  await ev(`(() => {
    const words = 'the of and to in is that it for on as with was his by at from this be or have an are not but had they you were which her one all their there can been'.split(' ');
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let s = '';
    while (s.length < ${first}) s += words[Math.floor(rnd() * words.length)] + (rnd() < 0.1 ? '\\n' : ' ');
    const t = document.querySelector('textarea');
    t.value = s.slice(0, ${first});
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
const dump = async () => {
  const r = await send('Tracing.requestMemoryDump', {
    deterministic: false,
    levelOfDetail: 'detailed'
  });
  if (r.success) dumps.push(r.dumpGuid);
};
await dump();

await S('HeapProfiler.startSampling', {
  samplingInterval: 16384,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true
});
await ev(`document.querySelector('textarea').focus()`);
const t0 = Date.now();
for (let i = 0; i < 2000; i++) {
  await typeKey(i % 60 === 59 ? '\n' : 'a');
  await Bun.sleep(30);
  if (i % 100 === 99) await dump();
}
await Bun.sleep(1500);
await dump();
const typingMs = Date.now() - t0;
const { profile } = await S('HeapProfiler.stopSampling');
await send('Tracing.end');
await new Promise<void>((r) => (traceDone = r));

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
            peak: mib(own[peakAt][n] ?? 0),
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
      typingMs,
      dumps: own.length,
      peakDump: peakAt,
      rendererTotalMiB: {
        before: mib(total(own[0])),
        peak: mib(total(own[peakAt])),
        after: mib(total(own.at(-1)!))
      },
      allocators,
      jsAllocatedWhileTypingMiB: mib(allocated),
      topJsAllocators: topJs
    },
    null,
    1
  )
);
chrome.kill();
await chrome.exited;
Bun.spawnSync(['rm', '-rf', dir]);
process.exit(0);
