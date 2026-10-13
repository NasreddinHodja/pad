// bun drive.ts <base> <claim|avg|max|max-export|avg-type>   env: HEADED=1, MOBILE=1
// Measures one scenario in a fresh Chromium profile. Memory is PSS (shared pages
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
async function until(expr: string, ms = 90000) {
  const t = Date.now();
  while (!(await ev(expr))) {
    if (Date.now() - t > ms)
      throw new Error(
        'timeout: ' +
          expr +
          '\nPAGE: ' +
          (await ev(`location.href + ' | ' + document.body.innerText.slice(0, 300)`))
      );
    await Bun.sleep(50);
  }
  return Date.now() - t;
}
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
  const first = root === 'avgroot' ? 249000 : 512 * 1024 - 8192;
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
chrome.kill();
await chrome.exited;
Bun.spawnSync(['rm', '-rf', dir]);
process.exit(0);
