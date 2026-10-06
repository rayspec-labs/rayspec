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
import { ipInCidr, isTrustedProxyRange, normalizeIp, resolveClientIp } from './client-ip.js';

describe('normalizeIp', () => {
  it('unwraps an IPv4-mapped IPv6 address to plain IPv4', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
  });
  it('unwraps every spelling of one IPv4-mapped address to the same IPv4 address', () => {
    for (const spelling of [
      '::ffff:10.1.2.3',
      '::ffff:a01:203',
      '::FFFF:A01:203',
      '::ffff:0a01:0203',
      '0:0:0:0:0:ffff:a01:203',
      '0000:0000:0000:0000:0000:ffff:0a01:0203',
      '0000:0000:0000:0000:0000:FFFF:10.1.2.3',
      '0::ffff:a01:203',
      '[::ffff:a01:203]',
      '[::ffff:a01:203]:443',
      '::ffff:a01:203%eth0',
    ]) {
      expect(normalizeIp(spelling), spelling).toBe('10.1.2.3');
    }
    expect(normalizeIp('::ffff:0:0')).toBe('0.0.0.0');
    expect(normalizeIp('::ffff:ffff:ffff')).toBe('255.255.255.255');
  });
  it('unwraps the mapped block only — its neighbours and look-alikes stay IPv6', () => {
    // IPv4-compatible (`::/96`), NAT64, and the blocks on either side of `::ffff:0:0/96`.
    expect(normalizeIp('::a01:203')).toBe('::a01:203');
    expect(normalizeIp('::10.1.2.3')).toBe('::10.1.2.3');
    expect(normalizeIp('64:ff9b::10.1.2.3')).toBe('64:ff9b::10.1.2.3');
    expect(normalizeIp('::fffe:a01:203')).toBe('::fffe:a01:203');
    expect(normalizeIp('::1:0:a01:203')).toBe('::1:0:a01:203');
    expect(normalizeIp('::ffff:0:a01:203')).toBe('::ffff:0:a01:203');
    expect(normalizeIp('1::ffff:a01:203')).toBe('1::ffff:a01:203');
  });
  it('leaves text that is not an address as written, never as a half-unwrapped address', () => {
    expect(normalizeIp('::ffff:999.1.2.3')).toBe('::ffff:999.1.2.3');
    expect(normalizeIp('::ffff:1.2.3')).toBe('::ffff:1.2.3');
    expect(normalizeIp('::ffff:g01:203')).toBe('::ffff:g01:203');
    expect(normalizeIp('::ffff:a01:203:1:2:3:4:5')).toBe('::ffff:a01:203:1:2:3:4:5');
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

  /** One address, `10.1.2.3`, in the spellings a peer or a forwarding header can carry. */
  const MAPPED_SPELLINGS = [
    '10.1.2.3',
    '::ffff:10.1.2.3',
    '::ffff:a01:203',
    '::FFFF:0A01:0203',
    '0:0:0:0:0:ffff:a01:203',
    '0000:0000:0000:0000:0000:ffff:0a01:0203',
  ];

  it('an IPv4-mapped address matches IPv4 ranges in every spelling', () => {
    for (const spelling of MAPPED_SPELLINGS) {
      expect(ipInCidr(spelling, '10.0.0.0/8'), spelling).toBe(true);
      expect(ipInCidr(spelling, '10.1.2.3'), spelling).toBe(true);
      expect(ipInCidr(spelling, '192.168.0.0/16'), spelling).toBe(false);
    }
  });

  it('a broad IPv6 range does not reach an IPv4-mapped address, in any spelling', () => {
    for (const range of ['::/8', '::/0', '::/80', '::/95', '::ffff:0:0/95', '::fffe:0:0/95']) {
      for (const spelling of MAPPED_SPELLINGS) {
        expect(ipInCidr(spelling, range), `${spelling} in ${range}`).toBe(false);
      }
    }
    // The control: those ranges still match the IPv6 addresses they name.
    expect(ipInCidr('::1', '::/8')).toBe(true);
    expect(ipInCidr('::a01:203', '::/8')).toBe(true);
    expect(ipInCidr('::fffe:a01:203', '::ffff:0:0/95')).toBe(true);
    expect(ipInCidr('2001:db8::1', '::/0')).toBe(true);
  });

  it('a range written inside the mapped block is the IPv4 range it carries', () => {
    for (const spelling of MAPPED_SPELLINGS) {
      // `::ffff:0:0/96` is all of IPv4; the narrower ones are 10.0.0.0/8 and the single address.
      for (const range of [
        '::ffff:0:0/96',
        '::FFFF:0:0/96',
        '0:0:0:0:0:ffff:0:0/96',
        '::ffff:0.0.0.0/96',
        '::ffff:10.0.0.0/104',
        '::ffff:a00:0/104',
        '::ffff:a01:203/128',
        '::ffff:a01:203',
        '[::ffff:a01:203]',
      ]) {
        expect(ipInCidr(spelling, range), `${spelling} in ${range}`).toBe(true);
      }
      for (const range of ['::ffff:b00:0/104', '::ffff:a01:204', '::ffff:11.0.0.0/104']) {
        expect(ipInCidr(spelling, range), `${spelling} in ${range}`).toBe(false);
      }
    }
    // The mapped block is IPv4 and nothing else: an IPv6 address is not in it.
    expect(ipInCidr('::1', '::ffff:0:0/96')).toBe(false);
    expect(ipInCidr('2001:db8::1', '::ffff:0:0/96')).toBe(false);
  });

  it('a dotted mapped network with an IPv4-length prefix is the IPv4 range behind the prefix', () => {
    // The prefix counts IPv4 bits, as in the address it is written behind: never the IPv6 `::/8`.
    for (const spelling of MAPPED_SPELLINGS) {
      expect(ipInCidr(spelling, '::ffff:10.0.0.0/8'), spelling).toBe(true);
      expect(ipInCidr(spelling, '::ffff:10.1.2.3/32'), spelling).toBe(true);
      expect(ipInCidr(spelling, '::ffff:0.0.0.0/0'), spelling).toBe(true);
      expect(ipInCidr(spelling, '::ffff:11.0.0.0/8'), spelling).toBe(false);
      expect(ipInCidr(spelling, '::ffff:10.1.2.4/32'), spelling).toBe(false);
    }
    expect(ipInCidr('192.168.1.1', '::ffff:10.0.0.0/8')).toBe(false);
    expect(ipInCidr('192.168.1.1', '::ffff:0.0.0.0/0')).toBe(true);
    for (const range of ['::ffff:10.0.0.0/8', '::ffff:10.1.2.3/32', '::ffff:0.0.0.0/0']) {
      for (const v6 of ['::1', '::', '::10.1.2.3', '2001:db8::1']) {
        expect(ipInCidr(v6, range), `${v6} in ${range}`).toBe(false);
      }
    }
    // Between the two notations (33 to 95) a dotted network names no range at all.
    for (const range of ['::ffff:10.0.0.0/33', '::ffff:10.0.0.0/64', '::ffff:10.0.0.0/95']) {
      expect(ipInCidr('10.1.2.3', range), range).toBe(false);
      expect(ipInCidr('::1', range), range).toBe(false);
      expect(ipInCidr('::ffff:1:1', range), range).toBe(false);
    }
  });

  it('matches an IPv6 address against an IPv6 range whatever the spelling of either', () => {
    expect(ipInCidr('2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db8::1', '2001:0DB8:0:0:0:0:0:0/32')).toBe(true);
    expect(ipInCidr('64:ff9b::10.1.2.3', '64:ff9b::/96')).toBe(true);
    expect(ipInCidr('64:ff9b::a01:203', '64:ff9b::10.0.0.0/104')).toBe(true);
  });

  it('a malformed prefix length matches nothing', () => {
    for (const range of [
      '10.0.0.0/',
      '10.0.0.0/33',
      '10.0.0.0/-1',
      '10.0.0.0/8.0',
      '10.0.0.0/0x8',
      '10.0.0.0/1e1',
      '10.0.0.0/eight',
      '::ffff:0:0/',
      '::ffff:0:0/129',
      '::ffff:10.0.0.0/1e2',
    ]) {
      expect(ipInCidr('10.1.2.3', range), range).toBe(false);
    }
    expect(ipInCidr('::1', '::/')).toBe(false);
    expect(ipInCidr('::1', '::/129')).toBe(false);
    // The control: a zero prefix that is written out still matches its whole family.
    expect(ipInCidr('10.1.2.3', '0.0.0.0/0')).toBe(true);
    expect(ipInCidr('::1', '::/0')).toBe(true);
  });
});

describe('isTrustedProxyRange', () => {
  it('accepts every entry that names a range', () => {
    for (const entry of [
      '10.0.0.0/8',
      '10.1.2.3',
      '0.0.0.0/0',
      '::1',
      '::1/128',
      '::/0',
      '2001:db8::/32',
      '[::1]',
      '::ffff:10.0.0.0/104',
      '::ffff:10.0.0.0/8',
      '::ffff:0:0/96',
      '::ffff:0:0/95',
      '64:ff9b::10.0.0.0/104',
    ]) {
      expect(isTrustedProxyRange(entry), entry).toBe(true);
    }
  });

  it('refuses an entry no peer can be inside', () => {
    for (const entry of [
      '10.0.0.0/',
      '10.0.0.0/33',
      '10.0.0.0/8.0',
      '10.0.0.0/0x8',
      '10.0.0.0/+8',
      '10.0.0.0/1e1',
      '10.0.0/8',
      '::/',
      '::/129',
      '::ffff:10.0.0.0/64',
      'proxy.internal',
      'localhost/8',
    ]) {
      expect(isTrustedProxyRange(entry), entry).toBe(false);
    }
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

  it('a mapped peer gets one answer from the trusted list, however its address is spelled', () => {
    const spellings = [
      '::ffff:10.1.2.3',
      '::ffff:a01:203',
      '::FFFF:0A01:0203',
      '0:0:0:0:0:ffff:a01:203',
    ];
    for (const peer of spellings) {
      // A broad IPv6 range does not make an IPv4 peer a trusted proxy: the header is ignored.
      expect(
        resolveClientIp({ peer, forwardedFor: '8.8.8.8', realIp: null, trustedProxies: ['::/8'] }),
        peer,
      ).toBe('10.1.2.3');
      // The IPv4 range that names the peer does, and so does the mapped spelling of that range.
      for (const range of ['10.0.0.0/8', '::ffff:10.0.0.0/104', '::ffff:0:0/96']) {
        expect(
          resolveClientIp({ peer, forwardedFor: '8.8.8.8', realIp: null, trustedProxies: [range] }),
          `${peer} behind ${range}`,
        ).toBe('8.8.8.8');
      }
    }
  });

  it('a dotted mapped range with an IPv4-length prefix trusts its IPv4 proxies, not IPv6 peers', () => {
    for (const range of ['::ffff:10.0.0.0/8', '::ffff:10.0.0.5/32', '::ffff:0.0.0.0/0']) {
      for (const peer of ['::ffff:10.0.0.5', '10.0.0.5', '::ffff:a00:5']) {
        expect(
          resolveClientIp({
            peer,
            forwardedFor: '203.0.113.9',
            realIp: null,
            trustedProxies: [range],
          }),
          `${peer} behind ${range}`,
        ).toBe('203.0.113.9');
      }
      // An IPv6 peer is not inside an IPv4 range: its forwarding header is ignored.
      expect(
        resolveClientIp({
          peer: '::1',
          forwardedFor: '203.0.113.9',
          realIp: null,
          trustedProxies: [range],
        }),
        `::1 behind ${range}`,
      ).toBe('::1');
    }
  });

  it('forwarded addresses are unwrapped the same way: one client, one identity', () => {
    const identities = ['9.9.9.9', '::ffff:9.9.9.9', '::ffff:909:909', '::FFFF:0909:0909'].map(
      (client) =>
        resolveClientIp({
          peer: '10.0.0.1',
          forwardedFor: client,
          realIp: null,
          trustedProxies: TRUSTED,
        }),
    );
    expect(new Set(identities)).toEqual(new Set(['9.9.9.9']));
    expect(
      resolveClientIp({
        peer: '10.0.0.1',
        forwardedFor: null,
        realIp: '::ffff:909:909',
        trustedProxies: TRUSTED,
      }),
    ).toBe('9.9.9.9');
    // A trusted hop written in the hex spelling is skipped like its dotted twin.
    expect(
      resolveClientIp({
        peer: '10.0.0.1',
        forwardedFor: '2.2.2.2, ::ffff:a00:2',
        realIp: null,
        trustedProxies: TRUSTED,
      }),
    ).toBe('2.2.2.2');
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
