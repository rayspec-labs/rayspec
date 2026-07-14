/**
 * api-auth test setup.
 *
 * 1. Load the repo .env so DATABASE_URL (Postgres on 5433) is available to the DB-backed suites.
 * 2. Provision dev-only boot secrets (signing key + api-key pepper) IF the env does not already
 *    supply them — mirrors auth-core's setup. The boot-fails-closed test deletes these inside
 *    its own process to prove the app refuses to start without them, then restores them.
 *
 * These are DEV/TEST values ONLY — never a production secret. The real values live in .env
 * (gitignored) and ci.yml env (plumbing).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDotenv } from './src/test-support/dotenv.js';

// Minimal .env loader (no dotenv dependency in the runtime path): parse KEY=VALUE lines (dequoting a
// surrounding quote pair — a double-quoted DATABASE_URL would otherwise throw `Invalid URL`), and do
// not overwrite anything already set in the process environment.
const envPath = join(__dirname, '..', '..', '..', '.env');
if (existsSync(envPath)) {
  for (const [key, value] of parseDotenv(readFileSync(envPath, 'utf8'))) {
    if (!(key in process.env)) process.env[key] = value;
  }
}

if (!process.env.RAYSPEC_API_KEY_PEPPER) {
  process.env.RAYSPEC_API_KEY_PEPPER = 'dev-pepper-for-tests-only';
}
if (!process.env.RAYSPEC_JWT_SIGNING_KEY) {
  // A deterministic dev RS256 PKCS#8 key is generated lazily by the test helper; for suites that
  // only need the value present (boot-fails-closed positive arm) a placeholder marker is enough,
  // but token suites generate a real key. We leave it unset here so token suites can inject a
  // freshly generated key; suites that merely assert "present" set it themselves.
}
