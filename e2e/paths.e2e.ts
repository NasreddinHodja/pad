import { expect, test, type APIRequestContext } from '@playwright/test';
import { ARGON2 } from '../src/lib/limits.ts';
import { freshRoot } from './fixtures.ts';

// Every check on a root, pad or link id runs on the value its lookup uses:
// SvelteKit decodes the path, then each param, so an encoded variant must
// land on the same root or be refused, never slip past a check on the raw
// string (CryptPad's 2FA bypass, docs/research/s15-incidents.org). Raw URLs
// against the real build, since the decoding is SvelteKit's.

const b64 = (n: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(n))).toString('base64url');
const ours = { 'sec-fetch-site': 'same-origin' };

const claim = (request: APIRequestContext, root: string) =>
  request.post(`/_/${root}/auth/claim`, {
    headers: ours,
    data: { salt: b64(16), argon2: ARGON2, auth: b64(32), sealedKey: b64(60) }
  });

test('an encoded root is the same root, never a way around its claim', async ({ request }) => {
  const root = freshRoot();
  expect((await claim(request, root)).status()).toBe(204);
  for (const variant of [
    // Its first letter percent-encoded.
    `%${root.charCodeAt(0).toString(16)}${root.slice(1)}`,
    // A trailing slash inside the segment, dropped like any empty segment.
    `${root}%2F`
  ])
    expect((await claim(request, variant)).status(), variant).toBe(409);
});

test('encoded separators and dots are refused, not taken for another root', async ({ request }) => {
  for (const raw of [
    // Decodes to `a/b`: a root has one segment.
    'a%2Fb',
    // `_`, the API's own prefix.
    '%5F',
    // `..` and `.`, encoded in the param.
    '..%2F..',
    '%2E%2E%2Fx'
  ]) {
    const res = await request.get(`/_/${raw}/pads`, { headers: ours });
    expect(res.status(), raw).toBe(400);
  }
  // Decoded once only: `%252F` is a root named `a%2Fb`, which is valid and
  // locked, not `a/b`.
  expect((await request.get('/_/a%252Fb/pads', { headers: ours })).status()).toBe(401);
});

test("a link's id is checked decoded", async ({ request }) => {
  const root = freshRoot();
  await claim(request, root);
  const get = (id: string) => request.get(`/_/${root}/shares/${id}`, { headers: ours });
  // 22 characters once decoded, 24 as sent: a valid id, of no link.
  expect((await get(`%41${'A'.repeat(21)}`)).status()).toBe(404);
  // 22 as sent, 20 decoded: refused, whatever its raw length.
  expect((await get(`%41${'A'.repeat(19)}`)).status()).toBe(400);
  // A `/` hidden in one is refused, not a path to something else.
  expect((await get(`${'A'.repeat(10)}%2F${'A'.repeat(11)}`)).status()).toBe(400);
});

test("a page's encoded path lands where its decoded one does", async ({ request }) => {
  const root = freshRoot();
  const get = (raw: string) => request.get(raw, { maxRedirects: 0 });
  // `/root%2Fb` is `/root/b`, which moves under the `#`.
  const moved = await get(`/${root}%2Fb`);
  expect(moved.status()).toBe(308);
  expect(moved.headers().location).toBe(`/${root}#b`);
  expect((await get('/%5F')).status()).toBe(400);
  expect((await get(`/${root}%2F%2E%2E`)).status()).toBe(400);
});
