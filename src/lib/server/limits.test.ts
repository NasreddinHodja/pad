import { describe, expect, test } from 'bun:test';
import {
  failed,
  limitKey,
  lru,
  MAX_DEPTH,
  MAX_PATH,
  MAX_SEGMENT,
  meter,
  normalizePath,
  owedWait,
  succeeded
} from './limits.ts';

describe('normalizePath', () => {
  test('drops empty segments', () => {
    expect(normalizePath('a//b/')).toBe('a/b');
    expect(normalizePath('/')).toBe('');
  });

  test('refuses the API, dot segments and control characters', () => {
    expect(normalizePath('_/a')).toBeNull();
    expect(normalizePath('a/../b')).toBeNull();
    expect(normalizePath('a/./b')).toBeNull();
    expect(normalizePath('a\u0000b')).toBeNull();
    expect(normalizePath('a\u007fb')).toBeNull();
  });

  test('keeps to the limits', () => {
    expect(normalizePath('a'.repeat(MAX_SEGMENT))).not.toBeNull();
    expect(normalizePath('a'.repeat(MAX_SEGMENT + 1))).toBeNull();
    expect(normalizePath(Array(MAX_DEPTH).fill('a').join('/'))).not.toBeNull();
    expect(
      normalizePath(
        Array(MAX_DEPTH + 1)
          .fill('a')
          .join('/')
      )
    ).toBeNull();
    const long = Array(5).fill('a'.repeat(MAX_SEGMENT)).join('/');
    expect(long.length).toBeGreaterThan(MAX_PATH);
    expect(normalizePath(long)).toBeNull();
  });
});

test('wrong passwords are free a few times, then cost a wait', () => {
  const keys = ['ip:test'];
  for (let i = 0; i < 4; i++) failed(keys);
  expect(owedWait(keys)).toBe(0);
  failed(keys);
  expect(owedWait(keys)).toBeGreaterThan(0);
  succeeded(keys);
  expect(owedWait(keys)).toBe(0);
});

test('IPv6 addresses are counted per /64', () => {
  expect(limitKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
  expect(limitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
  expect(limitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(limitKey('::1')).toBe('0:0:0:0::/64');
  expect(limitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  expect(limitKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
  expect(limitKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
  expect(limitKey('192.0.2.1')).toBe('192.0.2.1');
});

test('lru forgets the least recently used key past its size', () => {
  const m = lru<number>(2);
  m.set('a', 1);
  m.set('b', 2);
  m.get('a');
  m.set('c', 3);
  expect(m.get('a')).toBe(1);
  expect(m.get('b')).toBeUndefined();
  expect(m.size).toBe(2);
});

describe('meter', () => {
  const bucket = { burst: 100, perSecond: 10, floor: 5 };

  test('takes up to the burst, then owes the refill time', () => {
    const m = meter(bucket);
    expect(m.take('k', 60, 0)).toBe(0);
    expect(m.take('k', 40, 0)).toBe(0);
    // 30 more at 10 a second.
    expect(m.take('k', 30, 0)).toBe(3000);
    // Refused takes cost nothing.
    expect(m.take('k', 30, 3000)).toBe(0);
  });

  test('charges the floor for small requests', () => {
    const m = meter(bucket);
    for (let i = 0; i < 20; i++) expect(m.take('k', 0, 0)).toBe(0);
    expect(m.take('k', 0, 0)).toBeGreaterThan(0);
  });

  test('refills no further than the burst', () => {
    const m = meter(bucket);
    m.take('k', 100, 0);
    expect(m.take('k', 100, 3_600_000)).toBe(0);
    expect(m.take('k', 10, 3_600_000)).toBeGreaterThan(0);
  });

  test('never passes a request bigger than the burst', () => {
    expect(meter(bucket).take('k', 101, 0)).toBe(Infinity);
  });

  test('keys are apart', () => {
    const m = meter(bucket);
    m.take('a', 100, 0);
    expect(m.take('b', 100, 0)).toBe(0);
  });
});
