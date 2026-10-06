/**
 * Trusted-proxy client-IP resolution for the rate limiter's identity key.
 *
 * The limiter throttles per client identity. Reading `X-Forwarded-For` / `X-Real-IP` RAW lets ANY
 * caller forge that identity — evading a per-source throttle or poisoning another source's bucket. So:
 *
 *   - the SOCKET PEER address is the identity by DEFAULT;
 *   - a forwarding header (`X-Forwarded-For`, then `X-Real-IP`) is honored ONLY when the peer is inside
 *     an EXPLICITLY-configured trusted-proxy CIDR list (the deployment's real LB/proxy hops). For XFF,
 *     the real client is found by walking right-to-left and skipping trusted hops — a client-forged
 *     left prefix can never win;
 *   - every address is NORMALIZED (IPv4-mapped-IPv6 unwrapped in every spelling, brackets/port/zone
 *     stripped, lowercased) so one caller maps to one bucket key, and so the trusted list gives one
 *     answer for one peer.
 *
 * Trusted-proxies default to EMPTY, so out of the box no forwarding header is ever trusted (the peer
 * is the identity) — a deployment behind a proxy opts in by configuring its proxy CIDRs.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../app-context.js';

/** Strip surrounding brackets, a trailing port and an IPv6 zone id; trim and lowercase. */
function bareAddress(raw: string): string {
  let ip = raw.trim();
  // `[::1]` / `[::1]:443` → strip the brackets (and any :port after them).
  if (ip.startsWith('[')) {
    const close = ip.indexOf(']');
    if (close !== -1) ip = ip.slice(1, close);
  } else if (ip.includes('.') && ip.includes(':') && !ip.slice(ip.indexOf(':') + 1).includes(':')) {
    // A dotted address with exactly one colon is `ipv4:port` — drop the port.
    ip = ip.slice(0, ip.indexOf(':'));
  }
  const zone = ip.indexOf('%'); // IPv6 zone id, e.g. fe80::1%eth0
  if (zone !== -1) ip = ip.slice(0, zone);
  return ip.toLowerCase();
}

/** Parse an IPv4 dotted-quad to a 32-bit unsigned int, or `undefined` if it is not a valid IPv4. */
function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

/** The dotted-quad text of a 32-bit unsigned int. */
function intToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

/**
 * Parse an IPv6 address to a 128-bit BigInt, or `undefined` if it is not a valid IPv6. Every
 * spelling of one address gives one value: `::` in any position or none, leading zeros, and a
 * dotted quad in place of the last two groups (`::ffff:10.1.2.3`, `64:ff9b::10.1.2.3`).
 */
function ipv6ToBigInt(ip: string): bigint | undefined {
  if (!ip.includes(':')) return undefined;
  let text = ip;
  // A dotted quad may stand for the LAST 32 bits only; rewrite it as the two groups it is.
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    const quad = ipv4ToInt(text.slice(lastColon + 1));
    if (quad === undefined) return undefined;
    text = `${text.slice(0, lastColon + 1)}${(quad >>> 16).toString(16)}:${(quad & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const groups: string[] = [];
  if (tail === null) {
    groups.push(...head);
  } else {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return undefined;
    groups.push(...head, ...Array(fill).fill('0'), ...tail);
  }
  if (groups.length !== 8) return undefined;
  let acc = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    acc = (acc << 16n) + BigInt(Number.parseInt(g, 16));
  }
  return acc;
}

/** The length of the prefix an IPv4-mapped IPv6 address puts in front of its IPv4 address. */
const MAPPED_PREFIX_BITS = 96;

/**
 * The IPv4 address an IPv4-mapped IPv6 address (`::ffff:0:0/96`, RFC 4291) carries, or
 * `undefined` when `value` is outside that block.
 */
function mappedIpv4(value: bigint): number | undefined {
  return value >> 32n === 0xffffn ? Number(value & 0xffffffffn) : undefined;
}

/**
 * Strip an IPv6 zone id, surrounding brackets and a trailing port, lowercase, and replace an
 * IPv4-mapped IPv6 address by the IPv4 address it carries.
 *
 * The mapped block is recognised by VALUE, not by spelling: `::ffff:10.1.2.3`, `::ffff:a01:203`,
 * `::FFFF:0A01:0203` and `0:0:0:0:0:ffff:a01:203` are one address and all become `10.1.2.3`. Matching
 * on the dotted spelling alone left the others IPv6, where a trusted IPv6 range decided about them
 * and the IPv4 ranges did not — two answers for one peer, depending on how its address was written.
 * Any other address is returned as it was written (lowercased), not rewritten to a canonical form.
 */
export function normalizeIp(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const ip = bareAddress(raw);
  if (ip === '') return undefined;
  const v6 = ipv6ToBigInt(ip);
  const mapped = v6 === undefined ? undefined : mappedIpv4(v6);
  return mapped === undefined ? ip : intToIpv4(mapped);
}

/** A CIDR prefix length: decimal digits only, so an empty or malformed one is no prefix at all. */
function prefixLength(text: string | undefined, bits: number): number | undefined {
  if (text === undefined) return bits; // a bare address is a full-length prefix
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const prefix = Number(text);
  return prefix <= bits ? prefix : undefined;
}

/**
 * True if `ip` falls within `cidr` (`addr/prefix`, or a bare address = full length). Both sides are
 * normalized, so the answer does not depend on how either is spelled.
 *
 * IPv4-mapped addresses are IPv4 on both sides. An address in `::ffff:0:0/96` is compared as the
 * IPv4 address it carries, and a range written inside that block (`::ffff:10.0.0.0/104`,
 * `::ffff:0:0/96`) is the IPv4 range it carries (`10.0.0.0/8`, `0.0.0.0/0`). An IPv6 range that is
 * WIDER than the block (`::/8`, `::/0`) does not reach into it: it matches IPv6 addresses only, the
 * same way an IPv6 range never matched a plain IPv4 address. Trusting IPv4 peers therefore always
 * takes a range that names them.
 */
export function ipInCidr(ip: string, cidr: string): boolean {
  const address = normalizeIp(ip);
  if (address === undefined) return false;
  const slash = cidr.indexOf('/');
  const network = bareAddress(slash === -1 ? cidr : cidr.slice(0, slash));
  const prefixText = slash === -1 ? undefined : cidr.slice(slash + 1).trim();

  // The range as IPv4 (`net4`/`prefix4`) or as IPv6 (`net6`/`prefix6`), never both.
  let net4 = ipv4ToInt(network);
  let prefix4 = net4 === undefined ? undefined : prefixLength(prefixText, 32);
  let net6: bigint | undefined;
  let prefix6: number | undefined;
  if (net4 === undefined) {
    net6 = ipv6ToBigInt(network);
    prefix6 = net6 === undefined ? undefined : prefixLength(prefixText, 128);
    const mapped = net6 === undefined ? undefined : mappedIpv4(net6);
    if (mapped !== undefined && prefix6 !== undefined && prefix6 >= MAPPED_PREFIX_BITS) {
      net4 = mapped;
      prefix4 = prefix6 - MAPPED_PREFIX_BITS;
      net6 = undefined;
    }
  }

  const ip4 = ipv4ToInt(address);
  if (ip4 !== undefined && net4 !== undefined && prefix4 !== undefined) {
    if (prefix4 === 0) return true;
    const mask = prefix4 === 32 ? 0xffffffff : (0xffffffff << (32 - prefix4)) >>> 0;
    return (ip4 & mask) === (net4 & mask);
  }

  const ip6 = ipv6ToBigInt(address);
  if (ip6 !== undefined && net6 !== undefined && prefix6 !== undefined) {
    if (prefix6 === 0) return true;
    const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix6)) - 1n);
    return (ip6 & mask) === (net6 & mask);
  }

  return false; // different families (or unparseable) never match
}

/** True if `ip` is inside any configured trusted-proxy CIDR. */
function isTrustedProxy(ip: string, trustedProxies: readonly string[]): boolean {
  return trustedProxies.some((cidr) => ipInCidr(ip, cidr));
}

/** Normalize a comma-separated `X-Forwarded-For` into its ordered (origin→peer) list of addresses. */
function parseForwardedFor(header: string | undefined | null): string[] {
  if (!header) return [];
  const out: string[] = [];
  for (const raw of header.split(',')) {
    const norm = normalizeIp(raw);
    if (norm !== undefined) out.push(norm);
  }
  return out;
}

/**
 * Resolve the client identity for `input`. Returns a normalized IP, or `'unknown'` when there is no
 * socket peer at all (a forwarding header is NEVER trusted without a peer). See the module header.
 */
export function resolveClientIp(input: {
  peer: string | undefined | null;
  forwardedFor: string | undefined | null;
  realIp: string | undefined | null;
  trustedProxies: readonly string[];
}): string {
  const peer = normalizeIp(input.peer);
  if (peer === undefined) return 'unknown';
  // Default: the peer IS the identity. A forwarding header is honored ONLY behind a trusted proxy.
  if (input.trustedProxies.length === 0 || !isTrustedProxy(peer, input.trustedProxies)) return peer;

  const forwarded = parseForwardedFor(input.forwardedFor);
  if (forwarded.length > 0) {
    // Walk right→left (nearest hop first), skipping trusted proxies; the first UNtrusted address is
    // the real client. If every hop is trusted, the leftmost (closest to the origin) is the best guess.
    for (let i = forwarded.length - 1; i >= 0; i--) {
      const candidate = forwarded[i];
      if (candidate !== undefined && !isTrustedProxy(candidate, input.trustedProxies))
        return candidate;
    }
    return forwarded[0] ?? peer;
  }
  const realIp = normalizeIp(input.realIp);
  return realIp ?? peer;
}

/**
 * Resolve the client identity from a Hono request context: the socket peer (via the node-server
 * `incoming` binding) plus the `X-Forwarded-For` / `X-Real-IP` headers, under the configured trusted
 * proxies. The peer read is defensive — a context with no underlying socket (e.g. an in-process
 * `app.request`) yields no peer, so the resolver returns `'unknown'` rather than trusting a header.
 */
export function clientIpFromContext(
  c: Context<AppEnv>,
  trustedProxies: readonly string[] = [],
): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming;
  return resolveClientIp({
    peer: incoming?.socket?.remoteAddress,
    forwardedFor: c.req.header('x-forwarded-for'),
    realIp: c.req.header('x-real-ip'),
    trustedProxies,
  });
}
