import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load the repo-root .env so DATABASE_URL (Postgres on :5433) is present for the boot smoke test.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '.env');
if (existsSync(envPath)) config({ path: envPath });

export default defineConfig({
  test: {
    pool: 'forks',
    // The smoke test creates + drops its OWN throwaway database; run files serially so a parallel
    // file cannot collide on the admin connection / the throwaway DB name.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
