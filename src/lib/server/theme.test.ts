import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { ARGON2 } from '../limits.ts';
import { claim } from './auth.ts';
import { getTheme, setTheme } from './theme.ts';
import { deleteRoot, purgeRoot } from './trash.ts';

const bytes = (n: number) => new Uint8Array(randomBytes(n));

test("a root's theme is kept until the root is purged", () => {
  claim('themed', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) });
  expect(getTheme('themed')).toBeNull();
  const sealed = bytes(73);
  setTheme('themed', sealed);
  expect(getTheme('themed')).toEqual(sealed);
  deleteRoot('themed');
  purgeRoot('themed');
  expect(getTheme('themed')).toBeNull();
});
