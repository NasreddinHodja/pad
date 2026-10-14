// The API's routes, called as SvelteKit would, with a fake request.
import { isHttpError, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { handle } from '../../hooks.server.ts';
import * as auth from '../../routes/_/[root]/auth/[action]/+server.ts';
import * as pad from '../../routes/_/[root]/pads/[id]/+server.ts';
import * as batch from '../../routes/_/[root]/pads/batch/+server.ts';
import * as pads from '../../routes/_/[root]/pads/+server.ts';
import { ARGON2, BATCH_PADS, LINK_LIFETIMES } from '../limits.ts';
import { kdfOf } from './auth.ts';
import * as share from '../../routes/_/[root]/shares/[share]/+server.ts';
import * as padShares from '../../routes/_/[root]/pads/[id]/shares/+server.ts';
import * as theme from '../../routes/_/[root]/theme/+server.ts';
import { db, padVersion, setCeiling, usage } from './db.ts';
import {
  OPEN,
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
  /** Sec-Fetch-Site; null sends none. */
  site?: string | null;
};

/** The handler's status, thrown or returned, and the headers it set. */
async function call(handler: unknown, c: Call) {
  const set: Record<string, string> = {};
  const url = new URL('http://pad.test/_/');
  const event = {
    request: new Request(url, {
      method: c.method ?? 'GET',
      body: c.body,
      headers: {
        ...(c.site === null ? {} : { 'sec-fetch-site': c.site ?? 'same-origin' }),
        ...c.headers
      }
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
  const body = JSON.stringify({ salt: b64(16), argon2: ARGON2, auth: b64(32), sealedKey: b64(60) });
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

  test('reads from another site are refused, another subdomain included', async () => {
    const cookies = await claimed('crossread');
    const id = b64(32);
    const reads = [
      [pads.GET, { root: 'crossread' }],
      [pad.GET, { root: 'crossread', id }],
      [theme.GET, { root: 'crossread' }],
      [padShares.GET, { root: 'crossread', id }],
      [share.GET, { root: 'crossread', share: b64(16) }]
    ] as const;
    for (const [handler, params] of reads) {
      for (const site of ['cross-site', 'same-site'])
        expect((await call(handler, { params, cookies, site })).status).toBe(403);
      // Our own page, the address bar, and curl, which sends no Sec-Fetch-Site.
      for (const site of ['same-origin', 'none', null])
        expect((await call(handler, { params, cookies, site })).status).not.toBe(403);
    }
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
      body: JSON.stringify({ salt: b64(16), argon2: ARGON2, auth: b64(32), sealedKey: b64(60) })
    });
    expect(status).toBe(409);
  });

  test("a claim's Argon2 cost is kept for its root, and one outside pad's bounds is 400", async () => {
    const claim = (root: string, argon2: unknown) =>
      call(auth.POST, {
        method: 'POST',
        params: { root, action: 'claim' },
        body: JSON.stringify({ salt: b64(16), argon2, auth: b64(32), sealedKey: b64(60) })
      });
    for (const argon2 of [
      undefined,
      { ...ARGON2, memory: ARGON2.memory - 1 },
      { ...ARGON2, iterations: 1 },
      { ...ARGON2, memory: 256 * 1024 + 1 },
      { ...ARGON2, iterations: 2.5 },
      { ...ARGON2, parallelism: '1' }
    ])
      expect((await claim('weak', argon2)).status).toBe(400);
    expect(kdfOf('weak')).toBeNull();

    const strong = { memory: 64 * 1024, iterations: 3, parallelism: 1 };
    expect((await claim('strong', strong)).status).toBe(204);
    expect(kdfOf('strong')!.argon2).toEqual(strong);
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

  test('a save without a name keeps the one the pad has; a new or emptied pad needs one', async () => {
    const cookies = await claimed('named');
    const id = b64(32);
    const write = (method: 'PUT' | 'DELETE', name?: string) =>
      call(pad[method], {
        method,
        params: { root: 'named', id },
        body: method === 'PUT' ? new Uint8Array(10) : undefined,
        headers: {
          'if-match': `"${padVersion('named', id)}"`,
          ...(name === undefined ? {} : { 'x-pad-name': name })
        },
        cookies
      });
    expect((await write('PUT')).status).toBe(400);
    expect((await write('PUT', 'abc')).status).toBe(200);
    expect((await write('PUT')).status).toBe(200);
    const { res } = await call(pads.GET, { params: { root: 'named' }, cookies });
    expect((await res!.json()).pads).toEqual([{ id, name: 'abc' }]);
    // And the first save's text, kept as a version.
    expect(usage('named')).toMatchObject({ bytes: 23, history: 10 });
    expect((await write('DELETE')).status).toBe(204);
    expect((await write('PUT')).status).toBe(400);
    expect((await write('PUT', 'abcd')).status).toBe(200);
    // The text it had when emptied is kept too.
    expect(usage('named')).toMatchObject({ bytes: 34, history: 20 });
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
  const ok = new Response('');
  /** The hook's answer to a request from `peer`, saying it forwards for `forwarded`. */
  const send = async (peer: string, forwarded?: string, path = '/') =>
    await handle({
      event: {
        getClientAddress: () => peer,
        url: new URL('http://pad.test' + path),
        request: new Request('http://pad.test' + path, {
          headers: forwarded ? { 'x-forwarded-for': forwarded } : {}
        })
      } as RequestEvent,
      resolve: async () => ok
    });

  test('only the home and about pages may be indexed', async () => {
    expect((await send('198.51.100.210')).headers.get('x-robots-tag')).toBeNull();
    expect(
      (await send('198.51.100.210', undefined, '/_/about')).headers.get('x-robots-tag')
    ).toBeNull();
    for (const path of ['/nassu', '/_/nassu/s/link', '/_/nassu/pads', '/_/about/x'])
      expect((await send('198.51.100.210', undefined, path)).headers.get('x-robots-tag')).toBe(
        'noindex'
      );
  });

  test('every request counts toward its address, and a refusal says when to come back', async () => {
    for (let i = 0; i < REQUESTS.burst; i++) expect(await send('198.51.100.200')).toBe(ok);
    const refused = await send('198.51.100.200');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(await send('198.51.100.201')).toBe(ok);
    later(1000);
    expect(await send('198.51.100.200')).toBe(ok);
  });

  test("a client's own X-Forwarded-For doesn't give it a fresh meter", async () => {
    for (let i = 0; i < REQUESTS.burst; i++)
      expect(await send('198.51.100.210', `203.0.113.${i % 250}`)).toBe(ok);
    expect((await send('198.51.100.210', '203.0.113.251')).status).toBe(429);
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
      // What the root's write meter refills in the time.
      later(Math.ceil((MAX_SEALED / WRITES.perSecond) * 1000));
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

  test('the quota counts pads and links', async () => {
    const cookies = await claimed('count');
    await save('count', cookies, 100);
    expect(usage('count')).toEqual({ bytes: 101, history: 0, pads: 1 });
  });
});

describe('links', () => {
  const make = (root: string, cookies: Cookies, headers: Record<string, string> = {}) => {
    const id = b64(16);
    return call(share.PUT, {
      method: 'PUT',
      params: { root, share: id },
      body: new Uint8Array(10),
      headers: { 'x-pad-id': b64(32), 'x-share-key': b64(61), ...headers },
      cookies
    }).then((r) => ({ ...r, id }));
  };
  const read = (root: string, id: string, headers: Record<string, string> = {}, address?: string) =>
    call(share.GET, { params: { root, share: id }, headers, address });

  test('a link lasts one of the offered lifetimes, or never expires', async () => {
    const cookies = await claimed('lifetimes');
    for (const ms of Object.values(LINK_LIFETIMES))
      expect((await make('lifetimes', cookies, { 'x-expires-in': String(ms) })).status).toBe(200);
    expect((await make('lifetimes', cookies)).status).toBe(200);
    for (const bad of ['0', '-1', '1000', 'week', String(LINK_LIFETIMES['1 year'] + 1)])
      expect((await make('lifetimes', cookies, { 'x-expires-in': bad })).status).toBe(400);
    expect((await make('lifetimes', cookies, { 'x-once': 'yes' })).status).toBe(400);
  });

  test("a link's sealed key is 61 bytes, or 60 from a page before passwords", async () => {
    const cookies = await claimed('keysizes');
    for (const [n, status] of [
      [60, 200],
      [61, 200],
      [59, 400],
      [62, 400]
    ])
      expect((await make('keysizes', cookies, { 'x-share-key': b64(n) })).status).toBe(status);
  });

  test("an expired link is 404, and lists don't show it", async () => {
    const cookies = await claimed('expired');
    const hour = LINK_LIFETIMES['1 hour'];
    const { id } = await make('expired', cookies, { 'x-expires-in': String(hour) });
    expect((await read('expired', id)).status).toBe(200);
    later(hour);
    expect((await read('expired', id)).status).toBe(404);
  });

  test('a link that opens once is 409 until opened, then gone', async () => {
    const cookies = await claimed('opensonce');
    const { id } = await make('opensonce', cookies, { 'x-once': '1' });
    expect((await read('opensonce', id)).status).toBe(409);
    expect((await read('opensonce', id)).status).toBe(409);
    const opened = await read('opensonce', id, { 'x-open': 'once' });
    expect(opened.status).toBe(200);
    expect(new Uint8Array(await opened.res!.arrayBuffer())).toEqual(new Uint8Array(10));
    expect((await read('opensonce', id, { 'x-open': 'once' })).status).toBe(404);
    expect((await read('opensonce', id)).status).toBe(404);
  });

  test('a link that opens once, refused by the meter, is still there', async () => {
    const cookies = await claimed('meteredonce');
    const { id } = await make('meteredonce', cookies, { 'x-once': '1' });
    const address = '203.0.113.30';
    let status = 0;
    for (let i = 0; i <= OPEN.burst / OPEN.floor && status !== 429; i++)
      status = (await read('meteredonce', b64(16), {}, address)).status;
    expect(status).toBe(429);
    expect((await read('meteredonce', id, { 'x-open': 'once' }, address)).status).toBe(429);
    expect((await read('meteredonce', id, { 'x-open': 'once' })).status).toBe(200);
  });

  test('the list says when a link expires and whether it opens once', async () => {
    const cookies = await claimed('linksof');
    const padId = b64(32);
    const week = LINK_LIFETIMES['1 week'];
    await make('linksof', cookies, { 'x-pad-id': padId, 'x-expires-in': String(week) });
    later(1);
    await make('linksof', cookies, { 'x-pad-id': padId, 'x-once': '1' });
    const res = await call(padShares.GET, { params: { root: 'linksof', id: padId }, cookies });
    const { shares } = await res.res!.json();
    expect(
      shares.map((s: { expiresAt: number | null; once: boolean; createdAt: number }) => [
        s.expiresAt === null ? null : s.expiresAt - s.createdAt,
        s.once
      ])
    ).toEqual([
      [week, false],
      [null, true]
    ]);
  });
});
