import { afterEach, expect, test } from 'bun:test';
import * as api from './api.ts';

const realFetch = globalThis.fetch;
afterEach(() => void (globalThis.fetch = realFetch));

const answer = (status: number, headers: Record<string, string> = {}) =>
  (globalThis.fetch = (async () =>
    Response.json({ status, message: 'no' }, { status, headers })) as unknown as typeof fetch);

test("a refusal carries the server's message and its Retry-After", async () => {
  answer(429, { 'retry-after': '3' });
  const e = await api.lock('r').catch((e) => e);
  expect(e).toBeInstanceOf(api.Refused);
  expect(e.message).toBe('no');
  expect(e.retryAfter).toBe(3000);
});

test('without Retry-After, none', async () => {
  answer(413);
  expect((await api.lock('r').catch((e) => e)).retryAfter).toBeUndefined();
});

// A server that keeps what claims and password changes send, and answers an
// unlock with whichever root's seal `serve` picks: honest, or replaying one.
function server(serve: (root: string) => string) {
  const kept = new Map<string, { salt: string; argon2: api.Kdf['argon2']; sealedKey: string }>();
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const [, , root, , action] = url.split('/');
    if (action === 'unlock') return Response.json({ sealedKey: kept.get(serve(root))!.sealedKey });
    kept.set(root, JSON.parse(init.body as string));
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  const kdf = (root: string) => kept.get(root)!;
  return { kept, kdf };
}

test("another root's sealed key, with its salt, is refused", async () => {
  const { kdf } = server(() => 'b');
  await api.claim('a', 'correct horse');
  await api.claim('b', 'correct horse');
  // Same password, and the server serves b's salt too: only the root's name
  // in the seal tells them apart.
  await expect(api.unlock('a', 'correct horse', kdf('b'))).rejects.toThrow("doesn't match");
});

test('the sealed key from before a password change is refused under the new one', async () => {
  const { kept, kdf } = server((root) => root);
  await api.claim('a', 'old password');
  const old = { ...kept.get('a')! };
  await api.changePassword('a', 'old password', 'new password', kdf('a'));
  expect(await api.unlock('a', 'new password', kdf('a'))).toBeDefined();
  kept.set('a', old);
  await expect(api.unlock('a', 'new password', kdf('a'))).rejects.toThrow("doesn't match");
});
