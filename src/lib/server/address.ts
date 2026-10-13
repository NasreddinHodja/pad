// Who a request is from, behind a reverse proxy: the limits and the
// wrong-password backoff count by it. X-Forwarded-For is only believed from
// the addresses in PAD_TRUSTED_PROXIES, since anyone else can send it, as
// konigslibrary's KL_TRUSTED_PROXIES.

import type { RequestEvent } from '@sveltejs/kit';
import { BlockList, isIP } from 'node:net';

// adapter-bun's own header setting would hand us the header's value as the
// peer, for anyone to set.
if (process.env.ADDRESS_HEADER)
  throw new Error('ADDRESS_HEADER is unsupported: set PAD_TRUSTED_PROXIES instead');

/** `PAD_TRUSTED_PROXIES`: addresses and CIDR ranges, comma-separated. */
export function trustedProxies(spec: string) {
  const list = new BlockList();
  for (const item of spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [address, prefix] = item.split('/');
    const family = isIP(address);
    if (!family) throw new Error(`PAD_TRUSTED_PROXIES: ${JSON.stringify(item)} is not an address`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    const bits = Number(prefix);
    if (!/^\d+$/.test(prefix) || bits > (family === 4 ? 32 : 128))
      throw new Error(`PAD_TRUSTED_PROXIES: bad prefix in ${JSON.stringify(item)}`);
    list.addSubnet(address, bits, type);
  }
  const trusts = (ip: string) => {
    const family = isIP(ip);
    return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  };

  /**
   * The peer, or, when the peer is a trusted proxy, the rightmost
   * X-Forwarded-For hop that isn't one.
   */
  return (peer: string, forwarded: string | null) => {
    if (!trusts(peer) || !forwarded) return peer;
    let client = peer;
    for (const hop of forwarded.split(',').reverse()) {
      const ip = hop.trim();
      // A hop we can't read ends the chain at the last one we could.
      if (!isIP(ip)) break;
      client = ip;
      if (!trusts(ip)) break;
    }
    return client;
  };
}

const client = trustedProxies(process.env.PAD_TRUSTED_PROXIES ?? '');

/** The request's client address. */
export const address = (event: RequestEvent) =>
  client(event.getClientAddress(), event.request.headers.get('x-forwarded-for'));
