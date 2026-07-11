/**
 * Vitest setup: load the repo-root .env so DATABASE_URL is present regardless of the working directory
 * the runner is launched from (mirrors platform/db/durable-dbos). In CI (no .env) the DB-backed suites
 * self-skip UNLESS `RAYSPEC_REQUIRE_DB_TESTS==='true'` — the un-skippable ran-guard.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/workflow-durable -> repo root is two levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
