// bun costs.ts <base> <avg|max>
// The costs found by reading the code, each measured: names re-listed per move, theme applies per load, saves, the poll, paint of the texture and checkerboard, the link page's download, the finder, export.
import { launch } from './harness.ts';
import { ROOT_CHARS } from './text.ts';
const [base, scenario] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const { s, send, S, ev, until, typeKey, sample, stop, events, close } = await launch({
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
// A dialog by its title (ui/Modal.svelte: role=dialog, labelled by its h2).
const dialog = (title: string) =>
  `[...document.querySelectorAll('[role=dialog]')].find((d) => d.querySelector('h2')?.textContent.trim() === '${title}')`;

const root = scenario === 'max' ? 'bigroot' : 'avgroot';
const first = ROOT_CHARS[root === 'avgroot' ? 'avg' : 'max'];
const out: any = { root };
await S('Performance.enable', { timeDomain: 'threadTicks' });
const origin = new URL(base).origin;
await send('Browser.grantPermissions', {
  origin,
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
});
await S('Emulation.setFocusEmulationEnabled', { enabled: true });

const metric = async (name: string) => {
  const { metrics } = await S('Performance.getMetrics');
  return metrics.find((m: any) => m.name === name)?.value ?? 0;
};
/** Requests sent during `run`, with the bytes each sent and received, and script/layout time. */
async function watch(run: () => Promise<unknown>) {
  const from = events.length;
  const [script, layout, styles] = [
    await metric('ScriptDuration'),
    await metric('LayoutDuration'),
    await metric('RecalcStyleCount')
  ];
  sample();
  const t = Date.now();
  await run();
  const peak = stop();
  const ms = Date.now() - t;
  await Bun.sleep(300);
  const evs = events.slice(from).filter((e) => e.sessionId === s);
  const sizes = new Map(
    evs
      .filter((e) => e.method === 'Network.loadingFinished')
      .map((e) => [e.params.requestId, e.params.encodedDataLength])
  );
  // What a request sent: its body, asked of Chromium (loadingFinished's
  // encodedDataLength counts only what came back).
  const body = async (e: any) => {
    if (!e.params.request.hasPostData) return 0;
    try {
      const { postData, base64Encoded } = await S('Network.getRequestPostData', {
        requestId: e.params.requestId
      });
      return base64Encoded ? Buffer.from(postData, 'base64').length : Buffer.byteLength(postData);
    } catch {
      return -1;
    }
  };
  const requests = [];
  for (const e of evs.filter((e) => e.method === 'Network.requestWillBeSent'))
    requests.push({
      method: e.params.request.method,
      url: e.params.request.url,
      bytes: sizes.get(e.params.requestId) ?? 0,
      sent: await body(e)
    });
  return {
    ms,
    peakMiB: peak,
    scriptMs: Math.round(((await metric('ScriptDuration')) - script) * 1000),
    layoutMs: Math.round(((await metric('LayoutDuration')) - layout) * 1000),
    styleRecalcs: (await metric('RecalcStyleCount')) - styles,
    requests
  };
}
const path = (u: string) => new URL(u).pathname;
const summarize = (reqs: { method: string; url: string; bytes: number; sent: number }[]) => {
  const by: Record<string, { n: number; bytes: number; sent: number }> = {};
  for (const r of reqs) {
    const p = path(r.url);
    const k =
      r.method +
      ' ' +
      (/\/pads\/batch$/.test(p)
        ? '/_/<root>/pads/batch'
        : /\/pads\/[^/]+$/.test(p)
          ? '/_/<root>/pads/<id>'
          : /\/pads$/.test(p)
            ? '/_/<root>/pads'
            : /\/theme$/.test(p)
              ? '/_/<root>/theme'
              : p.startsWith('/_app/')
                ? '/_app/…'
                : p);
    by[k] ??= { n: 0, bytes: 0, sent: 0 };
    by[k].n++;
    by[k].bytes += r.bytes;
    by[k].sent += r.sent;
  }
  return by;
};
/** Paint and raster time in a trace of `run`. */
async function paint(run: () => Promise<unknown>) {
  const trace: any[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const from = events.length;
  await send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'cc',
        'viz'
      ]
    }
  });
  await run();
  await send('Tracing.end');
  for (;;) {
    const evs = events.slice(from);
    if (evs.some((e) => e.method === 'Tracing.tracingComplete')) {
      for (const e of evs) if (e.method === 'Tracing.dataCollected') trace.push(...e.params.value);
      break;
    }
    await Bun.sleep(100);
  }
  done();
  await finished;
  const sum: Record<string, { n: number; ms: number }> = {};
  for (const e of trace) {
    if (
      e.ph !== 'X' ||
      ![
        'Paint',
        'RasterTask',
        'PrePaint',
        'Layerize',
        'UpdateLayoutTree',
        'Layout',
        'Commit'
      ].includes(e.name)
    )
      continue;
    sum[e.name] ??= { n: 0, ms: 0 };
    sum[e.name].n++;
    sum[e.name].ms += (e.dur ?? 0) / 1000;
  }
  for (const k of Object.keys(sum)) sum[k].ms = +sum[k].ms.toFixed(1);
  return sum;
}
const css = async (rule: string) =>
  ev(
    `(() => { const s = document.createElement('style'); s.id = 'bench-off'; s.textContent = ${JSON.stringify(rule)}; document.head.append(s); })()`
  );
const uncss = () => ev(`document.getElementById('bench-off')?.remove()`);
const text = () => ev(`document.querySelector('textarea')?.value.length ?? -1`);

// Open the root.
await go('/' + root);
await submitPassword('hunter2hunter2');
await until(loaded(first));
await Bun.sleep(1500);

/** Runs one measurement; a failure is recorded and the rest still run. */
async function section(name: string, run: () => Promise<unknown>) {
  // ONLY=a,b runs just those sections.
  const only = process.env.ONLY?.split(',');
  if (only && !only.includes(name)) return;
  try {
    await run();
  } catch (e) {
    (out.errors ??= {})[name] = String(e).slice(0, 300);
  }
}
const toEnd = `(() => { const t = document.querySelector('textarea'); t.focus(); t.setSelectionRange(t.value.length, t.value.length); })()`;
const finder = `document.querySelector('input[aria-label^="find or make"]')`;

if (root === 'avgroot') {
  // Saves: 5 bursts of 10 keys at the end, each followed by a pause past SAVE_DELAY.
  await section('saves', async () => {
    await ev(toEnd);
    const before = await text();
    const saves = await watch(async () => {
      for (let b = 0; b < 5; b++) {
        for (let i = 0; i < 10; i++) {
          await typeKey('a');
          await Bun.sleep(30);
        }
        await Bun.sleep(1500);
      }
    });
    out.saves = {
      typed: (await text()) - before,
      padChars: await text(),
      ms: saves.ms,
      scriptMs: saves.scriptMs,
      requests: summarize(saves.requests)
    };
  });

  // The poll: 60 s idle, the tab visible, nothing unsaved.
  await section('poll', async () => {
    await ev(`document.activeElement?.blur()`);
    const poll = await watch(() => Bun.sleep(60000));
    out.poll60s = { requests: summarize(poll.requests), scriptMs: poll.scriptMs };
  });

  // Moving between pads: the finder to /notes, then the breadcrumb back.
  await section('moves', async () => {
    const there = await watch(async () => {
      await ev(`${finder}.focus()`);
      for (const c of 'notes') await typeKey(c);
      await typeKey('\n');
      await until(
        `location.hash === '#notes' && !!document.querySelector('textarea') && document.querySelector('[aria-live]')?.textContent === 'saved'`,
        30000
      );
    });
    const back = await watch(async () => {
      await ev(
        `[...document.querySelectorAll('nav[aria-label=path] a')].find((a) => a.textContent.trim() === '${root}').click()`
      );
      await until(
        loaded(first) +
          ` && location.hash === '' && document.querySelector('[aria-live]')?.textContent === 'saved'`,
        30000
      );
    });
    const navSum = (w: any) => ({
      ms: w.ms,
      peakMiB: w.peakMiB,
      scriptMs: w.scriptMs,
      requests: summarize(w.requests),
      anyUrlWithNotes: w.requests.some((r: any) => r.url.includes('notes'))
    });
    out.moveToSubpad = navSum(there);
    out.moveBack = navSum(back);
  });

  // Paint while typing, the full-viewport texture on and off.
  await section('paintTyping', async () => {
    await ev(toEnd);
    const typing50 = async () => {
      for (let i = 0; i < 50; i++) {
        await typeKey('a');
        await Bun.sleep(30);
      }
    };
    out.paintTyping = { textureOn: await paint(typing50) };
    await css('body::before { display: none !important; }');
    out.paintTyping.textureOff = await paint(typing50);
    await uncss();
  });

  // Paint opening and closing the share dialog 3 times, the checkerboard on and off.
  await section('paintDialog', async () => {
    const dialog3 = async () => {
      for (let i = 0; i < 3; i++) {
        await ev(`${button('share')}.click()`);
        await until(`!!${dialog('read-only links')}`, 10000);
        await Bun.sleep(400);
        await ev(`document.querySelector('button[aria-label=close]').click()`);
        await until(`!${dialog('read-only links')}`, 10000);
        await Bun.sleep(400);
      }
    };
    out.paintDialog = { checkerOn: await paint(dialog3) };
    await css('.checker { background-image: none !important; }');
    out.paintDialog.checkerOff = await paint(dialog3);
    await uncss();
  });

  // The theme: a preset picked through the UI, then a reload, counting changes to <html>'s style.
  await section('themeLoad', async () => {
    const pickTheme = async (name: string) => {
      await ev(`${button('theme')}.click()`);
      await until(`!!${dialog('theme')}`, 10000);
      await ev(
        `[...document.querySelectorAll('button')].find((b) => b.textContent.trim().endsWith('${name}')).click()`
      );
      await Bun.sleep(1000);
      await ev(`${button('done')}.click()`);
      await Bun.sleep(1000);
    };
    await pickTheme('paper');
    const { identifier } = await S('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__styleChanges = 0; window.__textureSets = 0;
        new MutationObserver((ms) => { for (const m of ms) if (m.target === document.documentElement) window.__styleChanges++; }).observe(document, { attributes: true, subtree: true, attributeFilter: ['style'] });
        const set = CSSStyleDeclaration.prototype.setProperty;
        CSSStyleDeclaration.prototype.setProperty = function (n, v, p) { if (n === '--texture' && this === document.documentElement.style) window.__textureSets++; return set.call(this, n, v, p); };`
    });
    const load = await watch(async () => {
      await S('Page.reload');
      await until(loaded(first), 60000);
      await Bun.sleep(2000);
    });
    // A reload starts Chromium's counters over: these are the new page's own.
    out.themeLoad = {
      styleChangesOnHtml: await ev('window.__styleChanges'),
      textureSets: await ev('window.__textureSets'),
      styleRecalcs: await metric('RecalcStyleCount'),
      scriptMs: Math.round((await metric('ScriptDuration')) * 1000),
      requests: summarize(load.requests)
    };
    await S('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await pickTheme('dusk');
  });

  // The picker dragged: 60 colours into its ink, one every 30 ms, as a drag
  // sends them, then closed without saving. Script time and the JS heap after
  // collection, before and after.
  await section('themeDrag', async () => {
    await ev(`${button('theme')}.click()`);
    await until(`!!${dialog('theme')}`, 10000);
    await ev(`(() => { window.__textures = []; const set = CSSStyleDeclaration.prototype.setProperty;
      CSSStyleDeclaration.prototype.setProperty = function (n, v, p) { if (n === '--texture' && this === document.documentElement.style) window.__textures.push(v.length); return set.call(this, n, v, p); }; })()`);
    await S('HeapProfiler.collectGarbage');
    const heap0 = (await S('Runtime.getHeapUsage')).usedSize;
    const script0 = await metric('ScriptDuration');
    const t0 = Date.now();
    for (let i = 0; i < 60; i++) {
      const hex = '#' + (0x402080 + i * 0x030103).toString(16).padStart(6, '0');
      await ev(`(() => { const c = document.querySelectorAll('input[type=color]')[2];
        c.value = '${hex}'; c.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await Bun.sleep(30);
    }
    await Bun.sleep(1000);
    const ms = Date.now() - t0;
    const scriptMs = Math.round(((await metric('ScriptDuration')) - script0) * 1000);
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
    await Bun.sleep(500);
    await S('HeapProfiler.collectGarbage');
    const heap1 = (await S('Runtime.getHeapUsage')).usedSize;
    out.themeDrag = {
      colours: 60,
      ms,
      scriptMs,
      heapKeptMiB: +((heap1 - heap0) / 2 ** 20).toFixed(2),
      // Each set of --texture: a url's length, or 4 for 'none'.
      textureSets: await ev('window.__textures'),
      closed: !(await ev(`!!${dialog('theme')}`))
    };
  });

  // What a load downloaded, and which of its scripts carries WebAssembly (the
  // Argon2 chunk): `from` is where in the events the load starts.
  async function scripts(from: number, load: any) {
    const bodies: { url: string; bytes: number; wasm: boolean }[] = [];
    for (const e of events
      .slice(from)
      .filter(
        (e) =>
          e.sessionId === s &&
          e.method === 'Network.responseReceived' &&
          e.params.response.url.endsWith('.js')
      )) {
      const b = await S('Network.getResponseBody', { requestId: e.params.requestId }).catch(
        () => null
      );
      const size = load.requests.find((r: any) => r.url === e.params.response.url)?.bytes ?? 0;
      bodies.push({
        url: path(e.params.response.url),
        bytes: size,
        wasm: !!b && String(b.body).includes('AGFzbQ')
      });
    }
    return {
      totalKiB: +(load.requests.reduce((a: number, r: any) => a + r.bytes, 0) / 1024).toFixed(1),
      jsFiles: bodies.length,
      wasmChunk: bodies.filter((b) => b.wasm)
    };
  }

  // The pad again, its keys from IndexedDB: no password, so no Argon2 needed.
  await section('padRevisit', async () => {
    await S('Network.setCacheDisabled', { cacheDisabled: true });
    const from = events.length;
    const load = await watch(async () => {
      await S('Page.navigate', { url: `${base}/${root}` });
      await until(loaded(first), 60000);
      await Bun.sleep(1000);
    });
    out.padRevisit = await scripts(from, load);
    await S('Network.setCacheDisabled', { cacheDisabled: false });
  });

  // A read-only link's page: what it downloads, cache off. The link comes
  // from the clipboard write the page makes, caught on its way.
  await section('linkPage', async () => {
    await ev(
      `(() => { window.__copied = null; const c = navigator.clipboard; const w = c.writeText.bind(c); c.writeText = (t) => { window.__copied = t; return w(t).catch(() => {}); }; })()`
    );
    await ev(`${button('share')}.click()`);
    await until(`!!${dialog('read-only links')}`, 10000);
    // Only once the dialog has its links: a click while it lists them does nothing.
    await until(
      `!!${button('new link')} && !${button('new link')}.disabled && !/opening/.test(${dialog('read-only links')}.innerText)`,
      30000
    );
    await Bun.sleep(500);
    await ev(`${button('new link')}.click()`);
    await until(`!!window.__copied`, 30000);
    const url = (await ev('window.__copied')) as string;
    await S('Network.setCacheDisabled', { cacheDisabled: true });
    const from = events.length;
    const linkLoad = await watch(async () => {
      await S('Page.navigate', { url });
      await until(`!!document.querySelector('pre')`, 30000);
      await Bun.sleep(1000);
    });
    out.linkPage = await scripts(from, linkLoad);
    await S('Network.setCacheDisabled', { cacheDisabled: false });
  });
} else {
  // The finder at the 5,000-pad root: nodes and a 2-key query.
  await section('finder', async () => {
    const nodesClosed = (await S('Memory.getDOMCounters')).nodes;
    const open = await watch(async () => {
      await ev(`${finder}.focus()`);
      await Bun.sleep(1000);
    });
    const nodesOpen = (await S('Memory.getDOMCounters')).nodes;
    const query = await watch(async () => {
      for (const c of 'd1') {
        await typeKey(c);
        await Bun.sleep(300);
      }
    });
    out.finder = {
      items: await ev(`document.querySelectorAll('[role=option]').length`),
      nodesClosed,
      nodesOpen,
      open: { ms: open.ms, scriptMs: open.scriptMs, layoutMs: open.layoutMs },
      query2keys: {
        scriptMs: query.scriptMs,
        layoutMs: query.layoutMs,
        styleRecalcs: query.styleRecalcs
      },
      nodesAfterQuery: (await S('Memory.getDOMCounters')).nodes
    };
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
    await Bun.sleep(1000);
  });

  // Export, watching the status for its own result.
  await section('export', async () => {
    out.statusBeforeExport = await ev(`document.querySelector('[aria-live]')?.textContent`);
    await until(`!!${button('export')} && !${button('export')}.disabled`, 30000);
    await ev(
      `(() => { window.__statuses = []; const s = document.querySelector('[aria-live]'); new MutationObserver(() => window.__statuses.push(s.textContent)).observe(s, { subtree: true, characterData: true, childList: true }); })()`
    );
    const ex = await watch(async () => {
      await ev(`${button('export')}.click()`);
      await until(`(window.__statuses ?? []).some((t) => /^exported|^►/.test(t))`, 300000);
    });
    out.export = {
      status: await ev(`document.querySelector('[aria-live]')?.textContent`),
      ms: ex.ms,
      peakMiB: ex.peakMiB,
      scriptMs: ex.scriptMs,
      requests: summarize(ex.requests)
    };
  });
}
console.log(JSON.stringify(out));
await close();
process.exit(0);
