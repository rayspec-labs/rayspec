/**
 * The listen-host resolution + the honest boot-base-URL builder.
 *
 * The server assembles the LOCAL / pre-external-hardening platform, so it must bind LOOPBACK by default
 * and reach another interface ONLY on an explicit RAYSPEC_HOST opt-in. And the banner must reflect the
 * ACTUAL bound address (`bootBaseUrl(info.address, …)`), never a hard-coded 127.0.0.1 that would lie
 * about a non-loopback bind. The config resolution + URL formatting below are pure units; the actual
 * `serve({ hostname: config.host })` wiring at the entrypoint is guarded by a source assertion at the
 * foot of this file — a boot test cannot catch a dropped hostname, because an all-interfaces bind
 * (0.0.0.0/::) also answers on 127.0.0.1, so the boot suite would stay green if the pass-through
 * regressed to the all-interfaces default.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bootBaseUrl } from './banner.js';
import { DEFAULT_HOST, loadServerConfig } from './composition-root.js';

// The three required boot secrets so loadServerConfig gets past its fail-closed presence gate; the
// values are dummies (loadServerConfig validates presence + parses env only — it never imports the PEM
// or touches the DB). DATABASE_URL must be a parseable URL (deriveDbosSystemUrl parses it).
const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/rayspec',
  RAYSPEC_JWT_SIGNING_KEY: 'dummy-pem',
  RAYSPEC_API_KEY_PEPPER: 'dummy-pepper',
} as unknown as NodeJS.ProcessEnv;

describe('loadServerConfig — the listen host defaults to loopback', () => {
  it('defaults host to 127.0.0.1 when RAYSPEC_HOST is unset', () => {
    expect(DEFAULT_HOST).toBe('127.0.0.1');
    expect(loadServerConfig({ ...BASE_ENV }).host).toBe('127.0.0.1');
  });

  it('honors an explicit RAYSPEC_HOST (a non-loopback bind is a deliberate opt-in)', () => {
    expect(loadServerConfig({ ...BASE_ENV, RAYSPEC_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
  });

  it('treats a blank/whitespace RAYSPEC_HOST as unset (falls back to loopback)', () => {
    expect(loadServerConfig({ ...BASE_ENV, RAYSPEC_HOST: '   ' }).host).toBe(DEFAULT_HOST);
  });
});

describe('loadServerConfig — trusted-proxy CIDRs (RAYSPEC_TRUSTED_PROXIES)', () => {
  it('defaults to an EMPTY list (no forwarding header trusted) when unset', () => {
    expect(loadServerConfig({ ...BASE_ENV }).trustedProxies).toEqual([]);
  });

  it('parses a comma-separated CIDR list into trimmed entries', () => {
    expect(
      loadServerConfig({ ...BASE_ENV, RAYSPEC_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.0.0/16' })
        .trustedProxies,
    ).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
  });

  it('drops blank/whitespace entries (a stray comma cannot become a trusted CIDR)', () => {
    expect(
      loadServerConfig({ ...BASE_ENV, RAYSPEC_TRUSTED_PROXIES: ' 10.0.0.0/8 , ,  ' })
        .trustedProxies,
    ).toEqual(['10.0.0.0/8']);
  });
});

describe('bootBaseUrl — the banner reflects the ACTUAL bound address', () => {
  it('formats an IPv4 bind verbatim (including a non-loopback address)', () => {
    expect(bootBaseUrl('127.0.0.1', 8080)).toBe('http://127.0.0.1:8080');
    expect(bootBaseUrl('0.0.0.0', 8080)).toBe('http://0.0.0.0:8080');
  });

  it('brackets an IPv6 literal so the URL stays well-formed', () => {
    expect(bootBaseUrl('::1', 8080)).toBe('http://[::1]:8080');
    expect(bootBaseUrl('::', 8080)).toBe('http://[::]:8080');
  });
});

// A source-level guard WITH TEETH for the actual serve() wiring. The units above cover host RESOLUTION
// and URL FORMATTING, but neither proves the resolved host reaches the listener. This asserts, against
// the entrypoint source, that rayspec-serve passes `hostname: config.host` to serve() (so the loopback
// default is not silently the all-interfaces default) and logs the ACTUAL bound address
// (bootBaseUrl(info.address, …)) rather than a hard-coded loopback that would misreport the bind.
// Reverting either — dropping `hostname` or restoring the `http://127.0.0.1:${info.port}` banner —
// REDs a case here, where a boot test cannot (an all-interfaces bind also answers on 127.0.0.1). The
// cli deploy entrypoint's identical wiring is guarded the same way in packages/app/cli/src/deploy.test.ts.
describe('serve.ts — passes the resolved host to the listener and logs the real bind', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'serve.ts'), 'utf8');
  // Strip comments so the assertions read the CODE, not prose that merely names the wiring.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('binds the RESOLVED host (hostname: config.host)', () => {
    expect(code).toMatch(/hostname:\s*config\.host/);
  });

  it('logs the ACTUAL bound address via bootBaseUrl(info.address, …)', () => {
    expect(code).toMatch(/bootBaseUrl\(\s*info\.address/);
  });
});
