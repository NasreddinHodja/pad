// bun floor-cpu.ts <chars>   env: MOBILE=1
// The control for cpu.ts and drive.ts: the same phases on a bare page with a plain textarea holding <chars> of seed.ts's kind of text.
// split between the processes sharing them) summed per Chromium process type.
import { readFileSync } from 'fs';
const [base, scenario] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const chrome = Bun.spawn(
  [
    'chromium',
    ...(process.env.HEADED ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
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
const events: any[] = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data as string);
  if (d.id) {
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  } else events.push(d);
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
await S('Network.enable');
await send('Browser.setDownloadBehavior', { behavior: 'deny' });
if (process.env.MOBILE) {
  // A mid-range Android phone: Pixel 7's viewport, a 4x slower CPU.
  await S('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true
  });
  await S('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36'
  });
  await S('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await S('Emulation.setCPUThrottlingRate', { rate: 4 });
}
const ev = async (expr: string) =>
  (await S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }))
    .result.value;

const kib = (pid: number) => {
  try {
    return +readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)![1];
  } catch {
    return 0;
  }
};
async function byType() {
  const { processInfo } = await send('SystemInfo.getProcessInfo');
  const out: Record<string, number> = {};
  for (const p of processInfo) out[p.type] = (out[p.type] ?? 0) + kib(p.id);
  return out;
}
const mib = (k: number) => +(k / 1024).toFixed(1);
const sum = (t: Record<string, number>) => Object.values(t).reduce((a, b) => a + b, 0);
let peak = 0;
let peakTotal = 0;
let sampling = false;
async function sample() {
  sampling = true;
  peak = 0;
  peakTotal = 0;
  while (sampling) {
    const t = await byType();
    peak = Math.max(peak, t.renderer ?? 0);
    peakTotal = Math.max(peakTotal, sum(t));
    // Every 100 ms: reading every process's memory costs the machine being measured.
    await Bun.sleep(100);
  }
}
const stop = () => {
  sampling = false;
  return { renderer: mib(peak), total: mib(peakTotal) };
};
async function steady() {
  await Bun.sleep(1500);
  await S('HeapProfiler.enable');
  await S('HeapProfiler.collectGarbage');
  await S('HeapProfiler.collectGarbage');
  await Bun.sleep(500);
  const h = await S('Runtime.getHeapUsage');
  const dom = await S('Memory.getDOMCounters');
  const t = await byType();
  return {
    rendererMiB: mib(t.renderer ?? 0),
    gpuMiB: mib(t.GPU ?? 0),
    browserMiB: mib(t.browser ?? 0),
    otherMiB: mib(sum(t) - (t.renderer ?? 0) - (t.GPU ?? 0) - (t.browser ?? 0)),
    totalMiB: mib(sum(t)),
    jsHeapMiB: +(h.usedSize / 2 ** 20).toFixed(2),
    buffersMiB: +((h.backingStorageSize ?? 0) / 2 ** 20).toFixed(2),
    nodes: dom.nodes
  };
}

// CPU and rendering work per phase of using the app: Chromium's own counters
// (Performance.getMetrics) and each process type's CPU seconds.
await S('Performance.enable', { timeDomain: 'threadTicks' });
async function counters() {
  const { metrics } = await S('Performance.getMetrics');
  const m: Record<string, number> = Object.fromEntries(metrics.map((x: any) => [x.name, x.value]));
  const { processInfo } = await send('SystemInfo.getProcessInfo');
  const cpu: Record<string, number> = {};
  for (const p of processInfo) cpu[p.type] = (cpu[p.type] ?? 0) + p.cpuTime;
  return { m, cpu, t: Date.now() };
}
const KEYS = [
  'LayoutCount',
  'RecalcStyleCount',
  'LayoutDuration',
  'RecalcStyleDuration',
  'ScriptDuration',
  'TaskDuration',
  'JSHeapUsedSize',
  'Nodes'
];
async function phase(name: string, run: () => Promise<unknown>) {
  const a = await counters();
  sample();
  await run();
  const peakMiB = stop();
  const b = await counters();
  const secs = (b.t - a.t) / 1000;
  const r: any = { seconds: +secs.toFixed(1), peakMiB };
  for (const k of KEYS) {
    const d = (b.m[k] ?? 0) - (a.m[k] ?? 0);
    r[k] = k.endsWith('Duration')
      ? +(d * 1000).toFixed(0) + ' ms'
      : k === 'JSHeapUsedSize'
        ? +(d / 2 ** 20).toFixed(2) + ' MiB'
        : d;
  }
  // CPU time per process type, as a share of one core over the phase.
  r.cpuPctOfCore = Object.fromEntries(
    Object.keys(b.cpu)
      .map((k) => [k, +((100 * (b.cpu[k] - (a.cpu[k] ?? 0))) / secs).toFixed(1)])
      .filter(([, v]) => (v as number) > 0.1)
  );
  out[name] = r;
  console.error(name, JSON.stringify(r));
}
const chars = Number(scenario ?? base);
const out: any = { floor: chars, mode: process.env.MOBILE ? 'headless+mobile' : 'headless' };
const IDLE = 20000;
await phase('blankIdle', () => Bun.sleep(IDLE));
await phase('open', async () => {
  const { frameTree } = await S('Page.getFrameTree');
  await S('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: `<!doctype html><meta name=viewport content="width=device-width"><textarea style="width:100vw;height:100vh;font:16px monospace"></textarea>`
  });
  await ev(`(() => {
    const words = 'the of and to in is that it for on as with was his by at from this be or have an are not but had they you were which her one all their there can been'.split(' ');
    let seed = 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let s = '';
    while (s.length < ${chars}) s += words[Math.floor(rnd() * words.length)] + (rnd() < 0.1 ? '\\n' : ' ');
    document.querySelector('textarea').value = s.slice(0, ${chars});
  })()`);
});
out.atRest = await steady();
await phase('idleNoFocus', async () => {
  await ev(`document.activeElement?.blur()`);
  await Bun.sleep(IDLE);
});
await phase('idleFocused', async () => {
  await ev(
    `(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(0, 0); })()`
  );
  await Bun.sleep(IDLE);
});
const before2000 = await ev(`(document.querySelector("textarea")?.value.length ?? -1)`);
await phase('typing2000AtStart', async () => {
  for (let i = 0; i < 2000; i++) {
    await typeKey(i % 60 === 59 ? '\n' : 'a');
    await Bun.sleep(30);
  }
});
out.typed2000 = (await ev(`(document.querySelector("textarea")?.value.length ?? -1)`)) - before2000;
out.afterTypingAtStart = await steady();
await phase('caretAtEnd', async () => {
  await ev(
    `(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`
  );
  await Bun.sleep(IDLE);
});
const before500 = await ev(`(document.querySelector("textarea")?.value.length ?? -1)`);
await phase('typing500AtEnd', async () => {
  for (let i = 0; i < 500; i++) {
    await typeKey(i % 60 === 59 ? '\n' : 'a');
    await Bun.sleep(30);
  }
});
out.typed500 = (await ev(`(document.querySelector("textarea")?.value.length ?? -1)`)) - before500;
await phase('hiddenTab', async () => {
  const { targetId: other } = await send('Target.createTarget', { url: 'about:blank' });
  await send('Target.activateTarget', { targetId: other });
  await Bun.sleep(IDLE);
  await send('Target.closeTarget', { targetId: other });
  await send('Target.activateTarget', { targetId });
});
console.log(JSON.stringify(out));
chrome.kill();
await chrome.exited;
Bun.spawnSync(['rm', '-rf', dir]);
process.exit(0);
