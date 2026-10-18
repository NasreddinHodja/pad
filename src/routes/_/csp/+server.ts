import { blockedByCsp } from '#lib/server/signals.ts';
import type { RequestHandler } from './$types';

// Where browsers report what the Content-Security-Policy blocked (vite.config.ts,
// report-uri): an injected script, or an extension's. Counted for the hourly
// line (signals.ts), never read: a report names the page and what was blocked,
// and pad keeps no logs. Anyone can post here; the most a stranger gets is a
// higher count.
export const POST: RequestHandler = () => {
  blockedByCsp();
  return new Response(null, { status: 204 });
};
