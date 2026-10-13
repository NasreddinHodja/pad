// What a page load costs the server: loads a second, 8 at a time for 5 s,
// each request from a fresh address so no meter refuses it. A load is the
// requests a browser makes to the server before the page shows (the scripts
// and styles aside, which are files). robots.txt is the control: a file, what
// this machine and this script can do at most.
//
// Run against a build started with a throwaway database and the client
// address from X-Forwarded-For:
//
//   PAD_DB=/tmp/pad-bench.db PORT=5597 PAD_TRUSTED_PROXIES=127.0.0.1 \
//     BODY_SIZE_LIMIT=1M bun build/index.js
//   bun scripts/bench/loads.ts http://127.0.0.1:5597
//
// Results are in docs/architecture/capacity.org.
const base = process.argv[2];
const b64 = (n: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');

let addresses = 0;
const ip = () => {
  const n = addresses++;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

const root = `loads${Date.now().toString(36)}`;
const claim = await fetch(`${base}/_/${root}/auth/claim`, {
  method: 'POST',
  headers: {
    'sec-fetch-site': 'same-origin',
    'x-forwarded-for': ip(),
    'content-type': 'application/json'
  },
  body: JSON.stringify({ salt: b64(16), auth: b64(32), sealedKey: b64(60) })
});
if (claim.status !== 204) throw new Error(`claim: ${claim.status}`);

const loads: Record<string, string[]> = {
  'control: robots.txt': ['/robots.txt'],
  home: ['/'],
  'a claimed root': [`/${root}`],
  'a claimed root, then its data': [`/${root}`, `/${root}/__data.json`],
  'an unclaimed root': ['/nobody-here'],
  'an unclaimed root, then its data': ['/nobody-here', '/nobody-here/__data.json']
};

for (const [name, urls] of Object.entries(loads)) {
  for (const url of urls) {
    const r = await fetch(base + url, { headers: { 'x-forwarded-for': ip() } });
    if (r.status !== 200) throw new Error(`${url}: ${r.status}`);
  }
  let done = 0;
  const end = performance.now() + 5_000;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (performance.now() < end) {
        const from = ip();
        for (const url of urls) {
          const r = await fetch(base + url, { headers: { 'x-forwarded-for': from } });
          await r.arrayBuffer();
          if (r.status !== 200) throw new Error(`${url}: ${r.status}`);
        }
        done++;
      }
    })
  );
  console.log(`${name.padEnd(34)} ${String(Math.round(done / 5)).padStart(6)} loads/s`);
}
