// bun floor.ts avg|max|<chars>   env: MOBILE=1
// The control: a bare page with a plain textarea holding a seeded root pad's text
// (avg, max), or the first <chars> of the generator's.
import { launch, mib, sum } from './harness.ts';
import { floorText } from './text.ts';
const [arg] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const dir = `/tmp/pad-bench-profile-${port}`;
const { S, ev, byType, close } = await launch({
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

const text = floorText(arg);
const chars = text.length;
const out: any = {
  floor: chars,
  text: arg,
  mode: process.env.MOBILE ? 'headless+mobile' : 'headless'
};
out.blank = await steady();
const { frameTree } = await S('Page.getFrameTree');
await S('Page.setDocumentContent', {
  frameId: frameTree.frame.id,
  html: `<!doctype html><meta name=viewport content="width=device-width"><textarea style="width:100vw;height:100vh;font:16px monospace"></textarea>`
});
await ev(`(() => {
  const s = ${JSON.stringify(text)};
  const t = document.querySelector('textarea');
  t.value = s;
  t.focus();
  t.setSelectionRange(0, 0);
})()`);
out.open = await steady();
console.log(JSON.stringify(out));
await close();
process.exit(0);
