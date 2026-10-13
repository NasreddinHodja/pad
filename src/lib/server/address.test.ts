import { describe, expect, test } from 'bun:test';
import { trustedProxies } from './address.ts';

describe('trustedProxies', () => {
  const client = trustedProxies(' 127.0.0.1, 10.0.0.0/8 ,::1, fd00::/8');

  test('an untrusted peer is the client, whatever it forwards', () => {
    expect(client('198.51.100.1', '203.0.113.9')).toBe('198.51.100.1');
  });

  test("a trusted peer gives the rightmost hop that isn't a proxy", () => {
    expect(client('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
    // The client wrote the first hop itself.
    expect(client('127.0.0.1', '192.0.2.66, 203.0.113.9')).toBe('203.0.113.9');
    expect(client('127.0.0.1', '203.0.113.9, 10.1.2.3')).toBe('203.0.113.9');
    expect(client('::1', '2001:db8::1, fd12::3')).toBe('2001:db8::1');
  });

  test('a dual-stack peer is matched as IPv4', () => {
    expect(client('::ffff:127.0.0.1', '203.0.113.9')).toBe('203.0.113.9');
  });

  test('a trusted peer forwarding nothing is the client', () => {
    expect(client('127.0.0.1', null)).toBe('127.0.0.1');
  });

  test('an unreadable hop ends the chain at the last readable one', () => {
    expect(client('127.0.0.1', '203.0.113.9, nonsense, 10.0.0.2')).toBe('10.0.0.2');
    expect(client('127.0.0.1', 'nonsense')).toBe('127.0.0.1');
  });

  test('every hop a proxy: the leftmost', () => {
    expect(client('127.0.0.1', '10.0.0.1, 10.0.0.2')).toBe('10.0.0.1');
  });

  test('nothing trusted: always the peer', () => {
    expect(trustedProxies('')('127.0.0.1', '203.0.113.9')).toBe('127.0.0.1');
  });

  test('a bad entry stops the server', () => {
    expect(() => trustedProxies('localhost')).toThrow('not an address');
    expect(() => trustedProxies('10.0.0.0/33')).toThrow('bad prefix');
    expect(() => trustedProxies('10.0.0.0/x')).toThrow('bad prefix');
  });
});
