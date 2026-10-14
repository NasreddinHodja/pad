// What the screens say about errors and times.

/** An error's message, or `fallback` for a throw that isn't an Error. */
export const message = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message : fallback;

/** A moment, as a date and a time in the reader's locale. */
export const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A day, in the reader's locale. */
export const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** A span of milliseconds, in whole days: `30 days`. */
export const days = (ms: number) => `${Math.round(ms / 86_400_000)} days`;
