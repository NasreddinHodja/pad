import { normalizePath } from './limits.ts';

// A pad's address: its root in the path, the rest after the `#`, which the
// browser never sends, so the server learns which root is open but not which
// pad under it.

const encode = (parts: string[]) => parts.map(encodeURIComponent).join('/');

/** `['a', 'b c', 'd']` → `/a#b%20c/d`; `query` goes between the two. */
export const href = ([root, ...rest]: string[], query = '') =>
  '/' + encodeURIComponent(root) + query + (rest.length ? '#' + encode(rest) : '');

/** The pad `url` is at: its root's segment and the segments after its `#`. Null if none can be. */
export function pathOf(url: { pathname: string; hash: string }): string | null {
  try {
    const root = decodeURIComponent(url.pathname.slice(1));
    const rest = url.hash.slice(1).split('/').map(decodeURIComponent);
    if (root.includes('/')) return null;
    return normalizePath([root, ...rest].join('/')) || null;
  } catch {
    return null;
  }
}
