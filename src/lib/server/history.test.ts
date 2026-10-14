import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import * as pad from '../../routes/_/[root]/pads/[id]/+server.ts';
import * as one from '../../routes/_/[root]/pads/[id]/versions/[at]/+server.ts';
import * as versions from '../../routes/_/[root]/pads/[id]/versions/+server.ts';
import { ARGON2 } from '../limits.ts';
import { claim, unlock } from './auth.ts';
import { getVersion, listVersions, padVersion, putSealed, usage } from './db.ts';
import { MAX_SEALED, ROOT_BYTES, VERSION_GAP, VERSIONS } from './limits.ts';
import { GRACE, markPad, purge } from './trash.ts';

const bytes = (n: number) => Uint8Array.from(randomBytes(n));
const id = (c: string) => c.repeat(43);
const MIN = 60 * 1000;
const T = Date.UTC(2026, 9, 14);

afterEach(() => setSystemTime());

function claimed(root: string) {
  const auth = bytes(32);
  claim(root, { salt: bytes(16), argon2: ARGON2, auth, sealedKey: bytes(60) });
  const values = new Map<string, string>();
  const cookies = {
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => void values.set(name, value)
  } as unknown as Cookies;
  unlock(cookies, root);
  return cookies;
}

/** The handler's status, thrown or returned, and its response. */
async function call(
  handler: unknown,
  params: Record<string, string>,
  cookies: Cookies,
  init: RequestInit = {}
) {
  const url = new URL('http://pad.test/_/');
  const event = {
    request: new Request(url, {
      ...init,
      headers: { 'sec-fetch-site': 'same-origin', origin: url.origin, ...init.headers }
    }),
    url,
    params,
    cookies,
    getClientAddress: () => '192.0.2.9',
    setHeaders: () => {}
  } as unknown as RequestEvent;
  try {
    const res = await (handler as (e: RequestEvent) => Promise<Response>)(event);
    return { status: res.status, res };
  } catch (e) {
    return { status: (e as { status: number }).status, res: null };
  }
}

/** Writes `data` at `at`, returning its version. */
function at(time: number, root: string, pad: string, data: Uint8Array, force = false) {
  setSystemTime(time);
  return putSealed(root, pad, 'n', data, force);
}

test('a save keeps the text it overwrites once the newest kept is VERSION_GAP old', () => {
  claimed('history-gap');
  const [a, b, c, d] = [bytes(10), bytes(11), bytes(12), bytes(13)];
  const va = at(T, 'history-gap', id('a'), a);
  // None kept yet: the first text is.
  at(T + 1000, 'history-gap', id('a'), b);
  // The newest kept is a second old: b isn't kept.
  const vc = at(T + 2000, 'history-gap', id('a'), c);
  // VERSION_GAP since a: c, the last before the pause, is.
  at(T + VERSION_GAP, 'history-gap', id('a'), d);
  expect(VERSION_GAP).toBe(10 * MIN);
  expect(listVersions('history-gap', id('a'))).toEqual([
    { at: vc, bytes: 12 },
    { at: va, bytes: 10 }
  ]);
  expect(getVersion('history-gap', id('a'), va)).toEqual(a);
  expect(getVersion('history-gap', id('a'), vc)).toEqual(c);
  expect(usage('history-gap')).toMatchObject({ history: 22 });
});

test('a forced save keeps whatever its age, and past VERSIONS the oldest goes', () => {
  claimed('history-many');
  const kept: number[] = [];
  for (let i = 0; i <= VERSIONS + 2; i++)
    kept.push(at(T + i, 'history-many', id('a'), bytes(5), true));
  // The last write is the pad itself; before it, the newest VERSIONS.
  expect(VERSIONS).toBe(10);
  expect(listVersions('history-many', id('a')).map((v) => v.at)).toEqual(
    kept.slice(-VERSIONS - 1, -1).reverse()
  );
  expect(usage('history-many')).toMatchObject({ history: 5 * VERSIONS });
});

test("an emptied pad's last text is kept, and goes with the pad when it's purged", () => {
  claimed('history-emptied');
  const text = bytes(10);
  const v = at(T, 'history-emptied', id('a'), text);
  setSystemTime(T + 1000);
  markPad('history-emptied', id('a'));
  expect(listVersions('history-emptied', id('a'))).toEqual([{ at: v, bytes: 10 }]);
  expect(getVersion('history-emptied', id('a'), v)).toEqual(text);
  purge(T + 1000 + GRACE);
  expect(listVersions('history-emptied', id('a'))).toEqual([]);
  expect(usage('history-emptied')).toEqual({ bytes: 0, history: 0, pads: 0 });
});

test("a root at its quota drops its oldest versions for a save, which isn't refused", async () => {
  const cookies = claimed('history-full');
  const big = MAX_SEALED - 1000;
  // Pads whose versions alone are past the quota.
  const pads = Math.ceil(ROOT_BYTES / (big * VERSIONS)) + 1;
  let t = T;
  for (let p = 0; p < pads; p++)
    for (let i = 0; i <= VERSIONS; i++)
      at(t++, 'history-full', id(String.fromCharCode(97 + p)), bytes(big), true);
  const before = usage('history-full');
  expect(before.bytes).toBeLessThanOrEqual(ROOT_BYTES);
  expect(before.history).toBeGreaterThan(0);
  // The first pad's oldest went first.
  expect(listVersions('history-full', id('a')).length).toBeLessThan(VERSIONS);
  expect(listVersions('history-full', id(String.fromCharCode(97 + pads - 1))).length).toBe(
    VERSIONS
  );

  setSystemTime(t);
  const fresh = id('z');
  const { status } = await call(pad.PUT, { root: 'history-full', id: fresh }, cookies, {
    method: 'PUT',
    body: bytes(big),
    headers: { 'if-match': '"0"', 'x-pad-name': 'n' }
  });
  expect(status).toBe(200);
  const after = usage('history-full');
  expect(after.bytes).toBeLessThanOrEqual(ROOT_BYTES);
  expect(after.history).toBeLessThan(before.history);
});

test('x-keep: 1 keeps the overwritten text; the versions are listed and read by time', async () => {
  const cookies = claimed('history-restore');
  const save = (body: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) =>
    call(pad.PUT, { root: 'history-restore', id: id('a') }, cookies, {
      method: 'PUT',
      body,
      headers: {
        'if-match': `"${padVersion('history-restore', id('a'))}"`,
        'x-pad-name': 'n',
        ...headers
      }
    });
  const [a, b] = [bytes(10), bytes(11)];
  setSystemTime(T);
  expect((await save(a)).status).toBe(200);
  const va = padVersion('history-restore', id('a'));
  setSystemTime(T + 1000);
  expect((await save(b)).status).toBe(200);
  const vb = padVersion('history-restore', id('a'));
  setSystemTime(T + 2000);
  // b is a second old and a was kept a second ago: only x-keep keeps it.
  expect((await save(bytes(12), { 'x-keep': 'yes' })).status).toBe(400);
  expect((await save(bytes(12), { 'x-keep': '1' })).status).toBe(200);

  const list = await call(versions.GET, { root: 'history-restore', id: id('a') }, cookies);
  expect(await list.res!.json()).toEqual({
    versions: [
      { at: vb, bytes: 11 },
      { at: va, bytes: 10 }
    ]
  });
  const read = (time: string) =>
    call(one.GET, { root: 'history-restore', id: id('a'), at: time }, cookies);
  const got = await read(String(va));
  expect(got.status).toBe(200);
  expect(new Uint8Array(await got.res!.arrayBuffer())).toEqual(a);
  expect((await read(String(va + 1))).status).toBe(404);
  for (const bad of ['0', '-1', '1.5', 'x', '1'.repeat(16)])
    expect((await read(bad)).status).toBe(400);
  // Locked out: nothing.
  const other = claimed('history-other');
  expect((await call(versions.GET, { root: 'history-restore', id: id('a') }, other)).status).toBe(
    401
  );
});
