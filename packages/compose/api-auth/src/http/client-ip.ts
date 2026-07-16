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
 *   - every address is NORMALIZED (IPv4-mapped-IPv6 unwrapped, brackets/port/zone stripped, lowercased)
 *     so one caller maps to one bucket key.
 *
 * Trusted-proxies default to EMPTY, so out of the box no forwarding header is ever trusted (the peer
 * is the identity) — a deployment behind a proxy opts in by configuring its proxy CIDRs.
 */

import type { Context } from 'hono';
import type { AppEnv } from '../app-context.js';

/** Strip an IPv6 zone id, surrounding brackets, a trailing port, and the IPv4-mapped prefix; lowercase. */
export function normalizeIp(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let ip = raw.trim();
  if (ip === '') return undefined;
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
  ip = ip.toLowerCase();
  // IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → the plain IPv4 the mapping carries.
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice('::ffff:'.length);
    if (tail.includes('.')) ip = tail;
  }
  return ip === '' ? undefined : ip;
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

/** Parse an IPv6 address to a 128-bit BigInt, or `undefined` if it is not a valid IPv6. */
function ipv6ToBigInt(ip: string): bigint | undefined {
  if (!ip.includes(':')) return undefined;
  const halves = ip.split('::');
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

/** True if a normalized `ip` falls within `cidr` (`addr/prefix`, or a bare address = full length). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const network = normalizeIp(slash === -1 ? cidr : cidr.slice(0, slash));
  if (network === undefined) return false;
  const prefixText = slash === -1 ? undefined : cidr.slice(slash + 1);

  const ip4 = ipv4ToInt(ip);
  const net4 = ipv4ToInt(network);
  if (ip4 !== undefined && net4 !== undefined) {
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return (ip4 & mask) === (net4 & mask);
  }

  const ip6 = ipv6ToBigInt(ip);
  const net6 = ipv6ToBigInt(network);
  if (ip6 !== undefined && net6 !== undefined) {
    const prefix = prefixText === undefined ? 128 : Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false;
    if (prefix === 0) return true;
    const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
    return (ip6 & mask) === (net6 & mask);
  }

  return false; // different families (or unparseable) never match
}

/** True if a normalized `ip` is inside any configured trusted-proxy CIDR. */
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
