import type { Cookies } from '@sveltejs/kit';
import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import {
  access,
  attemptKeys,
  claim,
  lock,
  rememberDevice,
  setPassword,
  unlock,
  verify
} from './auth.ts';
import { ARGON2 } from '../limits.ts';
import { failed, owedWait } from './limits.ts';

/** A browser's cookie jar, as much of it as auth.ts uses. */
function jar() {
  const values = new Map<string, string>();
  return {
    get: (name: string) => values.get(name),
    set: (name: string, value: string) => void values.set(name, value)
  } as unknown as Cookies;
}

const bytes = (n: number) => new Uint8Array(randomBytes(n));

function claimed(root: string) {
  const auth = bytes(32);
  const sealedKey = bytes(60);
  expect(claim(root, { salt: bytes(16), argon2: ARGON2, auth, sealedKey })).toBe(true);
  return { auth, sealedKey };
}

test('the first claim wins', () => {
  claimed('first');
  expect(
    claim('first', { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) })
  ).toBe(false);
});

test('verify gives the sealed key for the right auth only', () => {
  const { auth, sealedKey } = claimed('verify');
  expect(verify('verify', auth)).toEqual(sealedKey);
  expect(verify('verify', bytes(32))).toBeNull();
  expect(verify('nobody', auth)).toBeNull();
});

test('a browser is locked until it unlocks, and after it locks', () => {
  claimed('cookie');
  const browser = jar();
  expect(access(jar(), 'never-claimed')).toBe('open');
  expect(access(browser, 'cookie')).toBe('locked');
  unlock(browser, 'cookie');
  expect(access(browser, 'cookie')).toBe('unlocked');
  lock(browser, 'cookie');
  expect(access(browser, 'cookie')).toBe('locked');
});

test('unlocking another root keeps the first, with a new token', () => {
  claimed('one');
  claimed('two');
  const browser = jar();
  unlock(browser, 'one');
  const before = browser.get('pad');
  unlock(browser, 'two');
  expect(browser.get('pad')).not.toBe(before);
  expect(access(browser, 'one')).toBe('unlocked');
  expect(access(browser, 'two')).toBe('unlocked');
});

test('a password change signs out every other browser', () => {
  claimed('change');
  const mine = jar();
  const theirs = jar();
  unlock(mine, 'change');
  unlock(theirs, 'change');
  setPassword(
    'change',
    { salt: bytes(16), argon2: ARGON2, auth: bytes(32), sealedKey: bytes(60) },
    mine
  );
  expect(access(mine, 'change')).toBe('unlocked');
  expect(access(theirs, 'change')).toBe('locked');
});

test("strangers failing a root's password hold up no one but themselves", () => {
  claimed('device');
  const owner = jar();
  rememberDevice(owner, 'device');
  const stranger = attemptKeys(jar(), 'device', '203.0.113.1');
  for (let i = 0; i < 10; i++) failed(stranger);
  expect(owedWait(stranger)).toBeGreaterThan(0);
  // Not someone new at another address, nor the owner at the stranger's.
  expect(owedWait(attemptKeys(jar(), 'device', '203.0.113.2'))).toBe(0);
  expect(owedWait(attemptKeys(owner, 'device', '203.0.113.1'))).toBe(0);
  // Locking keeps the device known.
  unlock(owner, 'device');
  lock(owner, 'device');
  expect(attemptKeys(owner, 'device', 'x')).toHaveLength(1);
});

test('a device is known only at the roots it unlocked', () => {
  claimed('mine');
  const browser = jar();
  rememberDevice(browser, 'mine');
  expect(attemptKeys(browser, 'mine', '203.0.113.1')).toHaveLength(1);
  expect(attemptKeys(browser, 'other', '203.0.113.1')).toEqual(['ip:203.0.113.1']);
});
