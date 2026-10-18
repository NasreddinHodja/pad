// What an operator learns without a log: once an hour at most, a line on
// stdout with how many requests were refused (429), failed (5xx) and carried a
// wrong password since the last line, how many things browsers said the CSP
// blocked (routes/_/csp), and how full the database is. Counts
// only: no address, root or path. Like the purge, requests set it off
// (hooks.server.ts), so a quiet server writes nothing.

import { used } from './db.ts';

/** How often a line may be written. */
const REPORT_EVERY = 60 * 60 * 1000;
/** Past this share of its ceiling, the line is a warning. */
const NEARLY_FULL = 0.9;

const counts = { refused: 0, failed: 0, wrongPasswords: 0, csp: 0 };
let lastReport = Date.now();

/** A response, by its status. */
export function count(status: number) {
  if (status === 429) counts.refused++;
  else if (status >= 500) counts.failed++;
}

export function wrongPassword() {
  counts.wrongPasswords++;
}

export function blockedByCsp() {
  counts.csp++;
}

const MiB = 1024 * 1024;

/** The line for the counts since the last call, which starts them over; null if there's nothing to say. */
export function report(now = Date.now()) {
  const { bytes, ceiling } = used();
  const share = bytes / ceiling;
  const { refused, failed, wrongPasswords, csp } = counts;
  const minutes = Math.round((now - lastReport) / 60_000);
  counts.refused = counts.failed = counts.wrongPasswords = counts.csp = 0;
  lastReport = now;
  if (!refused && !failed && !wrongPasswords && !csp && share < NEARLY_FULL) return null;
  return (
    `${share >= NEARLY_FULL ? 'warning: database nearly full; ' : ''}` +
    `last ${minutes} min: ${refused} refused (429), ${failed} failed (5xx), ` +
    `${wrongPasswords} wrong passwords, ${csp} blocked by the CSP; database ${Math.round(bytes / MiB)} MiB ` +
    `of ${Math.round(ceiling / MiB)} MiB (${Math.round(share * 100)}%)`
  );
}

/** Writes the line, at most once every REPORT_EVERY. */
export function reportDue(now = Date.now()) {
  if (now - lastReport < REPORT_EVERY) return;
  const line = report(now);
  if (line) console.log(line);
}
