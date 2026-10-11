// Limits the browser and the server both keep.

/** A read-only link's copy, deflated and sealed: the server takes bodies of 1 MiB. */
export const MAX_SHARE = 1024 * 1024;

export const MAX_PATH = 255;
export const MAX_SEGMENT = 64;
export const MAX_DEPTH = 10;

/** `a//b/` → `a/b`. Null if it can't be a pad. */
export function normalizePath(raw: string): string | null {
  const segments = raw.split('/').filter((s) => s !== '');
  // `/_/…` is the API's.
  if (segments[0] === '_') return null;
  const path = segments.join('/');
  if (path.length > MAX_PATH || segments.length > MAX_DEPTH) return null;
  for (const s of segments) {
    // eslint-disable-next-line no-control-regex
    if (s.length > MAX_SEGMENT || s === '.' || s === '..' || /[\u0000-\u001f\u007f]/.test(s))
      return null;
  }
  return path;
}
