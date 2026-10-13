import { expect, test } from 'bun:test';
import { setCeiling } from './db.ts';
import { SERVER_BYTES } from './limits.ts';
import { count, report, wrongPassword } from './signals.ts';

test('the line counts refusals, failures and wrong passwords, and starts them over', () => {
  report();
  for (const status of [200, 304, 401, 404, 429, 429, 500, 507]) count(status);
  wrongPassword();
  const line = report()!;
  expect(line).toContain('2 refused (429), 2 failed (5xx), 1 wrong passwords');
  expect(line).not.toContain('warning');
  expect(report()).toBeNull();
});

test('a nearly full database is a warning, with nothing else to count', () => {
  report();
  setCeiling(1);
  try {
    expect(report()).toStartWith('warning: database nearly full; ');
  } finally {
    setCeiling(SERVER_BYTES);
  }
});
