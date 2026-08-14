/**
 * The auth-rate-multiplier BOOT BANNER at the seam that actually emits it.
 *
 * `authRateMultiplierBanner()` is pinned as a pure function in `cleanup-config.test.ts` (the text, and
 * that 1 is silent). That says nothing about whether the composition root ever CALLS it, nor whether
 * the line reaches the boot's injectable one-line warning sink rather than the console — and the whole
 * point of the banner is that a scaled dev/CI auth throttle can never sit in a production environment
 * unannounced. This suite drives the REAL `assembleServer` against a throwaway DATABASE with a
 * `bootWarn` spy and asserts the emission itself:
 *
 *   (a) RAYSPEC_AUTH_RATE_MULTIPLIER=100 ⇒ the boot emits EXACTLY ONE line naming the variable, and
 *       that line is BYTE-IDENTICAL to `authRateMultiplierBanner(100)` — so the pure-function pin and
 *       the shipped emission can never drift apart, and it goes through `bootWarn`, not `console.warn`.
 *   (b) ACCEPT CONTROL: the DEFAULT boot (variable unset ⇒ multiplier 1) emits NO such line — the
 *       banner is conditional, not unconditional noise a deployer would learn to ignore. Arm (a) is
 *       this arm's instrument check: the same spy on the same seam DOES capture the line when the
 *       multiplier is scaled, so (b)'s empty reading is a real absence, not a dead spy.
 *
 * DB ISOLATION: a whole throwaway DATABASE (not a per-schema), as in the sibling boot suites — the
 * migration chain materializes the platform into a database's default + `drizzle` schema.
 */
import { exportPKCS8, generateKeyPair } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assembleServer,
  authRateMultiplierBanner,
  type BootedServer,
  loadServerConfig,
} from './composition-root.js';

const SUITE_DB = `rayspec_server_authratebanner_${process.pid}`;

/** Point an admin connection at the server's `postgres` database (mirrors the sibling suites). */
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

describe('auth-rate-multiplier boot banner — emitted through the REAL bootWarn seam', () => {
  const baseUrl = process.env.DATABASE_URL;
  const maybe = baseUrl ? it : it.skip;
  const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
  // un-skippable ran-guard (fires synchronously at collection): when the DB is REQUIRED but absent,
  // hard-fail rather than let this DB-backed boot suite silently self-skip to a false green.
  if (requireDb && !baseUrl) {
    throw new Error(
      'auth-rate-multiplier-boot.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) ' +
        'but absent — refusing to silently skip this DB-backed suite.',
    );
  }

  let server: BootedServer | undefined;
  let cleanDbUrl = '';

  // Save EVERY env var the suite mutates so it cannot poison a sibling test file.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'DATABASE_URL',
    'RAYSPEC_JWT_SIGNING_KEY',
    'RAYSPEC_API_KEY_PEPPER',
    'RAYSPEC_AUTH_RATE_MULTIPLIER',
    'ALLOWED_ORIGINS',
    'PORT',
  ] as const;

  beforeAll(async () => {
    if (!baseUrl) return;
    cleanDbUrl = (() => {
      const u = new URL(baseUrl);
      u.pathname = `/${SUITE_DB}`;
      return u.toString();
    })();

    const admin = postgres(adminUrlOf(baseUrl), { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE "${SUITE_DB}"`);
    } finally {
      await admin.end();
    }

    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    process.env.DATABASE_URL = cleanDbUrl;
    process.env.RAYSPEC_JWT_SIGNING_KEY = await exportPKCS8(privateKey);
    process.env.RAYSPEC_API_KEY_PEPPER = 'auth-rate-banner-pepper-only';
    delete process.env.ALLOWED_ORIGINS;
    process.env.PORT = '8807';
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    for (const k of ENV_KEYS) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (baseUrl && cleanDbUrl) {
      const admin = postgres(adminUrlOf(baseUrl), { max: 1 });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS "${SUITE_DB}" WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  }, 60_000);

  /** Boot once with a capturing sink and return every line the boot handed to `bootWarn`. */
  async function bootCapturingWarnings(): Promise<string[]> {
    const warnings: string[] = [];
    const config = loadServerConfig();
    server = await assembleServer(config, { bootWarn: (line: string) => warnings.push(line) });
    await server.close();
    server = undefined;
    return warnings;
  }

  maybe(
    'a scaled multiplier emits ONE banner line through bootWarn, byte-identical to the pinned text',
    async () => {
      process.env.RAYSPEC_AUTH_RATE_MULTIPLIER = '100';
      const warnings = await bootCapturingWarnings();

      const banner = warnings.filter((w) => w.includes('RAYSPEC_AUTH_RATE_MULTIPLIER'));
      // Exactly one — the deployer gets one line, not a repeated or duplicated announcement.
      expect(banner).toHaveLength(1);
      // BYTE-IDENTICAL to the pure function the unit suite pins, so the two can never drift: this is
      // the shipped emission, captured at the injectable sink `assembleServer` actually writes to.
      expect(banner[0]).toBe(authRateMultiplierBanner(100));
    },
    120_000,
  );

  maybe(
    'ACCEPT CONTROL: the DEFAULT boot (multiplier unset ⇒ 1) emits no such line at all',
    async () => {
      delete process.env.RAYSPEC_AUTH_RATE_MULTIPLIER;
      const config = loadServerConfig();
      expect(config.authRateMultiplier).toBe(1);

      const warnings = await bootCapturingWarnings();
      expect(warnings.filter((w) => w.includes('RAYSPEC_AUTH_RATE_MULTIPLIER'))).toEqual([]);
    },
    120_000,
  );
});
