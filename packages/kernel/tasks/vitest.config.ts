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
      // untested branch is a corrupted task graph. `include` keeps the report itself scoped to the
      // thresholded modules; everything else in the package is covered by its ordinary suites
      // without a numeric gate.
      //
      // MEASURED ON THE FULL SUITE, which is the only way CI runs this package: `@rayspec/tasks` is
      // excluded from lane 1 (.github/workflows/ci.yml:313) and included in lane 2 (:417), so the
      // thresholds are enforced WITH a database. A no-database run skips the .db.test.ts files and
      // cannot meet them — `src/intent-applier.ts` reaches 88.88% branches that way, because the
      // only exercise `classificationForIntent` (src/intent-applier.ts:92-109) gets today comes
      // from db-backed suites. Being a pure module does not make its COVERAGE lane-independent;
      // that is a property of the tests, not of the code under them.
      include: ['src/status.ts', 'src/intent-applier.ts'],
      thresholds: {
        'src/status.ts': { branches: 100 },
        'src/intent-applier.ts': { branches: 100 },
      },
    },
  },
});
