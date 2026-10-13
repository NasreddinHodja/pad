// bun floor.ts <chars>   env: MOBILE=1
// The control: a bare page with a plain textarea holding <chars> of the same kind of text as seed.ts.
// split between the processes sharing them) summed per Chromium process type.
import { readFileSync } from 'fs';
const [, scenario] = process.argv.slice(2);
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

const chars = Number(scenario);
const out: any = { floor: chars, mode: process.env.MOBILE ? 'headless+mobile' : 'headless' };
out.blank = await steady();
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
  const t = document.querySelector('textarea');
  t.value = s.slice(0, ${chars});
  t.focus();
  t.setSelectionRange(0, 0);
})()`);
out.open = await steady();
console.log(JSON.stringify(out));
chrome.kill();
await chrome.exited;
Bun.spawnSync(['rm', '-rf', dir]);
process.exit(0);
