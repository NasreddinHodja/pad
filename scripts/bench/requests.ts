// What a save costs the server, not what the meters allow: each batch of
// saves goes to a fresh root from a fresh address, so no bucket runs dry.
//
// Run against a build started with a throwaway database and the client
// address from X-Forwarded-For:
//
//   PAD_DB=/tmp/pad-bench.db PORT=5597 ADDRESS_HEADER=x-forwarded-for \
//     XFF_DEPTH=1 BODY_SIZE_LIMIT=1M bun build/index.js
//   bun scripts/bench/requests.ts http://127.0.0.1:5597
//
// Results are in docs/architecture/capacity.org.

const base = process.argv[2];
const b64 = (n: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');

let addresses = 0;
/** A new root, claimed from a new address, and what a save to it needs. */
async function fresh() {
  const n = addresses++;
  const ip = `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
  const root = `bench${Date.now().toString(36)}${n}`;
  const res = await fetch(`${base}/_/${root}/auth/claim`, {
    method: 'POST',
    headers: {
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': ip,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ salt: b64(16), auth: b64(32), sealedKey: b64(60) })
  });
  if (res.status !== 204) throw new Error(`claim: ${res.status} ${await res.text()}`);
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return { root, headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip, cookie } };
}

/** `n` saves of `size` bytes, `conc` at a time, `per` to a root. */
async function run(label: string, size: number, n: number, conc: number, per: number) {
  const body = new Uint8Array(size);
  const targets = await Promise.all(Array.from({ length: Math.ceil(n / per) }, fresh));
  let next = 0;
  const t = performance.now();
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (next < n) {
        const k = next++;
        const { root, headers } = targets[Math.floor(k / per)];
        const r = await fetch(`${base}/_/${root}/pads/${b64(32)}`, {
          method: 'PUT',
          body,
          headers: {
            ...headers,
            'if-match': '"0"',
            'x-pad-name': b64(48),
            'content-type': 'application/octet-stream'
          }
        });
        if (r.status !== 200) throw new Error(`save ${k}: ${r.status} ${await r.text()}`);
        await r.arrayBuffer();
      }
    })
  );
  const s = (performance.now() - t) / 1000;
  console.log(label, `${(n / s).toFixed(0)} a second`, `${((s / n) * 1000).toFixed(2)} ms each`);
}

// Within a root's 16 MiB, an address's 64 MiB at once, and the 60 writes a
// minute per address before section 3, so both can be measured.
await run('2.4 KB, one at a time', 2400, 2000, 1, 50);
await run('2.4 KB, 8 at a time', 2400, 5000, 8, 50);
await run('512 KiB, 8 at a time', 512 * 1024, 500, 8, 30);
