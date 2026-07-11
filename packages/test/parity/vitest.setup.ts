/**
 * Vitest setup for the parity package: load the repo-root .env so OPENAI_API_KEY /
 * CLAUDE_CODE_OAUTH_TOKEN are present for the LIVE smoke tests (which self-skip when absent — they
 * are absent in CI). The deterministic fixture-based parity suite ignores it.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/test/parity -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
