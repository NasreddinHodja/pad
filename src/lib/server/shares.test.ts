import { expect, setSystemTime, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { ARGON2 } from '../limits.ts';
import { claim } from './auth.ts';
import {
  addShare,
  getShare,
  listShares,
  removeExpired,
  removeShare,
  removeShares,
  takeShare
} from './shares.ts';
import { MAX_SHARES } from './limits.ts';

const bytes = (n: number) => new Uint8Array(n).fill(1);
const pad = 'p'.repeat(43);

for (const root of ['linked', 'ours', 'taken', 'all', 'else', 'expiring', 'once', 'many'])
  claim(root, {
    salt: randomBytes(16),
    argon2: ARGON2,
    auth: randomBytes(32),
    sealedKey: randomBytes(60)
  });

test('a link is listed under its pad, read by its id and gone once revoked', () => {
  const made = addShare('linked', 'a'.repeat(22), pad, bytes(60), bytes(10));
  expect(typeof made).toBe('number');
  expect(listShares('linked', pad).map((s) => s.id)).toEqual(['a'.repeat(22)]);
  expect(listShares('linked', 'q'.repeat(43))).toEqual([]);
  expect(getShare('linked', 'a'.repeat(22))?.data).toEqual(bytes(10));
  removeShare('linked', 'a'.repeat(22));
  expect(getShare('linked', 'a'.repeat(22))).toBeNull();
});

test("a link is only another root's to read or revoke by its own root", () => {
  addShare('ours', 'b'.repeat(22), pad, bytes(60), bytes(10));
  expect(getShare('theirs', 'b'.repeat(22))).toBeNull();
  removeShare('theirs', 'b'.repeat(22));
  expect(getShare('ours', 'b'.repeat(22))).not.toBeNull();
});

test('an id is used once', () => {
  addShare('taken', 'c'.repeat(22), pad, bytes(60), bytes(10));
  expect(addShare('taken', 'c'.repeat(22), pad, bytes(60), bytes(10))).toBe('taken');
});

test("revoking a pad's links leaves other pads' and roots'", () => {
  const other = 'o'.repeat(43);
  addShare('all', 'd'.repeat(22), pad, bytes(60), bytes(10));
  addShare('all', 'e'.repeat(22), pad, bytes(60), bytes(10));
  addShare('all', 'f'.repeat(22), other, bytes(60), bytes(10));
  addShare('else', 'g'.repeat(22), pad, bytes(60), bytes(10));
  removeShares('all', pad);
  expect(listShares('all', pad)).toEqual([]);
  expect(listShares('all', other)).toHaveLength(1);
  expect(listShares('else', pad)).toHaveLength(1);
});

test('an expired link is gone to reads and lists, and the purge deletes it', () => {
  const made = addShare('expiring', 'h'.repeat(22), pad, bytes(61), bytes(10), {
    lifetime: 1000,
    once: false
  }) as number;
  expect(getShare('expiring', 'h'.repeat(22), made + 999)).not.toBeNull();
  expect(listShares('expiring', pad, made + 999)).toHaveLength(1);
  expect(listShares('expiring', pad, made + 999)[0]!.expires_at).toBe(made + 1000);
  expect(getShare('expiring', 'h'.repeat(22), made + 1000)).toBeNull();
  expect(takeShare('expiring', 'h'.repeat(22), made + 1000)).toBeNull();
  expect(listShares('expiring', pad, made + 1000)).toEqual([]);
  removeExpired(made + 999);
  expect(getShare('expiring', 'h'.repeat(22), made)).not.toBeNull();
  removeExpired(made + 1000);
  expect(getShare('expiring', 'h'.repeat(22), made)).toBeNull();
});

test('a link that opens once is looked at as often as asked, and taken once', () => {
  addShare('once', 'i'.repeat(22), pad, bytes(61), bytes(10), { lifetime: null, once: true });
  expect(getShare('once', 'i'.repeat(22))?.once).toBe(1);
  expect(getShare('once', 'i'.repeat(22))?.once).toBe(1);
  expect(takeShare('once', 'i'.repeat(22))?.data).toEqual(bytes(10));
  expect(takeShare('once', 'i'.repeat(22))).toBeNull();
  expect(getShare('once', 'i'.repeat(22))).toBeNull();
});

test("expired links don't count toward a root's", () => {
  const now = Date.now();
  setSystemTime(now);
  const ids = Array.from({ length: MAX_SHARES }, (_, i) => String(i).padStart(22, 'j'));
  for (const id of ids)
    addShare('many', id, pad, bytes(61), bytes(1), { lifetime: 1, once: false });
  expect(addShare('many', 'k'.repeat(22), pad, bytes(61), bytes(1))).toBe('full');
  setSystemTime(now + 1);
  expect(typeof addShare('many', 'k'.repeat(22), pad, bytes(61), bytes(1))).toBe('number');
  setSystemTime();
});
