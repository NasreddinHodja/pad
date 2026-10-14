// bun drive.ts <base> <claim|avg|max|max-export|avg-type>   env: HEADED=1, MOBILE=1
// Measures one scenario in a fresh Chromium profile. Memory is PSS (shared pages
// split between the processes sharing them) summed per Chromium process type.
import { launch, mib, sum } from './harness.ts';
import { ROOT_CHARS } from './text.ts';
const [base, scenario] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const { s, S, ev, until, typeKey, byType, sample, stop, events, close } = await launch({
  port,
  dir,
  headed: !!process.env.HEADED,
  flags: ['--no-default-browser-check'],
  network: true,
  phone: !!process.env.MOBILE,
  // A claim is over in ~90 ms and an unlock in ~200: at 100 ms the peak is
  // one sample, or none.
  every: 20
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

const out: any = {
  scenario,
  mode: (process.env.HEADED ? 'headed' : 'headless') + (process.env.MOBILE ? '+mobile' : '')
};
out.blank = await steady();
const P = 'hunter2hunter2';
if (scenario === 'claim') {
  await go('/fresh' + port);
  out.gate = await steady();
  out.gateTransferredKiB = +(transferred() / 1024).toFixed(1);
  sample();
  await submitPassword(P);
  out.claimMs = await until(`!!document.querySelector('textarea')`);
  out.claimPeakMiB = stop();
  out.open = await steady();
} else {
  const root = scenario.startsWith('avg') ? 'avgroot' : 'bigroot';
  const first = ROOT_CHARS[root === 'avgroot' ? 'avg' : 'max'];
  await go('/' + root);
  out.gate = await steady();
  sample();
  await submitPassword(P);
  out.unlockMs = await until(loaded(first));
  out.unlockPeakMiB = stop();
  out.open = await steady();
  // A second visit: the keys come from IndexedDB, no Argon2.
  events.length = 0;
  sample();
  const t = Date.now();
  await go('/' + root);
  await until(loaded(first));
  out.revisitMs = Date.now() - t;
  out.revisitPeakMiB = stop();
  out.revisitTransferredKiB = +(transferred() / 1024).toFixed(1);
  out.revisit = await steady();
  if (scenario.endsWith('probe')) {
    out.lines = await ev(`document.querySelector("textarea").value.split("\\n").length`);
    out.nodesBefore = (await S('Memory.getDOMCounters')).nodes;
    await ev(`document.querySelector("textarea").value = ""`);
    await S('HeapProfiler.collectGarbage');
    out.nodesEmptied = (await S('Memory.getDOMCounters')).nodes;
  }
  if (scenario.endsWith('export')) {
    await until(`!!${button('export')} && !${button('export')}.disabled`);
    sample();
    const t2 = Date.now();
    await ev(
      `(() => { window.__statuses = []; const s = document.querySelector('[aria-live]'); new MutationObserver(() => window.__statuses.push(s.textContent)).observe(s, { subtree: true, characterData: true, childList: true }); })()`
    );
    await ev(`${button('export')}.click()`);
    const log = setInterval(
      async () =>
        console.error('status:', await ev(`document.querySelector("[aria-live]")?.textContent`)),
      15000
    );
    await until(`(window.__statuses ?? []).some((t) => /^exported|^►/.test(t))`, 900000);
    clearInterval(log);
    out.exportStatus = await ev(`document.querySelector("[aria-live]")?.textContent`);
    out.exportMs = Date.now() - t2;
    await Bun.sleep(1000);
    out.exportPeakMiB = stop();
    out.afterExport = await steady();
  }
  if (scenario.endsWith('type')) {
    // Typing 2,000 characters into the 249 KB pad, a character every 30 ms.
    await ev(`document.querySelector('textarea').focus()`);
    sample();
    const before2000 = await ev(`(document.querySelector("textarea")?.value.length ?? -1)`);
    for (let i = 0; i < 2000; i++) {
      await typeKey(i % 60 === 59 ? '\n' : 'a');
      await Bun.sleep(30);
    }
    out.typingPeakMiB = stop();
    out.typed2000 =
      (await ev(`(document.querySelector("textarea")?.value.length ?? -1)`)) - before2000;
    out.afterTyping = await steady();
  }
}
console.log(JSON.stringify(out));
await close();
process.exit(0);
