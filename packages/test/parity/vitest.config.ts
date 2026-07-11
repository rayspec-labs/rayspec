import { defineConfig } from 'vitest/config';

// The cross-backend parity suite runs on COMMITTED fixtures (deterministic, no creds, no DB) PLUS
// self-skipping live smoke tests (skipped in CI where creds are absent). Keep files serial so the
// live smoke tests — when run locally — do not race on the per-tenant CLAUDE_CONFIG_DIR / shared key.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 120_000,
  },
});
