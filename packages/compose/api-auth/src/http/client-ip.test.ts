/**
 * Trusted-proxy client-IP resolution — unit tests.
 *
 * The rate limiter keys on a client identity. Reading `X-Forwarded-For` / `X-Real-IP` RAW lets any
 * caller spoof that identity (evade a per-source throttle, or poison another source's bucket). The
 * resolver uses the SOCKET PEER as the identity by default and honors a forwarding header ONLY when the
 * peer is in an explicitly-configured trusted-proxy CIDR list — and normalizes the address so
 * IPv4-mapped / bracketed / ported / zoned forms collapse to one key.
 */
import { describe, expect, it } from 'vitest';
import { ipInCidr, normalizeIp, resolveClientIp } from './client-ip.js';

describe('normalizeIp', () => {
  it('unwraps an IPv4-mapped IPv6 address to plain IPv4', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });
  it('strips brackets and a trailing port', () => {
    expect(normalizeIp('[::1]')).toBe('::1');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('1.2.3.4:8080')).toBe('1.2.3.4');
  });
  it('strips an IPv6 zone id and lowercases + trims', () => {
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('  ABCD::1 ')).toBe('abcd::1');
  });
  it('leaves a plain address untouched; empty/absent → undefined', () => {
    expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('')).toBeUndefined();
    expect(normalizeIp(undefined)).toBeUndefined();
    expect(normalizeIp(null)).toBeUndefined();
  });
});

describe('ipInCidr', () => {
  it('matches IPv4 within a prefix', () => {
    expect(ipInCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('192.168.1.9', '192.168.1.0/24')).toBe(true);
    expect(ipInCidr('192.168.2.9', '192.168.1.0/24')).toBe(false);
  });
  it('treats a bare IPv4/IPv6 as a full-length prefix (/32, /128)', () => {
    expect(ipInCidr('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(ipInCidr('127.0.0.2', '127.0.0.1')).toBe(false);
    expect(ipInCidr('::1', '::1')).toBe(true);
  });
  it('matches IPv6 within a prefix', () => {
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('::1', '::1/128')).toBe(true);
  });
  it('does not cross address families', () => {
    expect(ipInCidr('1.2.3.4', '::/0')).toBe(false);
    expect(ipInCidr('::1', '0.0.0.0/0')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  const TRUSTED = ['10.0.0.0/8', '127.0.0.1/32', '::1/128'];

  it('with NO trusted proxies, the peer is the identity and X-Forwarded-For is IGNORED (anti-spoof)', () => {
    expect(
      resolveClientIp({
        peer: '9.9.9.9',
        forwardedFor: '1.1.1.1',
        realIp: '2.2.2.2',
        trustedProxies: [],
      }),
    ).toBe('9.9.9.9');
  });

  it('an UNTRUSTED peer keeps the peer identity even when a trusted list is configured', () => {
    expect(
      resolveClientIp({
        peer: '9.9.9.9', // not in TRUSTED
        forwardedFor: '1.1.1.1',
        realIp: null,
        trustedProxies: TRUSTED,
      }),
    ).toBe('9.9.9.9');
  });

  it('a TRUSTED peer honors X-Forwarded-For (the real client behind the proxy)', () => {
    expect(
      resolveClientIp({
        peer: '10.0.0.1', // trusted proxy
        forwardedFor: '1.1.1.1',
        realIp: null,
        trustedProxies: TRUSTED,
      }),
    ).toBe('1.1.1.1');
  });

  it('walks X-Forwarded-For right-to-left, skipping trusted hops to the real client', () => {
    // client=2.2.2.2, then a trusted proxy hop appended 10.0.0.2 → the client is the rightmost UNtrusted.
    expect(
      resolveClientIp({
        peer: '10.0.0.1',
        forwardedFor: '1.1.1.1, 2.2.2.2, 10.0.0.2',
        realIp: null,
        trustedProxies: TRUSTED,
      }),
    ).toBe('2.2.2.2');
  });

  it('a TRUSTED peer with no XFF falls back to X-Real-IP, then to the peer', () => {
    expect(
      resolveClientIp({
        peer: '10.0.0.1',
        forwardedFor: null,
        realIp: '3.3.3.3',
        trustedProxies: TRUSTED,
      }),
    ).toBe('3.3.3.3');
    expect(
      resolveClientIp({
        peer: '10.0.0.1',
        forwardedFor: null,
        realIp: null,
        trustedProxies: TRUSTED,
      }),
    ).toBe('10.0.0.1');
  });

  it('normalizes an IPv4-mapped peer before matching + returning', () => {
    // ::ffff:127.0.0.1 normalizes to 127.0.0.1 → matches 127.0.0.1/32 → honors XFF.
    expect(
      resolveClientIp({
        peer: '::ffff:127.0.0.1',
        forwardedFor: '8.8.8.8',
        realIp: null,
        trustedProxies: TRUSTED,
      }),
    ).toBe('8.8.8.8');
    // The same mapped peer, untrusted list → returned normalized to plain IPv4.
    expect(
      resolveClientIp({
        peer: '::ffff:9.9.9.9',
        forwardedFor: '1.1.1.1',
        realIp: null,
        trustedProxies: TRUSTED,
      }),
    ).toBe('9.9.9.9');
  });

  it('no peer at all → "unknown" (never trusts a forwarding header without a peer)', () => {
    expect(
      resolveClientIp({
        peer: undefined,
        forwardedFor: '1.1.1.1',
        realIp: '2.2.2.2',
        trustedProxies: TRUSTED,
      }),
    ).toBe('unknown');
  });
});
