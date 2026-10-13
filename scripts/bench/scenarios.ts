// What the limits do to people and to abuse, as scenarios: an import, a
// shared address, one address filling the disk, a password-guess flood, one
// address loading pages flat out, and what that costs someone else.
// Run on two builds to compare them; an argument after the URL runs one.
//
// Run against a build started with a throwaway database and the client
// address from X-Forwarded-For, so each scenario can be any address:
//
//   PAD_DB=/tmp/pad-bench.db PORT=5597 PAD_TRUSTED_PROXIES=127.0.0.1,::1 \
//     BODY_SIZE_LIMIT=1M bun build/index.js
//   bun scripts/bench/scenarios.ts [importing|nat|fill|flood|pages|neighbour] http://127.0.0.1:5597
//
// Results are in docs/architecture/capacity.org.
const base = process.argv[2];
const only = process.argv[3];
const b64 = (n: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');
const h = (ip: string, extra: Record<string, string> = {}) => ({
  'sec-fetch-site': 'same-origin',
  'x-forwarded-for': ip,
  ...extra
});

async function claim(root: string, ip: string) {
  const res = await fetch(`${base}/_/${root}/auth/claim`, {
    method: 'POST',
    headers: h(ip, { 'content-type': 'application/json' }),
    body: JSON.stringify({ salt: b64(16), auth: b64(32), sealedKey: b64(60) })
  });
  if (res.status !== 204) throw new Error(`claim ${root}: ${res.status} ${await res.text()}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

// Each pad's version, as a browser that saved it last would have it.
const versions = new Map<string, number>();
const save = async (root: string, cookie: string, ip: string, size: number, id = b64(32)) => {
  const r = await fetch(`${base}/_/${root}/pads/${id}`, {
    method: 'PUT',
    body: new Uint8Array(size),
    headers: h(ip, {
      cookie,
      'if-match': `"${versions.get(root + id) ?? 0}"`,
      'x-pad-name': b64(48),
      'content-type': 'application/octet-stream'
    })
  });
  if (r.status === 200)
    versions.set(root + id, ((await r.json()) as { updatedAt: number }).updatedAt);
  else await r.arrayBuffer();
  return r.status;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tag = Date.now().toString(36);

// 1. An import: 2,000 pads of 2.4 KB from one address, 8 at a time.
async function importing() {
  const ip = '10.1.0.1';
  const root = `imp${tag}`;
  const cookie = await claim(root, ip);
  let next = 0,
    saved = 0,
    refused = 0;
  const t = performance.now();
  const deadline = t + 60_000;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < 2000 && performance.now() < deadline) {
        next++;
        let s;
        while ((s = await save(root, cookie, ip, 2400)) === 429 && performance.now() < deadline) {
          refused++;
          await sleep(1000);
        }
        if (s === 200) saved++;
      }
    })
  );
  console.log('import', { saved, refused, seconds: ((performance.now() - t) / 1000).toFixed(2) });
}

// 2. Five people behind one address, each on their own root, saving once a
// second for 20 s.
async function nat() {
  const ip = '10.2.0.1';
  const cookies = await Promise.all(
    Array.from({ length: 5 }, (_, i) => claim(`nat${tag}${i}`, ip))
  );
  let saved = 0,
    refused = 0;
  for (let s = 0; s < 20; s++) {
    const r = await Promise.all(
      cookies.map((c, i) => save(`nat${tag}${i}`, c, ip, 2400, 'A'.repeat(43)))
    );
    for (const x of r) {
      if (x === 200) saved++;
      else refused++;
    }
    await sleep(1000);
  }
  console.log('nat', { saved, refused });
}

// 3. One address filling the disk for 20 s: new 512 KiB pads, new roots as
// each fills, 8 at a time.
async function fill() {
  const ip = '10.3.0.1';
  let accepted = 0,
    refused = 0,
    roots = 0;
  const end = performance.now() + 20_000;
  await Promise.all(
    Array.from({ length: 8 }, async (_, w) => {
      let root = `fill${tag}${w}x${roots++}`;
      let cookie = await claim(root, ip);
      while (performance.now() < end) {
        const s = await save(root, cookie, ip, 512 * 1024);
        if (s === 200) accepted += 512 * 1024;
        else {
          refused++;
          if (s === 413) {
            root = `fill${tag}${w}x${roots++}`;
            cookie = await claim(root, ip);
          } else await sleep(50);
        }
      }
    })
  );
  console.log('fill', { MiB: accepted / 2 ** 20, refused, roots });
}

// 4. An attacker guessing a root's password, then a flood of 15,000 wrong
// guesses from other addresses, then the attacker again.
async function flood() {
  const root = `bf${tag}`;
  await claim(root, '10.4.0.1');
  const guess = (ip: string) =>
    fetch(`${base}/_/${root}/auth/unlock`, {
      method: 'POST',
      headers: h(ip, { 'content-type': 'application/json' }),
      body: JSON.stringify({ auth: b64(32) })
    }).then(async (r) => (await r.arrayBuffer(), r.status));
  // Nine failures, waiting out each wait: the tenth guess owes 16 s.
  for (let failures = 0; failures < 9;) {
    const r = await fetch(`${base}/_/${root}/auth/unlock`, {
      method: 'POST',
      headers: h('10.4.9.9', { 'content-type': 'application/json' }),
      body: JSON.stringify({ auth: b64(32) })
    });
    const m = /wait (\d+)s/.exec(await r.text());
    if (r.status === 401) failures++;
    else await sleep(Number(m?.[1] ?? 1) * 1000);
  }
  const before = await guess('10.4.9.9');
  const tf = performance.now();
  for (let i = 0; i < 15000; i += 1000)
    await Promise.all(
      Array.from({ length: 1000 }, (_, j) => guess(`10.5.${((i + j) >> 8) & 255}.${(i + j) & 255}`))
    );
  const after = await guess('10.4.9.9');
  console.log('flood', {
    attackerBefore: before,
    attackerAfter: after,
    floodSeconds: ((performance.now() - tf) / 1000).toFixed(1)
  });
}

// 5. One address loading pages as fast as it can, 8 at a time, for 10 s:
// the costliest request, which needs no password.
async function pages() {
  let served = 0,
    refused = 0;
  const end = performance.now() + 10_000;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (performance.now() < end) {
        const r = await fetch(`${base}/notes`, { headers: h('10.6.0.1') });
        await r.arrayBuffer();
        if (r.status === 200) served++;
        else refused++;
      }
    })
  );
  console.log('pages', { servedPerSecond: served / 10, refused });
}

// 6. Someone else's saves while one address loads pages flat out: what the
// flood costs everyone else, in failures and waiting. FLOOD sets the
// attacker's connections, 8 by default.
async function neighbour() {
  const ip = '10.7.0.1';
  const root = `nb${tag}`;
  const cookie = await claim(root, ip);
  const id = b64(32);
  const times: number[] = [];
  let failed = 0;
  const end = performance.now() + 10_000;
  const attacker = Promise.all(
    Array.from({ length: Number(process.env.FLOOD ?? 8) }, async () => {
      while (performance.now() < end) {
        const r = await fetch(`${base}/notes`, { headers: h('10.6.0.2') });
        await r.arrayBuffer();
      }
    })
  );
  while (performance.now() < end) {
    const t = performance.now();
    if ((await save(root, cookie, ip, 2400, id)) !== 200) failed++;
    times.push(performance.now() - t);
    await sleep(100);
  }
  await attacker;
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.floor(q * (times.length - 1))].toFixed(1);
  console.log('neighbour', { saves: times.length, failed, p50ms: at(0.5), p99ms: at(0.99) });
}

const all = { importing, nat, fill, flood, pages, neighbour };
for (const [name, run] of Object.entries(all)) if (!only || only === name) await run();
