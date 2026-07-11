import { defineConfig } from 'vitest/config';

// Platform tests hit a real Postgres (DATABASE_URL). Run them in a single process so
// the per-file schema setup/teardown does not race across worker pools.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    // DB-backed tests share one Postgres + a per-file schema reset; keep them serial so
    // the resets don't race. (Vitest 4: poolOptions removed — fileParallelism is the knob.)
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
