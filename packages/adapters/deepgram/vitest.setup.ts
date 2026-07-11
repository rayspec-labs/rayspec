/**
 * Vitest setup for the deepgram adapter package: load the repo-root .env so DEEPGRAM_API_KEY is present for
 * the LIVE Deepgram integration test (which self-skips when absent — it is absent in CI). Mirrors the
 * parity package's setup; the deterministic mapper/adapter/selection suites ignore it entirely.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/adapters/deepgram -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
