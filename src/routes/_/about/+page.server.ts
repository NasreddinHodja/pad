import { MAX_SHARE, MAX_DEPTH, MAX_PATH, MAX_SEGMENT } from '#lib/limits.ts';
import { ABSOLUTE, IDLE } from '#lib/server/auth.ts';
import { config } from '#lib/server/config.ts';
import { version } from '../../../../package.json';
import type { PageServerLoad } from './$types';

// This server's numbers, so the page says what holds here: an operator can
// change the limits (PAD_CONFIG).
export const load: PageServerLoad = () => ({
  version,
  padBytes: config.padBytes,
  rootBytes: config.rootBytes,
  rootPads: config.rootPads,
  linksPerRoot: config.linksPerRoot,
  linkBytes: MAX_SHARE,
  growthPerDay: config.growth.perSecond * 24 * 60 * 60,
  backoff: config.backoff,
  grace: config.grace,
  idle: IDLE,
  absolute: ABSOLUTE,
  path: { chars: MAX_PATH, segment: MAX_SEGMENT, depth: MAX_DEPTH }
});
