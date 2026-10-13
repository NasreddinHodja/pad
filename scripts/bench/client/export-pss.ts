// Where export's memory goes, without tracing: PSS of each Chromium process
// every 50 ms from the click on export until 1.5 s after it is done.
//
//   bun scripts/bench/client/export-pss.ts <base> <root> <password> <chars of the root pad>
import { readFileSync } from 'fs';
const [base, root, password, firstArg] = process.argv.slice(2);
const first = Number(firstArg);
const port = 9200 + Math.floor(Math.random() * 90);
const dir = `/tmp/pad-export-profile-${port}`;
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
const traceDone: () => void = () => {};
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
// A dump every 250 ms of the export, then one 1.5 s after it.
while (!(await ev(`(window.__statuses ?? []).some((t) => /^exported|^►/.test(t))`))) {
  await Bun.sleep(250);
}
const status = await ev(`document.querySelector('[aria-live]')?.textContent`);
const ms = Date.now() - t0;
await Bun.sleep(1500);
sampling = false;
await Bun.sleep(100);
console.log(JSON.stringify({ status, ms, pss: [...peaks].map(([pid, v]) => ({ pid, ...v })) }));
chrome.kill();
await chrome.exited;
Bun.spawnSync(['rm', '-rf', dir]);
process.exit(0);
