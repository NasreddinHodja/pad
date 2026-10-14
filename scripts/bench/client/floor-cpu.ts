// bun floor-cpu.ts avg|max|<chars>   env: MOBILE=1
// The control for cpu.ts and drive.ts: the same phases on a bare page with a plain
// textarea holding a seeded root pad's text (avg, max), or <chars> of the generator's.
import { launch, mib, sum } from './harness.ts';
import { floorText } from './text.ts';
const [base, scenario] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const { targetId, send, S, ev, typeKey, byType, sample, stop, close } = await launch({
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
const arg = scenario ?? base;
const text = floorText(arg);
const chars = text.length;
const out: any = {
  floor: chars,
  text: arg,
  mode: process.env.MOBILE ? 'headless+mobile' : 'headless'
};
const IDLE = 20000;
await phase('blankIdle', () => Bun.sleep(IDLE));
await phase('open', async () => {
  const { frameTree } = await S('Page.getFrameTree');
  await S('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: `<!doctype html><meta name=viewport content="width=device-width"><textarea style="width:100vw;height:100vh;font:16px monospace"></textarea>`
  });
  await ev(`(() => {
    const s = ${JSON.stringify(text)};
    document.querySelector('textarea').value = s;
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
await close();
process.exit(0);
