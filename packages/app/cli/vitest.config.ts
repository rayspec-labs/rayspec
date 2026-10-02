import { configDefaults, defineConfig } from 'vitest/config';

// cli/index.test.ts runs the in-process `plan` (parseSpec+generateProductSql+scanMigrationSql, no DB)
// which can exceed vitest's 5000ms default on a cold start under full-suite CPU load (TEST-FLAKE-1, the
// cli half). A generous timeout removes the cold-start flake without changing any product behavior.
// Matches the timeout the DB/engine packages already use (durable-dbos/server: testTimeout 60_000).
//
// `src/certification/` holds the hosting-posture certification suites. They run in their own lane
// (`pnpm test:certification`, vitest.certification.config.ts), not in this package's ordinary run.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude, 'src/certification/**'],
  },
});
