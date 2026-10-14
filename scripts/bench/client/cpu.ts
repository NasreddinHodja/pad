// bun cpu.ts <base> <avg|max>   env: HEADED=1, MOBILE=1
// Measures one scenario in a fresh Chromium profile. Memory is PSS (shared pages
// split between the processes sharing them) summed per Chromium process type.
import { launch } from './harness.ts';
import { ROOT_CHARS } from './text.ts';
const [base, scenario] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const { targetId, send, S, ev, until, typeKey, sample, stop, close } = await launch({
  port,
  dir,
  headed: !!process.env.HEADED,
  flags: ['--no-default-browser-check'],
  network: true,
  phone: !!process.env.MOBILE
});

async function go(path: string) {
  await S('Page.navigate', { url: base + path });
  await until(`document.readyState === 'complete'`);
}
async function submitPassword(password: string) {
  await until(`!!document.querySelector('input[type=password]')`);
  await ev(`(() => { for (const i of document.querySelectorAll('input[type=password]')) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(password)});
    i.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('input[type=password]').form.requestSubmit(); })()`);
}
const loaded = (n: number) =>
  `(() => { const t = document.querySelector('textarea'); return !!t && t.value.length >= ${n}; })()`;
const button = (label: string) =>
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '${label}')`;

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
const out: any = {
  root: scenario,
  mode: (process.env.HEADED ? 'headed' : 'headless') + (process.env.MOBILE ? '+mobile' : '')
};
const P = 'hunter2hunter2';
const root = scenario === 'avg' ? 'avgroot' : 'bigroot';
const first = ROOT_CHARS[root === 'avgroot' ? 'avg' : 'max'];
const IDLE = 20000;
await phase('blankIdle', () => Bun.sleep(IDLE));
await phase('load', () =>
  go('/' + root).then(() => until(`!!document.querySelector('input[type=password]')`))
);
await phase('gateIdle', () => Bun.sleep(IDLE));
await phase('unlock', async () => {
  await submitPassword(P);
  await until(loaded(first));
});
await phase('idleNoFocus', async () => {
  await ev(`document.activeElement?.blur()`);
  await Bun.sleep(IDLE);
});
await phase('idleFocused', async () => {
  await ev(`document.querySelector('textarea').focus()`);
  await Bun.sleep(IDLE);
});
await phase('caretAtEnd', async () => {
  await ev(
    `(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`
  );
  await Bun.sleep(IDLE);
});
const before500 = await ev(`(document.querySelector("textarea")?.value.length ?? -1)`);
await phase('typing500', async () => {
  for (let i = 0; i < 500; i++) {
    await typeKey(i % 60 === 59 ? '\n' : 'a');
    await Bun.sleep(30);
  }
});
out.typed500 = (await ev(`(document.querySelector("textarea")?.value.length ?? -1)`)) - before500;
await phase('afterTypingIdle', () => Bun.sleep(5000));
const finder = `document.querySelector('input[aria-label^="find or make"]')`;
await phase('finderOpen', async () => {
  await ev(`${finder}.focus()`);
  await Bun.sleep(2000);
});
await phase('finderTyping', async () => {
  for (const c of 'notes/p1') {
    await typeKey(c);
    await Bun.sleep(150);
  }
  await Bun.sleep(1000);
});
await phase('finderIdle', () => Bun.sleep(IDLE));
await phase('finderClose', async () => {
  await S('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await S('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  });
  await ev(`document.activeElement?.blur()`);
  await Bun.sleep(2000);
});
await phase('hiddenTab', async () => {
  // A tab in the background: other tabs on top, the window still open.
  await S('Emulation.setFocusEmulationEnabled', { enabled: false });
  const { targetId: other } = await send('Target.createTarget', { url: 'about:blank' });
  await send('Target.activateTarget', { targetId: other });
  await Bun.sleep(IDLE);
  await send('Target.closeTarget', { targetId: other });
  await send('Target.activateTarget', { targetId });
});
// Export returns without a word when the pad isn't saved (Pad.svelte,
// exportAll): what the status says before and after is kept, and a run that
// never sees "exported" still prints the phases before it.
out.statusBeforeExport = await ev(`document.querySelector('[aria-live]')?.textContent`);
try {
  await phase('export', async () => {
    await until(`!!${button('export')} && !${button('export')}.disabled`, 30000);
    await ev(
      `(() => { window.__statuses = []; const s = document.querySelector('[aria-live]'); new MutationObserver(() => window.__statuses.push(s.textContent)).observe(s, { subtree: true, characterData: true, childList: true }); })()`
    );
    await ev(`${button('export')}.click()`);
    await until(`(window.__statuses ?? []).some((t) => /^exported|^►/.test(t))`, 120000);
  });
} catch (e) {
  out.exportError = String(e).slice(0, 300);
}
out.statusAfterExport = await ev(`document.querySelector('[aria-live]')?.textContent`);
console.log(JSON.stringify(out));
await close();
process.exit(0);
