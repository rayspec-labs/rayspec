/**
 * Pure-unit tests for `parseCleanupSettings` — the FAIL-CLOSED GDPR gate resolution. No DB.
 *
 * THE load-bearing config assertion: the GDPR purge gate is `true` ONLY for the exact string "true" —
 * any other value (unset, "1", "yes", "TRUE", " true ") is DISABLED. This is the fail-closed boundary that
 * keeps an ambiguous/typo'd operator value from silently enabling irreversible PII deletion. Plus the
 * schedule default + the fail-closed retention parsing.
 */
import { describe, expect, it } from 'vitest';
import {
  BootConfigError,
  loadServerConfig,
  parseAccessTokenTtlSeconds,
  parseCleanupSettings,
} from './composition-root.js';

describe('parseCleanupSettings — the fail-closed GDPR gate', () => {
  it('DISABLES the GDPR purge by default (unset env) — the safe default', () => {
    const s = parseCleanupSettings({});
    expect(s.gdprPurgeEnabled).toBe(false);
    expect(s.schedule).toBe('0 3 * * *');
    expect(s.gdprRetentionDays).toBe(30);
  });

  it('ENABLES the purge ONLY for the EXACT string "true"', () => {
    expect(parseCleanupSettings({ RAYSPEC_GDPR_PURGE_ENABLED: 'true' }).gdprPurgeEnabled).toBe(
      true,
    );
  });

  it('treats every NON-exact value as DISABLED (no truthy coercion — fail-closed)', () => {
    for (const v of ['1', 'yes', 'TRUE', 'True', ' true', 'true ', 'enabled', 'on', '', 'false']) {
      expect(parseCleanupSettings({ RAYSPEC_GDPR_PURGE_ENABLED: v }).gdprPurgeEnabled).toBe(false);
    }
  });

  it('resolves the cleanup schedule from env, defaulting to 3am daily', () => {
    expect(parseCleanupSettings({}).schedule).toBe('0 3 * * *');
    expect(parseCleanupSettings({ RAYSPEC_CLEANUP_SCHEDULE: '30 4 * * *' }).schedule).toBe(
      '30 4 * * *',
    );
    // Blank ⇒ the default (not an empty crontab).
    expect(parseCleanupSettings({ RAYSPEC_CLEANUP_SCHEDULE: '   ' }).schedule).toBe('0 3 * * *');
  });

  it('resolves the retention default (30) and accepts a valid override', () => {
    expect(parseCleanupSettings({}).gdprRetentionDays).toBe(30);
    expect(parseCleanupSettings({ RAYSPEC_GDPR_RETENTION_DAYS: '90' }).gdprRetentionDays).toBe(90);
    expect(parseCleanupSettings({ RAYSPEC_GDPR_RETENTION_DAYS: '0' }).gdprRetentionDays).toBe(0);
  });

  it('FAIL-CLOSES on a non-numeric / negative retention (a bad value never silently falls back)', () => {
    expect(() => parseCleanupSettings({ RAYSPEC_GDPR_RETENTION_DAYS: 'abc' })).toThrow(
      BootConfigError,
    );
    expect(() => parseCleanupSettings({ RAYSPEC_GDPR_RETENTION_DAYS: '-5' })).toThrow(
      BootConfigError,
    );
  });
});

describe('parseAccessTokenTtlSeconds — the fail-closed access-token TTL', () => {
  it('defaults to 480 (8min) when unset or blank', () => {
    expect(parseAccessTokenTtlSeconds({})).toBe(480);
    expect(parseAccessTokenTtlSeconds({ RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: '' })).toBe(480);
    expect(parseAccessTokenTtlSeconds({ RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: '   ' })).toBe(480);
  });

  it('accepts a valid positive-integer override (e.g. 3600 = 1h, 14400 = 4h)', () => {
    expect(parseAccessTokenTtlSeconds({ RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: '3600' })).toBe(3600);
    expect(parseAccessTokenTtlSeconds({ RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: '14400' })).toBe(14400);
    // The 24h ceiling itself is allowed (boundary holds).
    expect(parseAccessTokenTtlSeconds({ RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: '86400' })).toBe(86400);
  });

  it('FAIL-CLOSES on a non-numeric / non-integer / ≤0 / >86400 value (never silently falls back)', () => {
    for (const v of ['abc', '1.5', '0', '-1', '99999', '86401']) {
      expect(() => parseAccessTokenTtlSeconds({ RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: v })).toThrow(
        BootConfigError,
      );
    }
  });

  it('loadServerConfig surfaces the parsed TTL (default 480; a valid override threads through)', () => {
    const baseEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://u:p@localhost:5432/app',
      RAYSPEC_JWT_SIGNING_KEY: 'dummy-pem-not-imported-by-loadServerConfig',
      RAYSPEC_API_KEY_PEPPER: 'dummy-pepper-value-for-config-resolution',
    };
    expect(loadServerConfig({ ...baseEnv }).accessTokenTtlSeconds).toBe(480);
    expect(
      loadServerConfig({ ...baseEnv, RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: '14400' })
        .accessTokenTtlSeconds,
    ).toBe(14400);
    // A bad value aborts the whole boot config (fail-closed).
    expect(() =>
      loadServerConfig({ ...baseEnv, RAYSPEC_ACCESS_TOKEN_TTL_SECONDS: 'nope' }),
    ).toThrow(BootConfigError);
  });
});

describe('loadServerConfig — ALLOWED_ORIGINS sanitization (ORIGIN-NULL-1)', () => {
  // The same minimal valid env (pure config-resolution path, no DB).
  const baseEnv: NodeJS.ProcessEnv = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/app',
    RAYSPEC_JWT_SIGNING_KEY: 'dummy-pem-not-imported-by-loadServerConfig',
    RAYSPEC_API_KEY_PEPPER: 'dummy-pepper-value-for-config-resolution',
  };

  it('DROPS the special tokens `null` (any case) and `*`, keeping real origins', () => {
    // The array feeds cors()'s array-origin AND the cookie CSRF guard; a `null`/`*` must never
    // be allow-listable (it would echo ACAO: null to opaque origins, or a literal wildcard).
    const config = loadServerConfig({
      ...baseEnv,
      ALLOWED_ORIGINS: 'null,*,NULL,Null, * ,https://app.example',
    });
    expect(config.allowedOrigins).toEqual(['https://app.example']);
  });

  it('keeps a clean comma-separated list intact (trims + drops blanks only)', () => {
    const config = loadServerConfig({
      ...baseEnv,
      ALLOWED_ORIGINS: 'https://a.example, https://b.example ,,https://c.example',
    });
    expect(config.allowedOrigins).toEqual([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
  });

  it('unset/blank ALLOWED_ORIGINS ⇒ [] (no cross-origin, fail-closed default)', () => {
    expect(loadServerConfig({ ...baseEnv }).allowedOrigins).toEqual([]);
    expect(loadServerConfig({ ...baseEnv, ALLOWED_ORIGINS: '   , , ' }).allowedOrigins).toEqual([]);
    // A list that is ONLY the special tokens collapses to the empty (no-cross-origin) default.
    expect(loadServerConfig({ ...baseEnv, ALLOWED_ORIGINS: 'null,*' }).allowedOrigins).toEqual([]);
  });
});
