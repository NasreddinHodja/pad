import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { claim } from './auth.ts';
import { addShare, getShare, listShares, removeShare, removeShares } from './shares.ts';

const bytes = (n: number) => new Uint8Array(n).fill(1);
const pad = 'p'.repeat(43);

for (const root of ['linked', 'ours', 'taken', 'all', 'else'])
  claim(root, randomBytes(16), randomBytes(32), randomBytes(60));

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
