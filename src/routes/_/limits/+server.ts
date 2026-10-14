import { json } from '@sveltejs/kit';
import * as limits from '#lib/server/limits.ts';
import { MAX_SHARE } from '#lib/limits.ts';
import { GRACE, RETENTION } from '#lib/server/trash.ts';
import type { RequestHandler } from './$types';

// Every limit in effect, for a client or an operator to ask rather than read
// the source. Sizes in bytes, times in milliseconds. The ones an operator can
// change are PAD_CONFIG's keys (config.ts).
export const GET: RequestHandler = () =>
  json({
    padBytes: limits.MAX_BYTES,
    padNameChars: limits.MAX_SEALED_NAME,
    pathChars: limits.MAX_PATH,
    segmentChars: limits.MAX_SEGMENT,
    depth: limits.MAX_DEPTH,
    themeBytes: limits.MAX_THEME,
    linkBytes: MAX_SHARE,
    linksPerRoot: limits.MAX_SHARES,
    serverBytes: limits.SERVER_BYTES,
    rootBytes: limits.ROOT_BYTES,
    rootPads: limits.ROOT_PADS,
    writes: limits.WRITES,
    open: limits.OPEN,
    growth: limits.GROWTH,
    requests: limits.REQUESTS,
    concurrent: limits.CONCURRENT,
    backoff: { free: limits.BACKOFF_FREE, maxWait: limits.BACKOFF_MAX },
    grace: GRACE,
    retention: RETENTION,
    versions: limits.VERSIONS,
    versionGap: limits.VERSION_GAP
  });
