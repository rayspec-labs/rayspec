import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The example cases compile handlers and extensions with the TypeScript compiler first.
    testTimeout: 60_000,
  },
});
