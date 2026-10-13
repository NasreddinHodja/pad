/**
 * Two texts in one, for a save refused over a newer version: the lines they
 * start and end with in common once, and between markers, what each has in
 * between. `at` moves a place in `mine` to where its text went.
 */
export function both(mine: string, theirs: string) {
  if (mine === theirs) return { text: mine, at: (i: number) => i };
  const a = mine.split('\n');
  const b = theirs.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  const text = [
    ...a.slice(0, start),
    '<<<<<<< this browser',
    ...a.slice(start, a.length - end),
    '=======',
    ...b.slice(start, b.length - end),
    '>>>>>>> elsewhere',
    ...a.slice(a.length - end)
  ].join('\n');
  // The characters of the common lines, newlines included.
  const head = a.slice(0, start).join('\n').length + (start ? 1 : 0);
  const tail = a.slice(a.length - end).join('\n').length + (end ? 1 : 0);
  return {
    text,
    at: (i: number) =>
      i < head
        ? i
        : i <= mine.length - tail
          ? i + '<<<<<<< this browser\n'.length
          : i + text.length - mine.length
  };
}
