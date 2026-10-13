# Security

## Reporting a vulnerability

Report privately through GitHub: **Security → Report a vulnerability** on this
repository. Please don't open a public issue for it.

There are no releases yet: fixes go to `main`.

## What the server protects

Pad is one Bun process with one SQLite file (`PAD_DB`), meant to sit behind a
reverse proxy that terminates TLS: pad.nassu.online's container listens on
`127.0.0.1:5512` behind Caddy (`deploy/Caddyfile`). Pads are encrypted in the
browser, with keys derived from their root's password, so what the server
guards is access, not the text:

- **Who may read and write a root.** Its sealed pads, their list, its links
  and its theme go only to a browser holding the root's unlock cookie; the
  server never has the key that opens them. A read-only link's copy goes to
  anyone with its id, sealed under a key only the link carries.
- **The password.** It never leaves the browser. The server keeps the SHA-256
  of a value derived from it with Argon2id, so a copy of the database is only
  good for guessing at Argon2id's cost.
- **The unlocks.** Cookie tokens are 256 random bits, stored only as their
  SHA-256, so a copy of the database opens nothing.

How the keys, the unlock and the read-only links work, and what a copy of the
database still shows: [Encryption and access](docs/architecture/encryption.org).

Who it guards against: anyone else who can reach the server, other sites open
in the same browser (other `nassu.online` subdomains included: a request that
changes anything needs `Sec-Fetch-Site: same-origin`, or a matching `Origin`),
and whoever gets a copy of the database.

## Guessing passwords

After five wrong passwords, each next try waits, from 1 s doubling up to 15
minutes, answered with `429` and the wait. A browser that has unlocked the
root before counts only its own failures, by a device cookie; any other
counts against its address (per `/64` for IPv6). Nothing counts per root,
which would let anyone lock its owners out. The numbers and why:
[Capacity and limits](docs/architecture/capacity.org).

## Headers

The app sets a Content-Security-Policy with a nonce per page
(`vite.config.ts`): only its own scripts run, plus WebAssembly for Argon2id,
and it connects only to itself. HSTS, `X-Content-Type-Options`,
`Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Resource-Policy` come from the app on pages and API answers
(`src/hooks.server.ts`); files from `static/` and the build skip the app's
hooks, so the proxy sets them there (`deploy/Caddyfile`).

## Reverse proxies

Rate limits and wrong-password counts go by the client's address: the peer's,
or, from an address in `PAD_TRUSTED_PROXIES`, the rightmost `X-Forwarded-For`
hop that isn't a trusted proxy (`src/lib/server/address.ts`). Unset behind a
proxy, every visitor shares the proxy's address and its limits.

## Where to look

`src/lib/crypto.ts` (everything derived and sealed in the browser),
`src/lib/server/auth.ts` (unlocking, cookies, the cross-site check),
`src/lib/server/limits.ts` (meters, quotas, backoff),
`src/lib/server/address.ts` (the client's address), `src/hooks.server.ts`,
`src/lib/server/shares.ts` and `src/lib/server/trash.ts`, with tests beside
each.

## Known limits

- **The server serves the code that does the encrypting.** An operator, or
  whoever takes over the server, can serve a page that sends the password or
  the text elsewhere. Nothing in the page can guard against the server it came
  from: trusting an instance means trusting its operator.
- **A lost password can't be reset.** Nothing on the server can open the
  pads.
- **Root names aren't secret.** A root's name is stored and sent in the
  clear: it's the path of every page of the root. The path under it is after
  the `#` (`/notes#today`), which browsers don't send, and the database keeps
  it only as HMACs. An address from before that change (`/notes/today`) still
  reaches the server once, to be redirected.
- **Sizes show.** A copy of the database shows how many pads a root has and
  how long each is.
- **A password change keeps the root key.** It signs every other browser
  out, but someone who knew the old password and kept the key can still read
  any sealed pad they get later, from the server or a copy of the database.
- **The first save claims a root.** Whoever saves under an unclaimed root
  first sets its password.
- **A read-only link is a bearer secret.** Anyone with the whole link reads
  its copy; revoking stops new reads, not what was already read.
- **Keys in the browser.** Unlocked keys sit in IndexedDB as non-extractable
  `CryptoKey`s: a script injected into the page could use them while it runs,
  though not read them out. The CSP is what keeps other scripts off the page.
- **Limits reset on restart.** Rate limits and wrong-password counts are kept
  in memory.
- **HTTPS only.** The browser's crypto runs only on HTTPS or `localhost`, and
  the cookies are `__Host-` and `Secure`.
- **No second factor.**
