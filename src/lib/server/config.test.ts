import { expect, test } from 'bun:test';
import { DEFAULTS, parseConfig } from './config.ts';

test('an empty file is the defaults', () => {
  expect(parseConfig('{}')).toEqual(DEFAULTS);
});

test('a key given replaces its default, a bucket key by key', () => {
  const config = parseConfig('{"rootBytes": 1048576, "writes": {"perSecond": 2048}}');
  expect(config.rootBytes).toBe(1048576);
  expect(config.writes).toEqual({ ...DEFAULTS.writes, perSecond: 2048 });
  expect(config.open).toEqual(DEFAULTS.open);
});

test("anything it can't take stops the server", () => {
  expect(() => parseConfig('{')).toThrow('not JSON');
  expect(() => parseConfig('[]')).toThrow('must be an object');
  expect(() => parseConfig('{"rootbytes": 1}')).toThrow('unknown key rootbytes');
  expect(() => parseConfig('{"writes": {"rate": 1}}')).toThrow('unknown key writes.rate');
  expect(() => parseConfig('{"writes": 5}')).toThrow('writes must be an object');
  expect(() => parseConfig('{"rootBytes": "16M"}')).toThrow('must be a number');
  expect(() => parseConfig('{"grace": -1}')).toThrow('must be a number');
  expect(() => parseConfig('{"rootPads": 1.5}')).toThrow('whole number');
  expect(() => parseConfig('{"writes": {"perSecond": 0}}')).toThrow('more than 0');
  expect(() => parseConfig('{"growth": {"floor": 0}}')).not.toThrow();
});
