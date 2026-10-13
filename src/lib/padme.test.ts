import { expect, test } from 'bun:test';
import { padded } from './padme.ts';

// Algorithm 1 of the PURBs paper, as written there, in integers.
function algorithm1(l: number) {
  const e = 31 - Math.clz32(l);
  const s = 32 - Math.clz32(e);
  const m = (1 << (e - s)) - 1;
  return (l + m) & ~m;
}

test('Padmé matches the paper', () => {
  for (let l = 2; l < 1 << 21; l++) expect(padded(l)).toBe(algorithm1(l));
  // The paper's example: 9 bytes are padded to 10.
  expect(padded(9)).toBe(10);
  expect(padded(0)).toBe(0);
  expect(padded(1)).toBe(1);
});

test('Padmé adds at most 12%, and the floor is a size of its own', () => {
  for (let l = 2; l < 1 << 21; l += 7) expect(padded(l) / l).toBeLessThan(1.12);
  expect(padded(3, 256)).toBe(256);
  expect(padded(256, 256)).toBe(256);
  expect(padded(257, 256)).toBe(272);
});
