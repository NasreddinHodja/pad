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
