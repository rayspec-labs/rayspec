import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load the repo-root .env so DATABASE_URL is present for the TenantDb DB-backed tests.
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, '..', '..', '..', '.env');
if (existsSync(envPath)) config({ path: envPath });

export default defineConfig({
  test: {
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
