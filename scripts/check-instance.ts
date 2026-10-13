// Checks a running instance against a release: every file of the release's
// client-files.sha256 is fetched from it and hashed, and every script its
// pages load must be one of them. What it can't check: the HTML pages and
// the two inline scripts in each, which the server renders per request.
//
//   bun scripts/check-instance.ts https://pad.example.org client-files.sha256
//
// client-files.sha256 is attached to each GitHub release (sha256sum's
// format, paths as the instance serves them).

const [base, list] = process.argv.slice(2);
if (!base || !list) {
  console.error('usage: bun scripts/check-instance.ts <url> <client-files.sha256>');
  process.exit(2);
}

const want = new Map<string, string>();
for (const line of (await Bun.file(list).text()).split('\n')) {
  const m = line.match(/^([0-9a-f]{64}) [ *](?:\.\/)?(.+)$/);
  if (m) want.set(m[2], m[1]);
}
if (want.size === 0) {
  console.error(`no hashes in ${list}`);
  process.exit(2);
}

let bad = 0;
for (const [path, hash] of want) {
  const res = await fetch(new URL(path, base));
  const got = res.ok
    ? new Bun.CryptoHasher('sha256').update(await res.arrayBuffer()).digest('hex')
    : `HTTP ${res.status}`;
  if (got !== hash) {
    console.log(`differs: ${path} (${got})`);
    bad++;
  }
}

// The home page and a pad's page load different nodes.
for (const page of ['/', '/check-instance']) {
  const html = await (await fetch(new URL(page, base))).text();
  for (const [path] of html.matchAll(/_app\/immutable\/[^"'`)\s]+/g)) {
    if (!want.has(path)) {
      console.log(`not in the release: ${path}, loaded by ${page}`);
      bad++;
    }
  }
}

console.log(bad ? `${bad} problems` : `${want.size} files match`);
process.exit(bad ? 1 : 0);
