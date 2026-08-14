import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // The db-backed suites share one local Postgres; serialize files so per-file TRUNCATEs and
    // seeded orgs cannot race each other (same posture as tasks / api-auth).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
