import { defineConfig } from 'vitest/config';

// The DB-backed C3 replay-parity test hits a real Postgres (DATABASE_URL) and resets a per-file
// schema; keep all files serial so the reset cannot race the offline unit tests. (Vitest 4:
// fileParallelism is the knob; poolOptions removed.)
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
