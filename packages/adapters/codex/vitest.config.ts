import { defineConfig } from 'vitest/config';

// The codex adapter's tests are OFFLINE + deterministic. Most of them use a fake journal/dispatch +
// a fake codex SDK; the cancellation tests use the REAL SDK, which spawns a real child process — but
// that child is a fake `codex` executable the test writes into a temp dir, so the real `codex` CLI is
// still never executed and no network is touched. No credential file is read either, but that takes
// BOTH halves of `vitest.setup.ts`: it drops `CODEX_HOME` after loading `.env` (which would otherwise
// OVERRIDE the temp home a test passes) AND repoints `HOME` at an empty temp dir (because the tests
// that pass no `codexHome` at all would otherwise fall through to the real `$HOME/.codex/auth.json`).
// Every adapter this suite builds therefore resolves a credential-free home. The DB-backed replay-parity
// test (if present) hits a real Postgres (DATABASE_URL) and resets a per-file schema; keep all files
// serial so a reset cannot race the other tests. (Vitest 4: fileParallelism is the knob; poolOptions
// removed.)
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
