import { error, json } from '@sveltejs/kit';
import { body, bytes, ours, rootParam, unlocked } from '#lib/server/api.ts';
import {
  attemptKeys,
  AUTH_BYTES,
  claim,
  lock,
  rememberDevice,
  SALT_BYTES,
  SEALED_KEY_BYTES,
  setPassword,
  unlock,
  verify
} from '#lib/server/auth.ts';
import { failed, meterOpen, meterWrite, owedWait, succeeded } from '#lib/server/limits.ts';
import { deleteRoot, reclaimRoot } from '#lib/server/trash.ts';
import type { RequestEvent, RequestHandler } from './$types';

/**
 * The sealed root key if `auth` is right, backing off repeated misses: a
 * browser that has unlocked the root before on its own misses, any other on
 * its address's.
 */
function attempt(event: RequestEvent, root: string, auth: Uint8Array) {
  const keys = attemptKeys(event.cookies, root, event.getClientAddress());
  const wait = owedWait(keys);
  if (wait) error(429, `too many wrong passwords, wait ${Math.ceil(wait / 1000)}s`);
  const sealedKey = verify(root, auth);
  if (!sealedKey) {
    failed(keys);
    error(401, 'wrong password');
  }
  succeeded(keys);
  rememberDevice(event.cookies, root);
  return sealedKey;
}

function newPassword(data: Record<string, unknown>) {
  return {
    salt: bytes(data.salt, SALT_BYTES),
    auth: bytes(data.auth, AUTH_BYTES),
    sealedKey: bytes(data.sealedKey, SEALED_KEY_BYTES)
  };
}

export const POST: RequestHandler = async (event) => {
  ours(event);
  const root = rootParam(event.params.root);
  const { cookies } = event;
  // Claiming, unlocking and locking are anyone's, metered by address; the
  // rest are metered on the root once unlocked, or a stranger could drain it.
  if (!['password', 'delete'].includes(event.params.action)) meterOpen(event);

  switch (event.params.action) {
    case 'claim': {
      const next = newPassword(await body(event.request));
      if (!claim(root, next.salt, next.auth, next.sealedKey))
        error(409, `someone just claimed /${root}, ask them for the password`);
      unlock(cookies, root);
      rememberDevice(cookies, root);
      return new Response(null, { status: 204 });
    }

    // A deleted root's password reclaims it.
    case 'unlock': {
      const sealedKey = attempt(event, root, bytes((await body(event.request)).auth, AUTH_BYTES));
      reclaimRoot(root);
      unlock(cookies, root);
      return json({ sealedKey: Buffer.from(sealedKey).toString('base64url') });
    }

    // Signs every other browser out of the root.
    case 'password': {
      unlocked(event, root);
      meterWrite(event, root);
      const data = await body(event.request);
      const next = newPassword(data);
      attempt(event, root, bytes(data.current, AUTH_BYTES));
      setPassword(root, next, cookies);
      return new Response(null, { status: 204 });
    }

    // Marks the root and its pads, and signs every browser out of it.
    case 'delete':
      unlocked(event, root);
      meterWrite(event, root);
      deleteRoot(root);
      return new Response(null, { status: 204 });

    case 'lock':
      lock(cookies, root);
      return new Response(null, { status: 204 });
  }
  error(404, 'no such action');
};
