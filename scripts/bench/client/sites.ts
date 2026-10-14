// bun sites.ts <url>   env: MOBILE=1
// Other sites for comparison: memory at rest, transfer, and CPU over 20 s idle. Loads only; never types.
import { launch, mib, sum } from './harness.ts';
const [base, scenario] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const { s, send, S, until, byType, events, close } = await launch({
  port,
  dir,
  headed: !!process.env.HEADED,
  flags: ['--no-default-browser-check'],
  network: true,
  phone: !!process.env.MOBILE
});

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
const transferred = () =>
  events
    .filter((e) => e.method === 'Network.loadingFinished' && e.sessionId === s)
    .reduce((a, e) => a + e.params.encodedDataLength, 0);

const url = scenario ?? base;
const out: any = { url, mode: process.env.MOBILE ? 'headless+mobile' : 'headless' };
out.blank = await steady();
const cpu = async () => {
  const { processInfo } = await send('SystemInfo.getProcessInfo');
  const c: Record<string, number> = {};
  for (const p of processInfo) c[p.type] = (c[p.type] ?? 0) + p.cpuTime;
  return c;
};
events.length = 0;
await S('Page.navigate', { url });
await until(`document.readyState === 'complete'`, 60000);
await Bun.sleep(5000);
out.transferredKiB = +(transferred() / 1024).toFixed(1);
out.open = await steady();
const before = events.length;
const a = await cpu();
const t = Date.now();
await Bun.sleep(20000);
const b = await cpu();
const secs = (Date.now() - t) / 1000;
out.idleCpuPctOfCore = Object.fromEntries(
  Object.keys(b).map((k) => [k, +((100 * (b[k] - (a[k] ?? 0))) / secs).toFixed(2)])
);
out.idleRequests = events
  .slice(before)
  .filter((e) => e.method === 'Network.requestWillBeSent' && e.sessionId === s).length;
console.log(JSON.stringify(out));
await close();
process.exit(0);
