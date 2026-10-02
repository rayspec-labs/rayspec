import { defineConfig } from 'vitest/config';

// The hosting-posture certification suites (`src/certification/`), run by `pnpm test:certification`
// (scripts/certification.mjs) and the CI certification job. Each suite deploys through the real
// built CLI on databases of its own, so the files run one after another.
export default defineConfig({
  test: {
    include: ['src/certification/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
});
