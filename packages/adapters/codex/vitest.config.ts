import { defineConfig } from 'vitest/config';

// The codex adapter's unit tests are OFFLINE + deterministic (a fake journal/dispatch + a fake codex
// SDK — they never spawn the real `codex` CLI). The DB-backed replay-parity test (if present) hits a
// real Postgres (DATABASE_URL) and resets a per-file schema; keep all files serial so a reset cannot
// race the offline unit tests. (Vitest 4: fileParallelism is the knob; poolOptions removed.)
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
