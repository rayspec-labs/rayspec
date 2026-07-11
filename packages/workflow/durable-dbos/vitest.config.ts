import { defineConfig } from 'vitest/config';

// The durable-dbos integration test launches a REAL DBOS engine against a real Postgres (the app DB
// via DATABASE_URL + a throwaway DBOS SYSTEM DB). DBOS owns background workers/timers, so run files
// serially in forks (no cross-file engine races) with generous timeouts (launch + dequeue latency).
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
