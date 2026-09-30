import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // The entry-count case builds and reads an archive of 10,005 entries.
    testTimeout: 30_000,
  },
});
