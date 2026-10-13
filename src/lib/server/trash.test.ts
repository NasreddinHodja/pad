import type { Cookies } from '@sveltejs/kit';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { ARGON2 } from '../limits.ts';
import { access, claim, unlock, verify } from './auth.ts';
import { db, getSealed, listSealed, putSealed, usage } from './db.ts';
import { addShare, getShare } from './shares.ts';
import { deletedAt, deleteRoot, GRACE, markPad, purge, reclaimRoot } from './trash.ts';

function jar() {
  const values = new Map<string, string>();
  return {
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => void values.set(name, value)
  } as unknown as Cookies;
}

const bytes = (n: number) => new Uint8Array(randomBytes(n));
const id = (c: string) => c.repeat(43);
const link = (c: string) => c.repeat(22);

test('an emptied pad drops out, its links stay, and saving it again brings it back', () => {
  claim('empty', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  putSealed('empty', id('a'), 'name', bytes(10));
  addShare('empty', link('w'), id('a'), bytes(60), bytes(10));
  markPad('empty', id('a'));
  expect(getSealed('empty', id('a'))).toBeNull();
  expect(listSealed('empty')).toEqual([]);
  expect(getShare('empty', link('w'))).not.toBeNull();
  putSealed('empty', id('a'), 'name', bytes(10));
  expect(getSealed('empty', id('a'))).not.toBeNull();
});

test("an emptied pad's text and name leave at once; it still counts as a pad", () => {
  claim('drop', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  putSealed('drop', id('a'), 'name', bytes(10));
  markPad('drop', id('a'));
  expect(
    db.query("SELECT length(data) + length(name) AS n FROM sealed WHERE root = 'drop'").get()
  ).toEqual({ n: 0 });
  expect(usage('drop')).toEqual({ bytes: 0, pads: 1 });
});

test('a deleted root signs everyone out, and its password reclaims what was deleted with it', () => {
  const auth = bytes(32);
  claim('gone', { salt: bytes(16), argon2: ARGON2, auth, sealedKey: bytes(60) });
  const browser = jar();
  unlock(browser, 'gone');
  putSealed('gone', id('a'), 'name', bytes(10));
  putSealed('gone', id('b'), 'name', bytes(10));
  markPad('gone', id('b'));
  deleteRoot('gone');
  expect(access(browser, 'gone')).toBe('deleted');
  expect(listSealed('gone')).toEqual([]);
  expect(verify('gone', auth)).not.toBeNull();
  reclaimRoot('gone');
  expect(deletedAt('gone')).toBeNull();
  expect(listSealed('gone').map((p) => p.id)).toEqual([id('a')]);
  expect(access(browser, 'gone')).toBe('locked');
});

test('claiming a deleted root anew purges it first', () => {
  const old = bytes(32);
  claim('anew', { salt: bytes(16), argon2: ARGON2, auth: old, sealedKey: bytes(60) });
  putSealed('anew', id('a'), 'name', bytes(10));
  addShare('anew', link('x'), id('a'), bytes(60), bytes(10));
  deleteRoot('anew');
  expect(
    claim('anew', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) })
  ).toBe(true);
  expect(verify('anew', old)).toBeNull();
  expect(deletedAt('anew')).toBeNull();
  reclaimRoot('anew');
  expect(listSealed('anew')).toEqual([]);
  expect(getShare('anew', link('x'))).toBeNull();
});

test('a purge takes only what has been marked longer than the grace', () => {
  claim('old', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  putSealed('old', id('a'), 'name', bytes(10));
  deleteRoot('old');
  claim('kept', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  putSealed('kept', id('a'), 'name', bytes(10));
  putSealed('kept', id('b'), 'name', bytes(10));
  addShare('kept', link('y'), id('b'), bytes(60), bytes(10));
  markPad('kept', id('b'));
  purge(Date.now() + GRACE - 60_000);
  expect(deletedAt('old')).not.toBeNull();
  purge(Date.now() + GRACE + 1);
  expect(access(jar(), 'old')).toBe('open');
  expect(listSealed('kept').map((p) => p.id)).toEqual([id('a')]);
  expect(getShare('kept', link('y'))).not.toBeNull();
});

const DAY = 24 * 60 * 60 * 1000;
const usedAt = (root: string) =>
  db.query<{ used_at: number }, [string]>('SELECT used_at FROM roots WHERE name = ?').get(root)!
    .used_at;
const unused = (root: string, ago: number) =>
  db.query('UPDATE roots SET used_at = ? WHERE name = ?').run(Date.now() - ago, root);

test('a root unused for the retention is deleted, and its password brings it back', () => {
  claim('idle', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  claim('busy', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  putSealed('idle', id('a'), 'name', bytes(10));
  const browser = jar();
  unlock(browser, 'idle');
  unused('idle', 2 * DAY);
  unused('busy', DAY / 2);
  purge(Date.now(), DAY);
  expect(deletedAt('idle')).not.toBeNull();
  expect(access(browser, 'idle')).toBe('deleted');
  expect(deletedAt('busy')).toBeNull();
  // What the unlock route does with the right password.
  reclaimRoot('idle');
  unlock(browser, 'idle');
  purge(Date.now(), DAY);
  expect(deletedAt('idle')).toBeNull();
  expect(listSealed('idle').map((p) => p.id)).toEqual([id('a')]);
});

test('without a retention, no root is deleted for being unused', () => {
  claim('still', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  unused('still', 10_000 * DAY);
  purge(Date.now());
  expect(deletedAt('still')).toBeNull();
});

test('a root open in a browser counts as used, once an hour', () => {
  claim('open', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  const browser = jar();
  unlock(browser, 'open');
  unused('open', DAY);
  access(browser, 'open');
  // The unlock was just touched: not written again within the hour.
  expect(usedAt('open')).toBeLessThan(Date.now() - DAY / 2);
  db.query("UPDATE unlocks SET last_seen = ? WHERE root = 'open'").run(Date.now() - DAY);
  access(browser, 'open');
  expect(usedAt('open')).toBeGreaterThan(Date.now() - 60_000);
});

test('a purge zeroes what it deletes, and the WAL keeps no old pages', () => {
  const pragma = (name: string) =>
    Object.values(db.query(`PRAGMA ${name}`).get() as Record<string, number>)[0];
  expect(pragma('secure_delete')).toBe(1);
  expect(pragma('journal_size_limit')).toBe(0);
});

test('a purge deletes expired links', () => {
  claim('lapsed', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  const made = addShare('lapsed', link('z'), id('a'), bytes(61), bytes(10), {
    lifetime: 1000,
    once: false
  }) as number;
  purge(made + 999);
  expect(getShare('lapsed', link('z'), made)).not.toBeNull();
  purge(made + 1000);
  expect(getShare('lapsed', link('z'), made)).toBeNull();
});
