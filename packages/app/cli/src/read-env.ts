/**
 * Local-development-only optional `.env` auto-loader for the `rayspec` CLI (a local development convenience).
 *
 * `rayspec plan`'s OPTIONAL shadow-apply only runs when `SHADOW_DATABASE_URL` is set, and the read-only
 * same-DB guard can only fire when it has a `DATABASE_URL` to compare against. Without auto-loading
 * a local `.env`, an operator running `node packages/cli/dist/index.js plan …` got a silent
 * `shadowApplied:false` (the shadow check skipped) and no read-only-guard comparison target — unless they
 * manually exported both. This loader fixes that by reading a local `.env` at CLI startup,
 * mirroring `@rayspec/server`'s `loadLocalDotenvIfPresent` (packages/server/src/serve.ts).
 *
 * Mirrored guarantees (identical to the server's loader):
 *   • DEV-ONLY — a real deployment sets env via its orchestrator/secret manager and this file is
 *     absent; we load a candidate `.env` (gitignored) ONLY IF it exists.
 *   • NO-OVERRIDE — never clobber an already-set `process.env` var; an explicit shell/CI value always
 *     wins. This is what keeps the loader safe to call unconditionally before every subcommand.
 *   • `\n`-UNESCAPE — PEMs are stored on one line with literal `\n` in this repo's `.env`; we unescape
 *     them (harmless to the DB URLs the CLI actually consumes, and kept for parity with the server).
 *   • OPT-OUT — `RAYSPEC_SKIP_DOTENV=1` disables it entirely (to prove a pure-ambient-env run).
 *
 * `doctor` needs no env, so this is a no-op for it; `plan`'s read-only guarantee is UNCHANGED — the
 * loader only makes `DATABASE_URL` readable so the read-only guard can COMPARE (a net security improvement:
 * the guard now fires where before it was skipped for lack of a compare target). `plan` still NEVER
 * connects to `DATABASE_URL`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `.env` locations the loader searches, in PRECEDENCE order (deduplicated when they coincide —
 * the common run-from-the-checkout-root case):
 *   1. `$PWD/.env` — the INVOKING project's file. In the vendored/submodule layout the brownfield
 *      docs recommend (the CLI run from `vendor/rayspec/…` inside a product repo), this is where the
 *      config actually lives.
 *   2. the INSTALL-ROOT `.env`, resolved relative to THIS module's own location
 *      (`packages/cli/{src,dist}` → the RaySpec checkout root) — the same source-relative resolution
 *      the server's loader uses, and identical to `$PWD/.env` when the CLI is run from its own checkout.
 * Exported so the missing-required-variable refusal can NAME the searched paths (paths only — never
 * file contents).
 */
export function dotenvCandidatePaths(): readonly string[] {
  // packages/cli/{src,dist} -> repo root.
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    ...new Set([resolve(process.cwd(), '.env'), resolve(here, '..', '..', '..', '..', '.env')]),
  ];
}

/**
 * Load each candidate `.env` into `process.env` if present, without overriding an already-set var.
 * The candidates are loaded in precedence order and the parse is no-override PER KEY, so the effective
 * precedence is: real environment > `$PWD/.env` > install-root `.env` — an earlier source always wins,
 * a later one only fills keys still unset.
 */
export function loadLocalDotenvIfPresent(): void {
  if (process.env.RAYSPEC_SKIP_DOTENV === '1') return;
  for (const envPath of dotenvCandidatePaths()) loadDotenvNoOverride(envPath);
}

/** Load ONE `.env` file if it exists — the parse the single-path loader has always run, per path. */
function loadDotenvNoOverride(envPath: string): void {
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  }
}
