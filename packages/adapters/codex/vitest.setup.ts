/**
 * Vitest setup for the Codex adapter's tests: load the repo-root .env so DATABASE_URL (and any creds)
 * are present regardless of the working directory the runner is launched from. The offline unit tests
 * (auth guard / confinement options / MCP-bridge wiring / event mapping / replay) ignore it.
 *
 * Then make the resolved codex home CREDENTIAL-FREE for every adapter this suite constructs.
 * `CodexAdapter.resolveCodexHome()` is `process.env.CODEX_HOME ?? opts.codexHome ?? $HOME/.codex`,
 * and `run()` calls `authSelfCheck()` on its first line, so EVERY construction resolves a home and
 * looks for `auth.json` in it. Both fallbacks have to be closed, and closing only one moves the read
 * rather than removing it:
 *   - `CODEX_HOME` is DROPPED, because the ambient variable WINS over the temp home a test passes to
 *     the constructor, and `.env` / CI is exactly where a real one gets set (`.env.example` ships
 *     `CODEX_HOME=` as the documented way to configure this backend);
 *   - `HOME` is repointed at a fresh empty temp dir, because most of the suite constructs
 *     `new CodexAdapter()` with NO `codexHome` at all — for those, dropping `CODEX_HOME` merely
 *     redirects the read to `$HOME/.codex/auth.json`, which is where the real ChatGPT-OAuth session
 *     lives on a developer machine.
 * With both in place the resolved home is either a temp dir a test made itself or an empty one, so
 * the real `auth.json` is never opened and cannot be re-exported into the child through the curated
 * env. The resolution order this rests on is pinned by a test (`adapter.test.ts`, "resolveCodexHome
 * PRECEDENCE"). Tests that need a codex home set it themselves; every one of them is restored by
 * adapter.test.ts's env snapshot hooks.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
// packages/adapters/codex -> repo root is three levels up.
const repoRoot = join(here, '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });
delete process.env.CODEX_HOME;

// A fresh dir, so it provably contains no `.codex` — a fixed path could accumulate one.
const emptyHome = mkdtempSync(join(tmpdir(), 'codex-suite-home-'));
process.env.HOME = emptyHome;
process.on('exit', () => rmSync(emptyHome, { recursive: true, force: true }));
