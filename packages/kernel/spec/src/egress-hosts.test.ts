/**
 * The egress declaration: backend `deployment.egressHosts` and product
 * `deployment_overrides.egress_hosts`. Each refused form below is one the bundle manifest schema
 * refuses too, so a host the grammar accepts is one a bundle can carry; each refusal names the path of
 * the offending entry.
 */
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';
import { parseProductSpec } from './product-parse.js';

const backend = (hosts: string) => `
version: '1.0'
metadata:
  name: calls-out
deployment:
  egressHosts: ${hosts}
`;

const product = (hosts: string) => `
version: '1.0'
product:
  id: intake
  name: Intake
deployment_overrides:
  egress_hosts: ${hosts}
`;

/** Each host the manifest schema refuses, with why. */
const REFUSED: readonly [string, string][] = [
  ['10.0.0.1', 'an IP literal'],
  ['[::1]', 'an IPv6 literal'],
  ['*.example.com', 'a wildcard'],
  ['example.com.', 'a trailing dot'],
  ['https://example.com', 'a URL'],
  ['example.com:443', 'a port'],
  ['Example.com', 'an uppercase letter'],
  ['example.COM', 'an uppercase last label'],
  ['shop.XN--bcher-kva', 'an uppercase IDNA last label'],
  ['example.c0m', 'a last label that is not alphabetic'],
  ['localhost', 'a single label'],
  ['-api.example.com', 'a label that starts with a hyphen'],
  ['api-.example.com', 'a label that ends with a hyphen'],
  [`${'a'.repeat(64)}.example.com`, 'a label of 64 characters'],
  ['', 'an empty host'],
];

describe('deployment.egressHosts (backend profile)', () => {
  it('accepts lowercase hostnames, an IDNA last label, and an absent or empty list', () => {
    const ok = parseSpec(backend('[api.openai.com, api.deepgram.com, shop.xn--bcher-kva]'));
    if (!ok.ok) throw new Error(JSON.stringify(ok.errors));
    expect(ok.value.deployment?.egressHosts).toEqual([
      'api.openai.com',
      'api.deepgram.com',
      'shop.xn--bcher-kva',
    ]);
    expect(parseSpec(backend('[]')).ok).toBe(true);
    const none = parseSpec("version: '1.0'\nmetadata:\n  name: quiet\n");
    if (!none.ok) throw new Error(JSON.stringify(none.errors));
    expect(none.value.deployment?.egressHosts).toBeUndefined();
  });

  it.each(REFUSED)('refuses %j (%s) at the path of the entry', (host) => {
    const r = parseSpec(backend(JSON.stringify([host])));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => [e.code, e.path])).toContainEqual([
        'schema_violation',
        'deployment.egressHosts[0]',
      ]);
    }
  });

  it('refuses a host declared twice, and a host longer than 253 characters', () => {
    const twice = parseSpec(backend('[api.example.com, api.example.com]'));
    expect(twice.ok).toBe(false);
    if (!twice.ok) {
      expect(twice.errors.map((e) => [e.code, e.path])).toEqual([
        ['schema_violation', 'deployment.egressHosts'],
      ]);
    }
    const label = 'a'.repeat(60);
    const long = `${label}.${label}.${label}.${label}.example.com`;
    expect(long.length).toBeGreaterThan(253);
    expect(parseSpec(backend(JSON.stringify([long]))).ok).toBe(false);
  });

  it('refuses more than 256 hosts', () => {
    const hosts = Array.from({ length: 257 }, (_, i) => `h${i}.example.com`);
    expect(parseSpec(backend(JSON.stringify(hosts.slice(0, 256)))).ok).toBe(true);
    expect(parseSpec(backend(JSON.stringify(hosts))).ok).toBe(false);
  });

  it('refuses a string where the list belongs', () => {
    expect(parseSpec(backend('api.example.com')).ok).toBe(false);
  });
});

describe('deployment_overrides.egress_hosts (product profile)', () => {
  it('accepts lowercase hostnames beside the provider overrides', () => {
    const r = parseProductSpec(`${product('[hooks.example.com]')}  providers:
    openai:
      default_model: gpt-5
`);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.value.deployment_overrides?.egress_hosts).toEqual(['hooks.example.com']);
  });

  it.each(REFUSED)('refuses %j (%s) at the path of the entry', (host) => {
    const r = parseProductSpec(product(JSON.stringify([host])));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => [e.code, e.path])).toContainEqual([
        'schema_violation',
        'deployment_overrides.egress_hosts[0]',
      ]);
    }
  });

  it('refuses a host declared twice', () => {
    const r = parseProductSpec(product('[a.example.com, a.example.com]'));
    expect(r.ok).toBe(false);
  });

  it('spells the key in snake case, as the rest of the product profile does', () => {
    const r = parseProductSpec(product('[a.example.com]').replace('egress_hosts', 'egressHosts'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => [e.code, e.path])).toEqual([
        ['unknown_field', 'deployment_overrides.egressHosts'],
      ]);
    }
  });
});
