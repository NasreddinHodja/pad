// The API's routes, called as SvelteKit would, with a fake request.
import { isHttpError, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import * as auth from '../../routes/_/[root]/auth/[action]/+server.ts';
import * as pad from '../../routes/_/[root]/pads/[id]/+server.ts';
import * as share from '../../routes/_/[root]/shares/[share]/+server.ts';
import { MAX_SEALED, ROOT_BYTES, ROOT_PADS, WRITES } from './limits.ts';

const b64 = (n: number) => randomBytes(n).toString('base64url');

function jar() {
  const values = new Map<string, string>();
  return {
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => void values.set(name, value)
  } as unknown as Cookies;
}

type Call = {
  method?: string;
  params: Record<string, string>;
  body?: BodyInit;
  headers?: Record<string, string>;
  cookies?: Cookies;
  address?: string;
  site?: string;
};

/** The handler's status, thrown or returned, and the headers it set. */
async function call(handler: unknown, c: Call) {
  const set: Record<string, string> = {};
  const url = new URL('http://pad.test/_/');
  const event = {
    request: new Request(url, {
      method: c.method ?? 'GET',
      body: c.body,
      headers: { 'sec-fetch-site': c.site ?? 'same-origin', ...c.headers }
    }),
    url,
    params: c.params,
    cookies: c.cookies ?? jar(),
    getClientAddress: () => c.address ?? '192.0.2.1',
    setHeaders: (h: Record<string, string>) => Object.assign(set, h)
  } as unknown as RequestEvent;
  try {
    const res = await (handler as (e: RequestEvent) => Promise<Response>)(event);
    return { status: res.status, set, res };
  } catch (e) {
    if (isHttpError(e)) return { status: e.status, set, message: e.body.message };
    throw e;
  }
}

/** A claimed root and a browser unlocked at it. */
async function claimed(root: string) {
  const cookies = jar();
  const body = JSON.stringify({ salt: b64(16), auth: b64(32), sealedKey: b64(60) });
  const { status } = await call(auth.POST, {
    method: 'POST',
    params: { root, action: 'claim' },
    body,
    headers: { 'content-type': 'application/json' },
    cookies
  });
  expect(status).toBe(204);
  return cookies;
}

const save = (root: string, cookies: Cookies, size: number, id = b64(32), address?: string) =>
  call(pad.PUT, {
    method: 'PUT',
    params: { root, id },
    body: new Uint8Array(size),
    headers: { 'x-pad-name': 'n' },
    cookies,
    address
  });

// The meters run on Date.now: each test starts an hour later, buckets full.
let clock = Date.now();
const later = (ms: number) => setSystemTime((clock += ms));
afterEach(() => later(60 * 60 * 1000));

describe('requests', () => {
  test('writes from another site are refused', async () => {
    const cookies = await claimed('cross');
    const { status } = await call(pad.PUT, {
      method: 'PUT',
      params: { root: 'cross', id: b64(32) },
      body: 'x',
      cookies,
      site: 'cross-site'
    });
    expect(status).toBe(403);
  });

  test('a locked root is 401', async () => {
    await claimed('locked');
    expect((await save('locked', jar(), 10)).status).toBe(401);
  });

  test('a pad past its cap is 413', async () => {
    const cookies = await claimed('big');
    expect((await save('big', cookies, MAX_SEALED)).status).toBe(200);
    expect((await save('big', cookies, MAX_SEALED + 1)).status).toBe(413);
  });

  test('a claimed root is 409 to the next claim', async () => {
    await claimed('taken');
    const { status } = await call(auth.POST, {
      method: 'POST',
      params: { root: 'taken', action: 'claim' },
      body: JSON.stringify({ salt: b64(16), auth: b64(32), sealedKey: b64(60) })
    });
    expect(status).toBe(409);
  });
});

describe('meters', () => {
  test('a root writing past its burst is 429, with Retry-After', async () => {
    const cookies = await claimed('fast');
    const id = b64(32);
    // Each save costs its text and its one-character name.
    for (let i = 0; i < Math.floor(WRITES.burst / (MAX_SEALED + 1)); i++)
      expect((await save('fast', cookies, MAX_SEALED, id)).status).toBe(200);
    const refused = await save('fast', cookies, MAX_SEALED, id);
    expect(refused.status).toBe(429);
    expect(Number(refused.set['retry-after'])).toBeGreaterThan(0);
    later(1000);
    expect((await save('fast', cookies, MAX_SEALED, id)).status).toBe(200);
  });

  test("a stranger can't spend a root's writes", async () => {
    const cookies = await claimed('drain');
    for (let i = 0; i < 2000; i++) {
      const { status } = await call(auth.POST, {
        method: 'POST',
        params: { root: 'drain', action: 'delete' },
        address: `198.51.100.${i % 250}`
      });
      expect(status).toBe(401);
    }
    expect((await save('drain', cookies, 10)).status).toBe(200);
  });

  test('wrong passwords back off', async () => {
    await claimed('guess');
    const guess = () =>
      call(auth.POST, {
        method: 'POST',
        params: { root: 'guess', action: 'unlock' },
        body: JSON.stringify({ auth: b64(32) }),
        address: '203.0.113.9'
      });
    for (let i = 0; i < 5; i++) expect((await guess()).status).toBe(401);
    expect((await guess()).status).toBe(429);
  });

  test("reading links is metered per address, by the link's size", async () => {
    await claimed('links');
    const read = (address: string) =>
      call(share.GET, { params: { root: 'links', share: b64(16) }, address });
    for (let i = 0; i < WRITES.burst / (16 * 1024); i++)
      expect((await read('203.0.113.20')).status).toBe(404);
    expect((await read('203.0.113.20')).status).toBe(429);
    expect((await read('203.0.113.21')).status).toBe(404);
  });
});

describe('quotas', () => {
  test('a root past its bytes is 413, and can still shrink', async () => {
    const cookies = await claimed('full');
    const ids = Array.from({ length: ROOT_BYTES / MAX_SEALED }, () => b64(32));
    for (const id of ids) {
      expect((await save('full', cookies, MAX_SEALED, id)).status).toBe(200);
      later(1000);
    }
    const over = await save('full', cookies, MAX_SEALED);
    expect(over.status).toBe(413);
    expect(over.message).toContain('MiB');
    expect((await save('full', cookies, 10, ids[0])).status).toBe(200);
  });

  test('a root past its pad count is 413', async () => {
    const cookies = await claimed('many');
    for (let i = 0; i < ROOT_PADS; i++) {
      expect((await save('many', cookies, 1)).status).toBe(200);
      later(100);
    }
    expect((await save('many', cookies, 1)).status).toBe(413);
  });

  test("only new bytes count toward an address's day", async () => {
    // 1.5 GiB of saves over one pad: past GROWTH.burst if it all counted.
    const cookies = await claimed('rewrite');
    const id = b64(32);
    for (let i = 0; i < 3000; i++) {
      expect((await save('rewrite', cookies, MAX_SEALED, id, '203.0.113.30')).status).toBe(200);
      later(500);
    }
  });
});
