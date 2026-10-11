import { describe, expect, test } from 'bun:test';
import { href, pathOf } from './href.ts';

const at = (url: string) => pathOf(new URL(url, 'https://pad.test'));

describe('href', () => {
  test('a root is its path alone', () => {
    expect(href(['a'])).toBe('/a');
  });

  test('the rest goes after the #, each segment encoded', () => {
    expect(href(['a', 'b c', 'd#e'])).toBe('/a#b%20c/d%23e');
  });

  test('a query goes before the #', () => {
    expect(href(['a', 'b'], '?password')).toBe('/a?password#b');
    expect(href(['a'], '?password')).toBe('/a?password');
  });
});

describe('pathOf', () => {
  test('reads back what href makes', () => {
    for (const parts of [['a'], ['a', 'b'], ['a', 'b c', 'd#e', 'ü']])
      expect(at(href(parts))).toBe(parts.join('/'));
  });

  test('ignores the query', () => {
    expect(at('/a?password#b')).toBe('a/b');
  });

  test('normalizes as the server does', () => {
    expect(at('/a#b//c/')).toBe('a/b/c');
    expect(at('/a#')).toBe('a');
  });

  test('null for what no pad can be', () => {
    expect(at('/')).toBeNull();
    expect(at('/_#a')).toBeNull();
    expect(at('/a#../b')).toBeNull();
    expect(at('/a#%E0%A4%A')).toBeNull();
    expect(at('/a/b')).toBeNull();
  });
});
