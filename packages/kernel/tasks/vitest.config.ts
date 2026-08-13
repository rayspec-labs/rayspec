import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // The db-backed suites share one local Postgres; serialize files so per-file TRUNCATEs and
    // seeded orgs cannot race each other (same posture as api-auth / durable-dbos).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // A NARROW, deliberate threshold — not a repo-wide one: these are the modules where an
      // untested branch is a corrupted task graph. Both are PURE decision modules (no I/O), so the
      // threshold holds in every lane, database or not. `include` keeps the report itself scoped to
      // the thresholded modules; everything else in the package is covered by its ordinary suites
      // without a numeric gate.
      include: ['src/status.ts'],
      thresholds: {
        'src/status.ts': { branches: 100 },
      },
    },
  },
});
