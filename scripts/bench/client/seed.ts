// Seeds a root through pad's own api.ts, so pads are sealed as the browser seals them.
// bun seed.ts <base> <root> <password> avg|max
const [base, root, password, kind] = process.argv.slice(2);
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

const words =
  'the of and to in is that it for on as with was his by at from this be or have an are not but had they you were which her one all their there can been'.split(
    ' '
  );
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const text = (n: number) => {
  let s = '';
  while (s.length < n) s += words[Math.floor(rnd() * words.length)] + (rnd() < 0.1 ? '\n' : ' ');
  return s.slice(0, n);
};
// The author's root (capacity.org): median 437 B, p90 2,992, p99 4,232, max 249,586; 186 pads, 423 KB.
const avgSize = (i: number) => {
  if (i === 0) return 249_000;
  const q = rnd();
  return Math.round(
    q < 0.5
      ? 50 + q * 2 * 390
      : q < 0.9
        ? 437 + ((q - 0.5) / 0.4) * 2555
        : 2992 + ((q - 0.9) / 0.1) * 1240
  );
};
const pads: [string, number][] =
  kind === 'avg'
    ? Array.from({ length: 186 }, (_, i) => [
        i === 0 ? root : `${root}/${['notes', 'work', 'misc'][i % 3]}/p${i}`,
        avgSize(i)
      ])
    : Array.from({ length: 5000 }, (_, i) => [
        i === 0 ? root : `${root}/d${i % 50}/p${i}`,
        i === 0 ? 512 * 1024 - 8192 : 2950
      ]);
let total = 0,
  n = 0;
const queue = [...pads];
await Promise.all(
  Array.from({ length: 8 }, async () => {
    for (let p; (p = queue.shift());) {
      await api.save(root, keys, p[0], text(p[1]), 0);
      total += p[1];
      n++;
    }
  })
);
console.log(kind, n, 'pads,', total, 'bytes of text');
