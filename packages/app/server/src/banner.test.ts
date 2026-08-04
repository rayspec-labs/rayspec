/**
 * Boot-banner unit proofs — the RESOLVED housekeeping block. Pure string-building (no DB, no network,
 * no secrets): a stub `BootedServer` carrying only what the banner reads is handed to `bootBanner` and
 * each line is pinned, in the style of the `nonRealProviderBanner` arms in product-boot.unit.test.ts.
 *
 * Fail-the-fix teeth:
 *   - both GDPR-gate arms resolve their environment value through `parseCleanupSettings` — the SAME
 *     resolver `loadServerConfig` calls at boot — and feed its OUTPUT to the banner, so the arms are
 *     over what a real boot resolves rather than over a hand-written boolean. The `true` arm asserts
 *     the resolver ACCEPTED the value and the `TRUE` arm asserts it REJECTED it, so neither arm can
 *     pass because the resolver stopped resolving anything.
 *   - the typo arm asserts the banner does not contain `TRUE` anywhere: the banner is never handed the
 *     raw string, so an accepted-looking echo cannot appear.
 *   - the no-durable-worker arm asserts the DEFAULT crontab `0 3 * * *` is absent, so printing a
 *     resolved-but-never-fired schedule there goes RED.
 */
import { describe, expect, it } from 'vitest';
import { bootBanner } from './banner.js';
import { type BootedServer, parseCleanupSettings } from './composition-root.js';

const BASE = 'http://127.0.0.1:8080';

// The banner reads the two control seams as PRESENCE signals only (never calls them): `runCleanupNow`
// is undefined for a boot that launches no durable worker, `eraseTenantNow` for one with no product
// stores. Presence stubs stand in for both.
const CLEANUP_SEAM = {} as NonNullable<BootedServer['runCleanupNow']>;
const ERASE_SEAM = {} as NonNullable<BootedServer['eraseTenantNow']>;

/** A stub booted server — the banner never touches `app`/`close`, so those stay inert. */
function booted(over: Partial<BootedServer> = {}): BootedServer {
  return {
    app: {} as BootedServer['app'],
    issuer: `${BASE}/oidc`,
    declaredRoutes: [],
    declaredAgents: [],
    declaredCronTriggers: [],
    deployMode: 'auth-only',
    drift: [],
    housekeeping: { cleanup: parseCleanupSettings({}), erasureEnabled: false },
    close: async () => {},
    ...over,
  };
}

describe('bootBanner — the resolved GDPR tombstone-purge gate', () => {
  it('reports DRY-RUN and NAMES the variable when the gate is unset', () => {
    const banner = bootBanner(booted(), BASE);
    expect(banner).toContain('GDPR tombstone purge:  DRY-RUN');
    expect(banner).toContain('RAYSPEC_GDPR_PURGE_ENABLED');
  });

  it("reports ARMED when the resolver ACCEPTED the exact string 'true'", () => {
    const cleanup = parseCleanupSettings({ RAYSPEC_GDPR_PURGE_ENABLED: 'true' });
    expect(cleanup.gdprPurgeEnabled).toBe(true); // accept control — the boot resolver took it
    const banner = bootBanner(booted({ housekeeping: { cleanup, erasureEnabled: false } }), BASE);
    expect(banner).toContain('GDPR tombstone purge:  ARMED');
    expect(banner).not.toContain('GDPR tombstone purge:  DRY-RUN');
  });

  it('renders TRUE as the DRY-RUN line and echoes no supplied string', () => {
    const cleanup = parseCleanupSettings({ RAYSPEC_GDPR_PURGE_ENABLED: 'TRUE' });
    expect(cleanup.gdprPurgeEnabled).toBe(false); // reject control — the strict comparison held
    const banner = bootBanner(booted({ housekeeping: { cleanup, erasureEnabled: false } }), BASE);
    expect(banner).toContain('GDPR tombstone purge:  DRY-RUN');
    expect(banner).not.toContain('TRUE');
  });
});

describe('bootBanner — the resolved tenant data-erasure gate', () => {
  it('reports DRY-RUN and NAMES the variable on a boot that has product stores to erase', () => {
    const banner = bootBanner(booted({ eraseTenantNow: ERASE_SEAM }), BASE);
    expect(banner).toContain('Tenant data erasure:   DRY-RUN');
    expect(banner).toContain('RAYSPEC_ERASURE_ENABLED');
  });

  it('reports ARMED on a boot whose erasure gate resolved true', () => {
    const server = booted({
      eraseTenantNow: ERASE_SEAM,
      housekeeping: { cleanup: parseCleanupSettings({}), erasureEnabled: true },
    });
    const banner = bootBanner(server, BASE);
    expect(banner).toContain('Tenant data erasure:   ARMED');
    expect(banner).not.toContain('Tenant data erasure:   DRY-RUN');
  });

  it('states there is nothing to erase — not a gate posture — when no product stores were deployed', () => {
    const banner = bootBanner(
      booted({ housekeeping: { cleanup: parseCleanupSettings({}), erasureEnabled: true } }),
      BASE,
    );
    expect(banner).toContain('Tenant data erasure:   NOT WIRED');
    expect(banner).not.toContain('Tenant data erasure:   ARMED');
    // the line still NAMES the variable, so the block names all three on every boot it prints
    expect(banner).toContain('RAYSPEC_ERASURE_ENABLED');
  });
});

describe('bootBanner — the resolved daily-cleanup crontab', () => {
  it('prints the resolved crontab and retention on a boot that wires a durable worker', () => {
    const cleanup = parseCleanupSettings({
      RAYSPEC_CLEANUP_SCHEDULE: '15 4 * * *',
      RAYSPEC_GDPR_RETENTION_DAYS: '90',
    });
    const server = booted({
      runCleanupNow: CLEANUP_SEAM,
      housekeeping: { cleanup, erasureEnabled: false },
    });
    const banner = bootBanner(server, BASE);
    expect(banner).toContain("Daily cleanup:         '15 4 * * *'");
    expect(banner).toContain('RAYSPEC_CLEANUP_SCHEDULE');
    // The retention window is a SECOND setting printed on this same line, so the line has to name its
    // variable too — otherwise retention is the one setting an operator can read off the banner
    // without being able to find the knob that produced it.
    expect(banner).toContain('RAYSPEC_GDPR_RETENTION_DAYS = 90 days');
  });

  it('says NOT SCHEDULED — and prints no crontab — on a boot that wires no durable worker', () => {
    const banner = bootBanner(booted(), BASE);
    expect(banner).toContain('Daily cleanup:         NOT SCHEDULED');
    // the line still NAMES the variable, so the block names all three on every boot it prints
    expect(banner).toContain('RAYSPEC_CLEANUP_SCHEDULE');
    // The default crontab still RESOLVES on this boot; it must not be printed, because nothing fires it.
    expect(booted().housekeeping.cleanup.schedule).toBe('0 3 * * *');
    expect(banner).not.toContain('0 3 * * *');
  });
});
