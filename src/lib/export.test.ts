import { expect, test } from 'bun:test';
import { within } from './export.ts';

test('the pad and those under it, sorted', () => {
  expect(within(['notes/b', 'other', 'notes', 'notes/a', 'notesy'], 'notes')).toEqual([
    'notes',
    'notes/a',
    'notes/b'
  ]);
});

test("a name that isn't a path is left out: it would climb out of the zip's folder", () => {
  // Only a modified browser seals names like these; the server can't forge one.
  expect(within(['notes/../../x', 'notes/./a', 'notes//b', 'notes/ok'], 'notes')).toEqual([
    'notes/ok'
  ]);
});
