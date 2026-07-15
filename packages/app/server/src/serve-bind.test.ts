/**
 * The listen-host resolution + the honest boot-base-URL builder.
 *
 * The server assembles the LOCAL / pre-external-hardening platform, so it must bind LOOPBACK by default
 * and reach another interface ONLY on an explicit RAYSPEC_HOST opt-in. And the banner must reflect the
 * ACTUAL bound address (`bootBaseUrl(info.address, …)`), never a hard-coded 127.0.0.1 that would lie
 * about a non-loopback bind. Both are pure (no DB / no port bind) so they run deterministically here;
 * the real `serve({ hostname })` pass-through is exercised by the boot path in CI.
 */
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
