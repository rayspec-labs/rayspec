/**
 * Vitest setup for the OpenAI adapter's DB-backed C3 replay-parity test: load the repo-root .env
 * so DATABASE_URL is present regardless of the working directory the runner is launched from. The
 * non-DB unit tests (mapping/derive/integration) ignore it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/adapters/openai -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
