import type { Handle } from '@sveltejs/kit/hooks';
import { address } from '#lib/server/address.ts';
import { endRequest, limitKey, requestWait, startRequest } from '#lib/server/limits.ts';
import { count, reportDue } from '#lib/server/signals.ts';
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
  'cross-origin-resource-policy': 'same-origin',
  // What a page could ask the browser for that pad never does, refused for
  // it and any frame (developer.mozilla.org, Permissions-Policy). The
  // clipboard, which pad writes links to, isn't among them.
  'permissions-policy': [
    'accelerometer',
    'bluetooth',
    'browsing-topics',
    'camera',
    'display-capture',
    'geolocation',
    'gyroscope',
    'hid',
    'idle-detection',
    'local-fonts',
    'magnetometer',
    'microphone',
    'midi',
    'payment',
    'serial',
    'usb'
  ]
    .map((feature) => `${feature}=()`)
    .join(', ')
};

const INDEXED = new Set(['/', '/_/about']);

function secure(response: Response, path: string) {
  count(response.status);
  for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value);
  // A root's or a link's address names the root; only the home page and the
  // about page, which name none, are for search engines. A header, so it holds
  // for pages with no HTML of their own.
  if (!INDEXED.has(path)) response.headers.set('x-robots-tag', 'noindex');
  return response;
}

const refuse = (message: string, wait: number, path: string) =>
  secure(
    Response.json(
      { status: 429, message },
      { status: 429, headers: { 'retry-after': String(wait) } }
    ),
    path
  );

/**
 * `response`, calling `done` once its body is sent whole or dropped (the
 * client went away, or its connection timed out); at once if it has none.
 */
function whenSent(response: Response, done: () => void) {
  let called = false;
  const finish = () => {
    if (called) return;
    called = true;
    done();
  };
  if (!response.body) {
    finish();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const { done: end, value } = await reader.read();
          if (end) {
            finish();
            controller.close();
          } else controller.enqueue(value);
        } catch (e) {
          finish();
          controller.error(e);
        }
      },
      cancel(reason) {
        finish();
        return reader.cancel(reason);
      }
    },
    // What the route's body has, read only as the client reads.
    { highWaterMark: 0 }
  );
  return new Response(body, response);
}

// The answers that carry pads: a pad, a batch of them, a kept version, a
// link's copy. Only these are big enough for an unread one to matter, and
// counting one costs a stream around its body: every response so wrapped took
// 28-35% off page loads (docs/architecture/capacity.org).
const CARRIES_PADS = /^\/_\/[^/]+\/(pads\/[^/]+(\/versions\/[^/]+)?|shares\/[^/]+)$/;

export const handle: Handle = async ({ event, resolve }) => {
  const path = event.url.pathname;
  // First, so a refused request costs as little as can be.
  const wait = requestWait(event);
  if (wait) return refuse(`too many requests, wait ${wait}s`, wait, path);
  // Before anything reads a root, so none is seen past its purge.
  purgeDue();
  reportDue();
  if (!CARRIES_PADS.test(path)) return secure(await resolve(event), path);
  const key = limitKey(address(event));
  if (!startRequest(key))
    return refuse('too many requests at once, wait for some to finish', 1, path);
  let response;
  try {
    response = await resolve(event);
  } catch (e) {
    endRequest(key);
    throw e;
  }
  return secure(
    whenSent(response, () => endRequest(key)),
    path
  );
};
