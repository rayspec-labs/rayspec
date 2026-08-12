/**
 * Vitest setup for the OpenAI TTS adapter package: load the repo-root .env so OPENAI_API_KEY is present
 * for the LIVE synthesis test (which self-skips when absent — it is absent in CI). Mirrors the STT
 * adapter package's setup; the deterministic adapter suite ignores it entirely (it injects its own
 * fetch and its own env record, so it never reads the ambient environment).
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/adapters/openai-tts -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
