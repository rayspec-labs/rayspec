/**
 * Vitest setup for the durable-dbos integration test: load the repo-root .env so DATABASE_URL is
 * present regardless of the working directory the runner is launched from (same as platform/db).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/durable-dbos -> repo root is two levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
