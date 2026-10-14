// bun typing-path.ts avg|max|<chars> <insert|keys> <spell|nospell>
// Is typing at the end of a long textarea slow in Chromium itself, or only through CDP's insertText, or because of spellcheck? 100 keys at the end of a bare textarea.
import { launch } from './harness.ts';
import { floorText } from './text.ts';
const [base, scenario] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const { send, S, ev, sample, stop, close } = await launch({
  port,
  dir,
  headed: !!process.env.HEADED,
  flags: ['--no-default-browser-check'],
  network: true,
  phone: !!process.env.MOBILE
});

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
const text = floorText(base);
const chars = text.length;
const how = scenario ?? 'insert';
const spell = (process.argv[4] ?? 'spell') === 'spell';
const out: any = { floor: chars, how, spell };
await phase('open', async () => {
  const { frameTree } = await S('Page.getFrameTree');
  await S('Page.setDocumentContent', {
    frameId: frameTree.frame.id,
    html: `<!doctype html><textarea spellcheck="${spell}" style="width:100vw;height:100vh;font:16px monospace"></textarea>`
  });
  await ev(`(() => {
    const s = ${JSON.stringify(text)};
    const t = document.querySelector('textarea');
    t.value = s;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  })()`);
  await Bun.sleep(2000);
});
await phase('typing100AtEnd', async () => {
  for (let i = 0; i < 100; i++) {
    if (how === 'insert') await S('Input.insertText', { text: 'a' });
    else {
      await S('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        text: 'a',
        windowsVirtualKeyCode: 65
      });
      await S('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65
      });
    }
    await Bun.sleep(30);
  }
});
out.length = await ev(`document.querySelector('textarea').value.length`);
console.log(JSON.stringify(out));
await close();
process.exit(0);
