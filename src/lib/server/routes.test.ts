// The API's routes, called as SvelteKit would, with a fake request.
import { isHttpError, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { handle } from '../../hooks.server.ts';
import * as auth from '../../routes/_/[root]/auth/[action]/+server.ts';
import * as pad from '../../routes/_/[root]/pads/[id]/+server.ts';
import * as batch from '../../routes/_/[root]/pads/batch/+server.ts';
import * as pads from '../../routes/_/[root]/pads/+server.ts';
import { BATCH_PADS } from '../limits.ts';
import * as share from '../../routes/_/[root]/shares/[share]/+server.ts';
import * as usage from '../../routes/_/[root]/usage/+server.ts';
import { db, padVersion, setCeiling } from './db.ts';
import {
  REQUESTS,
  MAX_SEALED,
  ROOT_BYTES,
  ROOT_PADS,
  SERVER_BYTES,
  SERVER_SLACK,
  WRITES
} from './limits.ts';

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

// A browser that has the pad's current version.
const save = (root: string, cookies: Cookies, size: number, id = b64(32), address?: string) =>
  call(pad.PUT, {
    method: 'PUT',
    params: { root, id },
    body: new Uint8Array(size),
    headers: { 'x-pad-name': 'n', 'if-match': `"${padVersion(root, id)}"` },
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

describe('versions', () => {
  const read = (root: string, id: string, cookies: Cookies, version?: number) =>
    call(pad.GET, {
      params: { root, id },
      cookies,
      headers: version === undefined ? {} : { 'if-none-match': `"${version}"` }
    });

  test('a pad is 304 to the version it is at, its text to any other', async () => {
    const cookies = await claimed('versions');
    const id = b64(32);
    const version = (await (await save('versions', cookies, 10, id)).res!.json()).updatedAt;
    const full = await read('versions', id, cookies);
    expect(full.status).toBe(200);
    expect(full.res!.headers.get('etag')).toBe(`"${version}"`);
    const same = await read('versions', id, cookies, version);
    expect(same.status).toBe(304);
    expect((await same.res!.arrayBuffer()).byteLength).toBe(0);
    expect((await read('versions', id, cookies, version - 1)).status).toBe(200);
  });

  test('the list is 304 to its own ETag, until a pad changes', async () => {
    const cookies = await claimed('listed');
    await save('listed', cookies, 10, b64(32));
    const list = (etag?: string) =>
      call(pads.GET, {
        params: { root: 'listed' },
        cookies,
        headers: etag ? { 'if-none-match': etag } : {}
      });
    const first = await list();
    expect(first.status).toBe(200);
    const etag = first.res!.headers.get('etag')!;
    expect(etag).toMatch(/^".+"$/);
    const same = await list(etag);
    expect(same.status).toBe(304);
    expect((await same.res!.arrayBuffer()).byteLength).toBe(0);
    await save('listed', cookies, 10, b64(32));
    const after = await list(etag);
    expect(after.status).toBe(200);
    expect(after.res!.headers.get('etag')).not.toBe(etag);
    expect((await after.res!.json()).pads.length).toBe(2);
  });

  test('a write over any version but the current one is refused', async () => {
    const cookies = await claimed('stale');
    const id = b64(32);
    const write = (method: 'PUT' | 'DELETE', over?: number) =>
      call(pad[method], {
        method,
        params: { root: 'stale', id },
        body: method === 'PUT' ? new Uint8Array(10) : undefined,
        headers: { 'x-pad-name': 'n', ...(over === undefined ? {} : { 'if-match': `"${over}"` }) },
        cookies
      });
    // A new pad's version is 0, and only one of two browsers creating it wins.
    const first = (await (await write('PUT', 0)).res!.json()).updatedAt;
    expect((await write('PUT', 0)).status).toBe(412);
    expect((await write('PUT')).status).toBe(428);
    expect((await write('DELETE', first - 1)).status).toBe(412);
    expect((await write('DELETE')).status).toBe(428);
    expect((await read('stale', id, cookies, first)).status).toBe(304);
    // Emptied, its version is 0 again; a browser still at the last one is refused.
    expect((await write('DELETE', first)).status).toBe(204);
    expect((await write('PUT', first)).status).toBe(412);
    expect((await write('PUT', 0)).status).toBe(200);
  });

  test('two writes in one millisecond get two versions', async () => {
    const cookies = await claimed('same-ms');
    const id = b64(32);
    later(1000);
    const a = (await (await save('same-ms', cookies, 10, id)).res!.json()).updatedAt;
    const b = (await (await save('same-ms', cookies, 10, id)).res!.json()).updatedAt;
    expect(b).toBeGreaterThan(a);
    expect((await read('same-ms', id, cookies, a)).status).toBe(200);
  });
});

describe('batch reads', () => {
  const many = (root: string, cookies: Cookies, ids: unknown, site?: string) =>
    call(batch.POST, {
      method: 'POST',
      params: { root },
      body: JSON.stringify({ ids }),
      headers: { 'content-type': 'application/json' },
      cookies,
      site
    });

  test('pads in the order asked, each after its length; 0 for one that is missing', async () => {
    const cookies = await claimed('batched');
    const [a, b, missing] = [b64(32), b64(32), b64(32)];
    await save('batched', cookies, 3, a);
    await save('batched', cookies, 5, b);
    const { status, res } = await many('batched', cookies, [b, missing, a]);
    expect(status).toBe(200);
    const bytes = new Uint8Array(await res!.arrayBuffer());
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(0, true)).toBe(5);
    expect(v.getUint32(4 + 5, true)).toBe(0);
    expect(v.getUint32(4 + 5 + 4, true)).toBe(3);
    expect(bytes.length).toBe(4 + 5 + 4 + 4 + 3);
  });

  test('locked, cross-site, too many or malformed is refused', async () => {
    const cookies = await claimed('batch-refused');
    expect((await many('batch-refused', jar(), [b64(32)])).status).toBe(401);
    expect((await many('batch-refused', cookies, [b64(32)], 'cross-site')).status).toBe(403);
    const ids = Array.from({ length: BATCH_PADS + 1 }, () => b64(32));
    expect((await many('batch-refused', cookies, ids)).status).toBe(400);
    expect((await many('batch-refused', cookies, [])).status).toBe(400);
    expect((await many('batch-refused', cookies, ['not an id'])).status).toBe(400);
    expect((await many('batch-refused', cookies, [42])).status).toBe(400);
  });
});

describe('meters', () => {
  test('every request counts toward its address, and a refusal says when to come back', async () => {
    const ok = new Response('');
    const send = async (address: string) =>
      await handle({
        event: { getClientAddress: () => address } as RequestEvent,
        resolve: async () => ok
      });
    for (let i = 0; i < REQUESTS.burst; i++) expect(await send('198.51.100.200')).toBe(ok);
    const refused = await send('198.51.100.200');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(await send('198.51.100.201')).toBe(ok);
    later(1000);
    expect(await send('198.51.100.200')).toBe(ok);
  });

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

  test('a full server is 507 to growth, and SQLite refuses past its slack', async () => {
    const { page_count, page_size } = db
      .query<{ page_count: number; page_size: number }, []>(
        'SELECT page_count, page_size FROM pragma_page_count, pragma_page_size'
      )
      .get()!;
    setCeiling(page_count * page_size + 1024 * 1024);
    try {
      const cookies = await claimed('ceiling');
      const id = b64(32);
      let status = 200;
      for (let i = 0; i < 10 && status === 200; i++) {
        status = (await save('ceiling', cookies, MAX_SEALED, i ? undefined : id)).status;
        later(1000);
      }
      expect(status).toBe(507);
      // Rewriting what's there still passes.
      expect((await save('ceiling', cookies, 10, id)).status).toBe(200);
      // Past the slack, any write fails in SQLite itself.
      const insert = db.query(
        'INSERT INTO sealed (root, id, name, data, updated_at) VALUES (?, ?, ?, ?, 0)'
      );
      let thrown: unknown;
      for (let i = 0; i < SERVER_SLACK / MAX_SEALED + 10 && !thrown; i++) {
        try {
          insert.run('ceiling', b64(32), 'n', new Uint8Array(MAX_SEALED));
        } catch (e) {
          thrown = e;
        }
      }
      expect((thrown as { code?: string })?.code).toBe('SQLITE_FULL');
    } finally {
      db.run("DELETE FROM sealed WHERE root = 'ceiling'");
      setCeiling(SERVER_BYTES);
    }
  });

  test('usage counts pads and links', async () => {
    const cookies = await claimed('count');
    await save('count', cookies, 100);
    const { res } = await call(usage.GET, { params: { root: 'count' }, cookies });
    expect(await res!.json()).toEqual({ bytes: 101, pads: 1 });
  });
});
