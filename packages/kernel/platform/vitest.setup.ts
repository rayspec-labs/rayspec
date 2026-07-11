/**
 * Vitest setup for platform DB tests: load the repo-root .env so DATABASE_URL is present
 * regardless of the working directory the test runner is launched from.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/platform -> repo root is two levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
