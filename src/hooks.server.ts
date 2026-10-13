import type { Handle } from '@sveltejs/kit/hooks';
import { requestWait } from '#lib/server/limits.ts';
import { purgeDue } from '#lib/server/trash.ts';

// From the app, so a server without deploy/Caddyfile's proxy has them too. The
// Content-Security-Policy is SvelteKit's (vite.config.ts): it needs a fresh
// nonce per page. Files from static/ and the build skip this hook.
const HEADERS = {
  // Ignored over plain HTTP (RFC 6797, 8.1). No includeSubDomains: the other
  // subdomains may not be this server.
  'strict-transport-security': 'max-age=63072000',
  'x-content-type-options': 'nosniff',
  // Links in a pad would otherwise tell the site they lead to the root's name
  // (the path under it is after the `#`, which a Referer never carries).
  'referrer-policy': 'no-referrer',
  // A page this one opens can't reach back into it through window.opener.
  'cross-origin-opener-policy': 'same-origin',
  // Other sites can't load the API's answers as images or scripts.
  'cross-origin-resource-policy': 'same-origin'
};

const INDEXED = new Set(['/', '/_/about']);

function secure(response: Response, path: string) {
  for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value);
  // A root's or a link's address names the root; only the home page and the
  // about page, which name none, are for search engines. A header, so it holds
  // for pages with no HTML of their own.
  if (!INDEXED.has(path)) response.headers.set('x-robots-tag', 'noindex');
  return response;
}

export const handle: Handle = async ({ event, resolve }) => {
  // First, so a refused request costs as little as can be.
  const wait = requestWait(event);
  if (wait)
    return secure(
      Response.json(
        { status: 429, message: `too many requests, wait ${wait}s` },
        { status: 429, headers: { 'retry-after': String(wait) } }
      ),
      event.url.pathname
    );
  // Before anything reads a root, so none is seen past its purge.
  purgeDue();
  return secure(await resolve(event), event.url.pathname);
};
