// Where export's memory goes, without tracing: PSS of each Chromium process
// every 50 ms from the click on export until 1.5 s after it is done.
//
//   bun scripts/bench/client/export-pss.ts <base> <root> <password> avg|max|<chars>
import { readFileSync } from 'fs';
import { launch } from './harness.ts';
import { floorText } from './text.ts';
const [base, root, password, firstArg] = process.argv.slice(2);
// The root pad's text: the floor shows it, and the pad is open once it's all there.
const text = floorText(firstArg);
const first = text.length;
const port = 9200 + Math.floor(Math.random() * 90);
const dir = `/tmp/pad-export-profile-${port}`;
const { send, S, ev, until, close } = await launch({
  port,
  dir,
  timeout: 120000,
  // Its events aren't read: none is kept.
  onEvent: () => {}
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
// Asked every 250 ms whether the export is done. Five minutes without one
// done is an export that won't be: costs.ts waits as long.
while (!(await ev(`(window.__statuses ?? []).some((t) => /^exported|^►/.test(t))`))) {
  if (Date.now() - t0 > 300000) throw new Error('timeout: export');
  await Bun.sleep(250);
}
const status = await ev(`document.querySelector('[aria-live]')?.textContent`);
const ms = Date.now() - t0;
await Bun.sleep(1500);
sampling = false;
await Bun.sleep(100);
console.log(JSON.stringify({ status, ms, pss: [...peaks].map(([pid, v]) => ({ pid, ...v })) }));
await close();
process.exit(0);
