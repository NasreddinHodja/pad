import type { Cookies } from '@sveltejs/kit';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
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
  claim('empty', bytes(16), bytes(32), bytes(60));
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
  claim('drop', bytes(16), bytes(32), bytes(60));
  putSealed('drop', id('a'), 'name', bytes(10));
  markPad('drop', id('a'));
  expect(
    db.query("SELECT length(data) + length(name) AS n FROM sealed WHERE root = 'drop'").get()
  ).toEqual({ n: 0 });
  expect(usage('drop')).toEqual({ bytes: 0, pads: 1 });
});

test('a deleted root signs everyone out, and its password reclaims what was deleted with it', () => {
  const auth = bytes(32);
  claim('gone', bytes(16), auth, bytes(60));
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
  claim('anew', bytes(16), old, bytes(60));
  putSealed('anew', id('a'), 'name', bytes(10));
  addShare('anew', link('x'), id('a'), bytes(60), bytes(10));
  deleteRoot('anew');
  expect(claim('anew', bytes(16), bytes(32), bytes(60))).toBe(true);
  expect(verify('anew', old)).toBeNull();
  expect(deletedAt('anew')).toBeNull();
  reclaimRoot('anew');
  expect(listSealed('anew')).toEqual([]);
  expect(getShare('anew', link('x'))).toBeNull();
});

test('a purge takes only what has been marked longer than the grace', () => {
  claim('old', bytes(16), bytes(32), bytes(60));
  putSealed('old', id('a'), 'name', bytes(10));
  deleteRoot('old');
  claim('kept', bytes(16), bytes(32), bytes(60));
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
