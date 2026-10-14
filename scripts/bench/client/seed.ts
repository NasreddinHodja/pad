// Seeds a root through pad's own api.ts, so pads are sealed as the browser seals them.
// bun seed.ts <base> <root> <password> avg|max
import { pads, type Kind } from './text.ts';
const [base, root, password, kindArg] = process.argv.slice(2);
const kind = kindArg as Kind;
const cookies: Record<string, string> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
  for (;;) {
    const headers = new Headers(init.headers);
    headers.set('sec-fetch-site', 'same-origin');
    headers.set('origin', base);
    headers.set(
      'cookie',
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ')
    );
    const res = await realFetch(base + url, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    if (res.status === 429) {
      await Bun.sleep(Number(res.headers.get('retry-after') || 1) * 1000);
      continue;
    }
    return res;
  }
}) as typeof fetch;
const api = await import('../../../src/lib/api.ts');
const keys = await api.claim(root, password);

const all = pads(kind, root);
let total = 0,
  n = 0;
const queue = [...all];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let p; (p = queue.shift());) {
      await api.save(root, keys, p[0], p[1], 0);
      total += p[1].length;
      n++;
    }
  })
);
console.log(kind, n, 'pads,', total, 'bytes of text');
