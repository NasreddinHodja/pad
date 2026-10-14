// The Chromium every client script measures in: a fresh profile, one page,
// spoken to over CDP, and how its processes' memory is read.
import { readFileSync } from 'fs';

export type Launch = {
  port: number;
  dir: string;
  headed?: boolean;
  // Chromium flags after --no-first-run.
  flags?: string[];
  // Network events on, and MOBILE's phone, if asked.
  network?: boolean;
  phone?: boolean;
  // What until() waits by default, in ms.
  timeout?: number;
  // How often sample() reads the processes' memory, in ms.
  every?: number;
  // An event that isn't an answer; by default it goes to events.
  onEvent?: (d: any) => void;
};

export async function launch({
  port,
  dir,
  headed = false,
  flags = [],
  network = false,
  phone = false,
  timeout = 90000,
  every = 100,
  onEvent
}: Launch) {
  const chrome = Bun.spawn(
    [
      'chromium',
      ...(headed ? [] : ['--headless=new']),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      ...flags,
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
    } else if (onEvent) onEvent(d);
    else events.push(d);
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
  if (network) await S('Network.enable');
  // A download refused: an export's zip would go to ~/Downloads, and its write
  // into what's measured.
  await send('Browser.setDownloadBehavior', { behavior: 'deny' });
  if (phone) {
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

  async function byType() {
    const { processInfo } = await send('SystemInfo.getProcessInfo');
    const out: Record<string, number> = {};
    for (const p of processInfo) out[p.type] = (out[p.type] ?? 0) + kib(p.id);
    return out;
  }
  // One sampler at a time: each sample() is a new run, and a loop whose run
  // is over stops at its next look, without reading the processes again.
  let peak = 0;
  let peakTotal = 0;
  let run = 0;
  async function sample() {
    const mine = ++run;
    peak = 0;
    peakTotal = 0;
    while (run === mine) {
      const t = await byType();
      if (run !== mine) break;
      peak = Math.max(peak, t.renderer ?? 0);
      peakTotal = Math.max(peakTotal, sum(t));
      // Not more often than asked: reading every process's memory costs the
      // machine being measured.
      await Bun.sleep(every);
    }
  }
  const stop = () => {
    run++;
    return { renderer: mib(peak), total: mib(peakTotal) };
  };
  async function until(expr: string, ms = timeout) {
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
  async function close() {
    // The socket closes with the browser: that's the end, not a failure.
    ws.onclose = null;
    chrome.kill();
    await chrome.exited;
    Bun.spawnSync(['rm', '-rf', dir]);
  }

  return { s, targetId, send, S, ev, until, typeKey, byType, sample, stop, events, close };
}

// A process's PSS in KiB: shared pages split between the processes sharing them.
export const kib = (pid: number) => {
  try {
    return +readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m)![1];
  } catch {
    return 0;
  }
};
export const mib = (k: number) => +(k / 1024).toFixed(1);
export const sum = (t: Record<string, number>) => Object.values(t).reduce((a, b) => a + b, 0);
