import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // DB-backed suites mutate a shared Postgres; run files serially so the per-suite schema
    // reset of one file cannot race another. Individual tests within a file still run in order.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
