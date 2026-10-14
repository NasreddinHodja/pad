// A batch read's cost to the server's memory (docs/architecture/capacity.org),
// from one address with one free root. `pads` 1: one full pad named 100
// times, which a5e094a refuses (400). More: that many distinct full pads,
// or as many as the root's quota takes, each named once: a whole root in one
// response. Against a build with a throwaway database:
//
//   PAD_DB=/tmp/pad-batch.db PORT=5598 BODY_SIZE_LIMIT=1M bun build/index.js &
//   bun scripts/bench/batch.ts http://127.0.0.1:5598 <its pid> slow 40 0 [pads] [seconds]
// fast: reads every response; slow: opens n connections and never reads.
import { ARGON2 } from '../../src/lib/limits.ts';

const [base, pid, mode, nArg, concArg, padsArg = '1', secondsArg = '6'] = process.argv.slice(2);
const n = Number(nArg);
const conc = Number(concArg);
const b64 = (k: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(k))).toString('base64url');
const rss = async () => {
  const s = await Bun.file(`/proc/${pid}/status`).text();
  const get = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(s)![1]) / 1024;
  return { rss: get('VmRSS'), peak: get('VmHWM') };
};

const root = `atk${Date.now().toString(36)}`;
const claim = await fetch(`${base}/_/${root}/auth/claim`, {
  method: 'POST',
  headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
  body: JSON.stringify({ salt: b64(16), argon2: ARGON2, auth: b64(32), sealedKey: b64(60) })
});
if (claim.status !== 204) throw new Error(`claim ${claim.status}`);
const cookie = claim.headers
  .getSetCookie()
  .map((c) => c.split(';')[0])
  .join('; ');
const headers = { 'sec-fetch-site': 'same-origin', cookie };

const limits = await (await fetch(`${base}/_/limits`)).json();
const { padded } = await import('../../src/lib/padme.ts');
const size = padded(limits.padBytes + 1) + 28;
const ids: string[] = [];
for (let i = 0; i < Number(padsArg);) {
  const id = b64(32);
  const put = await fetch(`${base}/_/${root}/pads/${id}`, {
    method: 'PUT',
    body: crypto.getRandomValues(new Uint8Array(size)).slice(),
    headers: {
      ...headers,
      'if-match': '"0"',
      'x-pad-name': b64(48),
      'content-type': 'application/octet-stream'
    }
  });
  // The root's writes are metered: wait as asked.
  if (put.status === 429) {
    await Bun.sleep(Number(put.headers.get('retry-after')) * 1000);
    continue;
  }
  // The root's quota: it's full.
  if (put.status === 413 && ids.length) break;
  if (put.status !== 200) throw new Error(`put ${put.status} ${await put.text()}`);
  ids.push(id);
  i++;
}
const body = JSON.stringify({ ids: ids.length === 1 ? Array(100).fill(ids[0]) : ids });
console.log(`${ids.length} pads of ${size} B; before: ${JSON.stringify(await rss())} MiB`);

if (mode === 'fast') {
  let next = 0,
    bytes = 0;
  const statuses: Record<number, number> = {};
  const t = performance.now();
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < n) {
        next++;
        const r = await fetch(`${base}/_/${root}/pads/batch`, {
          method: 'POST',
          body,
          headers: { ...headers, 'content-type': 'application/json' }
        });
        statuses[r.status] = (statuses[r.status] ?? 0) + 1;
        bytes += (await r.arrayBuffer()).byteLength;
      }
    })
  );
  const s = (performance.now() - t) / 1000;
  console.log(
    `${n} batches, ${conc} at a time: ${s.toFixed(1)} s, ${(bytes / 1e6 / s).toFixed(0)} MB/s out,`,
    JSON.stringify(statuses),
    `after: ${JSON.stringify(await rss())} MiB`
  );
} else {
  const url = new URL(base);
  const req =
    `POST /_/${root}/pads/batch HTTP/1.1\r\nHost: ${url.host}\r\ncookie: ${cookie}\r\n` +
    `sec-fetch-site: same-origin\r\ncontent-type: application/json\r\n` +
    `content-length: ${body.length}\r\n\r\n${body}`;
  const sockets = [];
  for (let i = 0; i < n; i++)
    sockets.push(
      await Bun.connect({
        hostname: url.hostname,
        port: Number(url.port),
        socket: {
          data() {},
          open(s) {
            s.write(req);
          }
        }
      })
    );
  // Bun's client reads anyway; pause so the kernel buffers fill and the server holds the rest.
  for (const s of sockets) s.pause?.();
  for (let i = 0; i < Number(secondsArg); i++) {
    await Bun.sleep(1000);
    console.log(`${n} unread batches, t=${i + 1}s: ${JSON.stringify(await rss())} MiB`);
  }
  for (const s of sockets) s.end();
}
