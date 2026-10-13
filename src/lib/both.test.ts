import { expect, test } from 'bun:test';
import { both } from './both.ts';

test('the same text is itself', () => {
  expect(both('a\nb', 'a\nb').text).toBe('a\nb');
});

test('the lines in common once, what differs between markers', () => {
  const mine = 'list\nmilk, eggs\nend';
  const { text, at } = both(mine, 'list\nmilk, bread\nend');
  expect(text).toBe(
    'list\n<<<<<<< this browser\nmilk, eggs\n=======\nmilk, bread\n>>>>>>> elsewhere\nend'
  );
  // A place in each part of mine lands on the same character.
  for (const i of [0, 4, 5, 9, 15, 16, mine.length]) expect(text[at(i)]).toBe(mine[i]);
});

test('nothing in common, an emptied side, an added line', () => {
  expect(both('a', 'b').text).toBe('<<<<<<< this browser\na\n=======\nb\n>>>>>>> elsewhere');
  expect(both('', 'b').text).toBe('<<<<<<< this browser\n\n=======\nb\n>>>>>>> elsewhere');
  expect(both('a', '').text).toBe('<<<<<<< this browser\na\n=======\n\n>>>>>>> elsewhere');
  const added = both('a\nb', 'a\nx\nb');
  expect(added.text).toBe('a\n<<<<<<< this browser\n=======\nx\n>>>>>>> elsewhere\nb');
  expect(added.text.slice(added.at(2))).toBe('b');
});
