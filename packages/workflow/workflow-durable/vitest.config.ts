import { defineConfig } from 'vitest/config';

// The workflow-durable DB-backed tests journal to a real Postgres (isolated per-suite schemas via
// makeDbWithSchema). No DBOS engine is booted here (the DBOS integration lives in @rayspec/durable-dbos),
// but the suites share the one local Postgres — run files serially in forks with generous timeouts.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
