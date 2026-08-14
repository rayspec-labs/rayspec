/**
 * Vitest setup for the task-engine db-backed suites: load the repo-root .env so DATABASE_URL is
 * present regardless of the working directory the runner is launched from (same as platform/db).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/kernel/tasks -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
