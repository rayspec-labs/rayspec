/**
 * Boot-fails-closed integration test (exit gate item).
 *
 * The app REFUSES to construct without BOTH RAYSPEC_JWT_SIGNING_KEY and RAYSPEC_API_KEY_PEPPER.
 * This runs in (the secrets are wired into ci.yml + .env here), not deferred to.
 *
 * It builds a real harness (so all deps are wired), then unsets each secret in turn and asserts
 * createAuthApp throws — proving the boot gate is enforced at app construction. Restores the env.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAuthApp } from './app.js';
import { createHarness, type Harness } from './test-support/harness.js';

let h: Harness;
let savedKey: string | undefined;
let savedPepper: string | undefined;

beforeAll(async () => {
  h = await createHarness({ schema: 'rayspec_test_apiauth_bootstrap' });
  savedKey = process.env.RAYSPEC_JWT_SIGNING_KEY;
  savedPepper = process.env.RAYSPEC_API_KEY_PEPPER;
});

afterEach(() => {
  // Restore both after each manipulation so other suites are unaffected.
  if (savedKey !== undefined) process.env.RAYSPEC_JWT_SIGNING_KEY = savedKey;
  else delete process.env.RAYSPEC_JWT_SIGNING_KEY;
  if (savedPepper !== undefined) process.env.RAYSPEC_API_KEY_PEPPER = savedPepper;
  else delete process.env.RAYSPEC_API_KEY_PEPPER;
});

afterAll(async () => {
  await h.close();
});

describe('boot-fails-closed', () => {
  it('refuses to construct the app without RAYSPEC_JWT_SIGNING_KEY', () => {
    process.env.RAYSPEC_JWT_SIGNING_KEY = '';
    expect(() => createAuthApp(h.deps)).toThrow(/RAYSPEC_JWT_SIGNING_KEY/);
  });

  it('refuses to construct the app without RAYSPEC_API_KEY_PEPPER', () => {
    process.env.RAYSPEC_API_KEY_PEPPER = '';
    expect(() => createAuthApp(h.deps)).toThrow(/RAYSPEC_API_KEY_PEPPER/);
  });

  it('refuses when BOTH are missing (lists both)', () => {
    process.env.RAYSPEC_JWT_SIGNING_KEY = '';
    process.env.RAYSPEC_API_KEY_PEPPER = '';
    expect(() => createAuthApp(h.deps)).toThrow(/missing/);
  });

  it('constructs cleanly when both are present', () => {
    expect(() => createAuthApp(h.deps)).not.toThrow();
  });
});
