/**
 * Vitest setup for the Codex adapter's tests: load the repo-root .env so DATABASE_URL (and any creds)
 * are present regardless of the working directory the runner is launched from. The offline unit tests
 * (auth guard / confinement options / MCP-bridge wiring / event mapping / replay) ignore it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/adapters/codex -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
