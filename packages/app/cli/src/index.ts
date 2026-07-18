#!/usr/bin/env node
/**
 * The `rayspec` CLI — a READ-ONLY diagnostic floor PLUS a clearly-separated, LOCAL-DEV mutating `dev`
 * group. Each subcommand emits machine-parseable JSON to stdout:
 *
 * READ-ONLY DIAGNOSTIC FLOOR (never mutates a real/target DB; never prints secrets):
 *   rayspec doctor <spec.yaml>   STATIC validity (parseSpec; no Postgres).      exit 0 ok / 1 not.
 *   rayspec plan   <spec.yaml>   the deploy() FRONT-HALF, READ-ONLY dry-run.    exit 0 ok / 1 not.
 *      [--against <old-spec>]     Handles both profiles (backend + product). With --against,
 *      [--allowlist <file.json>]  diffs prior->new into a DELTA (destructive delta BLOCKED unless the
 *                                 --allowlist covers it). With SHADOW_DATABASE_URL set, shadow-applies
 *                                 to a THROWAWAY DB (never the real target). Mutates NOTHING on it.
 *   rayspec gen-handler …        Render ONE bounded-template handler (.ts) from a holes contract.
 *
 * LOCAL-DEV, MUTATING (`dev` group — deliberately creates a dev DB / writes secret files; distinct
 * from the diagnostic floor above):
 *   rayspec dev gen-secrets …    Mint the 3 platform boot secrets into a `.env` (idempotent; never
 *                                 overwrites an existing key; NEVER echoes a value). chmod 600.
 *   rayspec dev db …             Create the dev database if absent (idempotent; never destructive);
 *                                 --reset --yes DROPs + re-creates a clean one.
 *   rayspec dev bootstrap-tenant Create the first tenant+owner via the shipped auth API; emit the
 *                                 org id + the org-scoped token (a deliberate operator credential).
 *
 * The diagnostic-floor commands wrap already-shipped functions — NO new platform mechanism. Output is
 * JSON only (stdout); a usage/CLI error prints a short JSON error to stderr + exit 2. The read-only
 * floor never echoes env vars / DB URLs / credentials; `dev gen-secrets`/`dev db` never echo a secret
 * VALUE (only a written/present summary), while `dev bootstrap-tenant` emits a freshly-minted org token
 * as its deliberate, documented output.
 */
import { realpathSync } from 'node:fs';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DeployCliError, runDeploy } from './deploy.js';
import { DevCliError, runDev } from './dev.js';
import { runDoctor } from './doctor.js';
import { GenHandlerCliError, runGenHandler } from './gen-handler.js';
import { InitCliError, runInit } from './init.js';
import { runOpenapi } from './openapi.js';
import { runPlan } from './plan.js';
import { loadLocalDotenvIfPresent } from './read-env.js';

const USAGE = `rayspec — RaySpec CLI

GET STARTED:
  rayspec init [dir] [--force]  Scaffold a new project: write a minimal, valid starter rayspec.yaml
                                (one store + its CRUD routes) into [dir] (default: the current
                                directory). Product-neutral, no custom code. Refuses to overwrite an
                                existing rayspec.yaml unless --force. Then validate it with
                                \`rayspec doctor ./rayspec.yaml\` and preview a deploy with
                                \`rayspec plan ./rayspec.yaml\`.

READ-ONLY diagnostic floor (never mutates a real/target DB; never prints secrets):
  rayspec doctor <spec.yaml>   Static spec validation (parseSpec). Exit 0 if valid, 1 otherwise.
  rayspec plan   <spec.yaml> [--against <old-spec>] [--allowlist <file.json>]
                             [--reconcile-injected-columns]
                                Read-only deploy front-half (validate -> diff -> gate [-> shadow]).
                                Handles both spec profiles (backend + product). With --against, diffs
                                the prior spec FILE -> new spec into a DELTA migration (a destructive
                                delta is BLOCKED unless covered by the reviewed --allowlist JSON). Set
                                SHADOW_DATABASE_URL to also apply the SQL to a throwaway DB (in update
                                mode: baseline -> delta -> assert drift-clean). Add
                                --reconcile-injected-columns (update mode only) when the target DB
                                predates the platform tenancy columns and genuinely lacks
                                created_by / idempotency_key: the delta then also carries their
                                idempotent ADD COLUMN IF NOT EXISTS + idempotency index. Never mutates
                                the real/target DB. Exit 0/1.
  rayspec gen-handler --holes <holes.json> --out <dir> [--file <name.ts>]
                                Render ONE bounded-template handler (.ts) from a holes contract
                                Deterministic; type-only SDK import; zero npm deps.
  rayspec openapi <spec.yaml>  Emit the OpenAPI 3.1 document for a product-profile doc's declared
                                VIEW surface (read routes → paths/params/response schemas). Product profile only.

PRODUCTION-MUTATING (boots + serves a real deployment; mutates the target DB):
  rayspec deploy <spec.yaml> [--port <n>] [--host <addr>] [--apply-migration <delta.sql> [--allowlist <file.json>]]
                                Assemble the platform from the ambient env, register the product
                                stores through the SANCTIONED validating registrar, apply the committed
                                migration chain + roll out the declared product, and SERVE on PORT
                                (default 8080) until SIGINT/SIGTERM. Binds LOOPBACK (127.0.0.1) by
                                default; --host <addr> (e.g. 0.0.0.0) is an explicit opt-in to another
                                interface — the banner logs the ACTUAL bound address. Reads config from
                                env (see the @rayspec/server package README); fails closed on a missing
                                secret.
                                With --apply-migration, boot in UPDATE mode: apply the reviewed FORWARD
                                delta <delta.sql> to the EXISTING schema in place (existing rows
                                survive). A DESTRUCTIVE statement is BLOCKED unless covered by the
                                reviewed --allowlist JSON. Author the delta with
                                \`rayspec plan <new-spec> --against <old-spec>\`. Drop --apply-migration
                                from the NEXT deploy once the delta has landed (a delta is not
                                idempotent).
  rayspec deploy --dry-run <spec.yaml>
                                One-shot: validate the product doc + COMPOSE it against a stubbed
                                rollout. NO DB, NO network. Emits a JSON verdict. Does NOT prove: the
                                migration, boot-env sufficiency, any provider credential, live-schema
                                drift, or that the app serves. Exit 0 ok / 1 not.

LOCAL-DEV, MUTATING (the \`dev\` group — creates a dev DB / writes secret files):
  rayspec dev gen-secrets [--out <path>]
                                Mint the 3 platform boot secrets (RS256 JWT PEM, api-key pepper,
                                media key) into a .env (default ./.env). Idempotent: never overwrites
                                an existing key; NEVER echoes a value (prints a written/present
                                summary only). chmod 600.
  rayspec dev db [--database-url <url>] [--name <db>] [--reset --yes]
                                Create the dev database if absent (idempotent; never destructive).
                                Base URL from --database-url or DATABASE_URL. With --reset --yes,
                                DROP + re-create a CLEAN database (destroys all data; --reset alone
                                refuses without --yes).
  rayspec dev bootstrap-tenant --base-url <url> [--email <e>] [--password <p>] [--org-name <n>]
                                Create the first tenant+owner via the shipped auth API; emit ORG_ID
                                + the org-scoped token (a deliberate operator credential).

Output: a single JSON object on stdout. Exit 1 = not-ok; exit 2 = a CLI/usage error.`;

/**
 * A CLI error: a usage/argument problem (exit 2 — distinct from a not-ok spec, which is exit 1).
 * Thrown by `main` and caught at the top level so `main` can RETURN an exit code (testable in-process)
 * rather than calling `process.exit` mid-flight (which truncates a not-yet-drained stdout).
 */
class CliError extends Error {}

/**
 * Write a string to a stream and RESOLVE only once the chunk is flushed (the write callback fired).
 * This is the drain-safe pattern: we must not `process.exit` while a large JSON payload is
 * still buffered in stdout, or it gets truncated. Awaiting the callback lets the chunk drain first.
 */
function writeDrained(stream: NodeJS.WriteStream, s: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(s, (err) => (err ? reject(err) : resolve()));
  });
}

/** Pretty-print a JSON object to stdout (drain-safe), followed by a newline. */
function emit(obj: unknown): Promise<void> {
  return writeDrained(process.stdout, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * The CLI body. RETURNS the numeric exit code (0 ok · 1 not-ok spec/plan · 2 CLI/usage error) instead
 * of calling `process.exit`, so it is testable in-process and the top-level can drain stdout before
 * exiting. A usage/argument problem is raised as a `CliError` and mapped to exit 2 by the
 * top-level handler (which prints it to stderr); a not-ok spec/plan result is printed to stdout (it is
 * the command's normal machine-readable output) and mapped to exit 1.
 *
 * `args` is the subcommand+positionals slice (defaults to `process.argv.slice(2)` — the real CLI
 * path). It is a parameter (not parseArgs's auto-stripping default) so a test can drive `main` with an
 * EXPLICIT arg vector and get the same behavior the CLI does, without depending on how `node -e` /
 * vitest shape `process.argv`.
 */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  // DEV-DX: auto-load the repo-root `.env` (no-override, opt-out via RAYSPEC_SKIP_DOTENV=1) ONCE at
  // startup so `plan`'s optional shadow-apply picks up SHADOW_DATABASE_URL + DATABASE_URL out of the
  // box (matching the server boot). Harmless to `doctor` (needs no env); does NOT change plan's
  // read-only guarantee — it only makes DATABASE_URL readable so the read-only guard has a compare target.
  loadLocalDotenvIfPresent();

  // The subcommand is the FIRST raw token; the rest is handed to that subcommand UNPARSED (each owns
  // its own arg grammar). `gen-handler` carries its own `--holes/--out/--file` flags, so the top-level
  // must NOT strict-parse them; `doctor`/`plan` take a single positional path. (A leading `--flag` —
  // no subcommand — is a usage error.)
  const command = args[0];
  const rest = args.slice(1);
  if (command === undefined) {
    throw new CliError(
      'missing command (expected `init`, `doctor`, `plan`, `openapi`, `gen-handler`, `deploy`, or `dev`)',
    );
  }
  if (command.startsWith('-')) {
    throw new CliError(
      `expected a subcommand (\`init\`, \`doctor\`, \`plan\`, \`openapi\`, \`gen-handler\`, \`deploy\`, or \`dev\`), got ${command}`,
    );
  }

  switch (command) {
    case 'init': {
      // GET-STARTED: scaffold a starter project. A usage problem (unknown flag, extra positional,
      // `..`-escape) is an InitCliError → re-thrown as a CliError → exit 2; an existing-spec-without
      // --force is a normal ok:false → exit 1.
      let result: Awaited<ReturnType<typeof runInit>>;
      try {
        result = await runInit(rest);
      } catch (e) {
        if (e instanceof InitCliError) throw new CliError(e.message);
        throw e;
      }
      await emit(result);
      return result.ok ? 0 : 1;
    }
    case 'doctor': {
      const result = await runDoctor(parsePositionals(rest));
      await emit(result);
      return result.ok ? 0 : 1;
    }
    case 'plan': {
      const { positionals, against, allowlist, reconcileInjectedColumns } = parsePlanArgs(rest);
      const result = await runPlan(positionals, { against, allowlist, reconcileInjectedColumns });
      await emit(result);
      return result.ok ? 0 : 1;
    }
    case 'openapi': {
      const result = await runOpenapi(parsePositionals(rest));
      await emit(result);
      return result.ok ? 0 : 1;
    }
    case 'gen-handler': {
      // gen-handler raises a GenHandlerCliError on a usage problem (missing flag / bad path); re-throw
      // it as a CliError so the top-level maps it to exit 2 (a malformed hole-set is ok:false → exit 1).
      let result: Awaited<ReturnType<typeof runGenHandler>>;
      try {
        result = await runGenHandler(rest);
      } catch (e) {
        if (e instanceof GenHandlerCliError) throw new CliError(e.message);
        throw e;
      }
      await emit(result);
      return result.ok ? 0 : 1;
    }
    case 'deploy': {
      // PRODUCTION-MUTATING: `--dry-run` is a one-shot JSON verdict (mapped to 0/1 like the floor); a
      // bare `deploy` is LONG-RUNNING — it boots + serves until SIGINT/SIGTERM, so it does not return a
      // JSON result (the open port + signal handlers keep the process alive). A usage problem is a
      // DeployCliError → exit 2; a fail-closed boot error is handled inside runDeploy (prints + exit 1).
      let outcome: Awaited<ReturnType<typeof runDeploy>>;
      try {
        outcome = await runDeploy(rest);
      } catch (e) {
        if (e instanceof DeployCliError) throw new CliError(e.message);
        throw e;
      }
      if (outcome.kind === 'dry-run') {
        await emit(outcome.result);
        return outcome.result.ok ? 0 : 1;
      }
      // 'served' — the server is listening; the process stays alive until a signal fires shutdown.
      return 0;
    }
    case 'dev': {
      // The `dev` group is LOCAL-DEV + MUTATING (creates a dev DB / writes secret files) — distinct
      // from the read-only diagnostic floor. A usage problem inside `dev` is a DevCliError; re-throw it
      // as a CliError so the top level maps it to exit 2 (an operational failure is returned ok:false).
      let result: Awaited<ReturnType<typeof runDev>>;
      try {
        result = await runDev(rest);
      } catch (e) {
        if (e instanceof DevCliError) throw new CliError(e.message);
        throw e;
      }
      await emit(result);
      return result.ok ? 0 : 1;
    }
    default:
      throw new CliError(
        `unknown command ${JSON.stringify(command)} (expected \`init\`, \`doctor\`, \`plan\`, \`openapi\`, \`gen-handler\`, \`deploy\`, or \`dev\`)`,
      );
  }
}

/**
 * Parse the positional path args for `doctor` (which takes exactly one positional, no flags). An
 * unknown `--flag` is a strict CLI error — preserving the original "doctor rejects unknown flags"
 * behaviour now that the top level no longer pre-parses the whole vector.
 */
function parsePositionals(args: readonly string[]): string[] {
  try {
    const { positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {},
    });
    return positionals;
  } catch (e) {
    throw new CliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Parse `plan`'s args: exactly one positional spec path, plus the OPTIONAL update-mode flags
 * `--against <old-spec>`, `--allowlist <file.json>`, and the boolean `--reconcile-injected-columns`.
 * Unknown flags are a strict CLI error. The positional-count check stays in `resolveSpecPath` (a
 * missing/extra positional there is a clean plan error), so a bare `plan` with no positional still
 * routes through the normal channel.
 */
function parsePlanArgs(args: readonly string[]): {
  positionals: string[];
  against?: string;
  allowlist?: string;
  reconcileInjectedColumns?: boolean;
} {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        against: { type: 'string' },
        allowlist: { type: 'string' },
        'reconcile-injected-columns': { type: 'boolean' },
      },
    });
    return {
      positionals,
      against: values.against,
      allowlist: values.allowlist,
      reconcileInjectedColumns: values['reconcile-injected-columns'],
    };
  } catch (e) {
    throw new CliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Top-level runner: invoke `main`, set `process.exitCode` (NOT `process.exit` — let the event loop
 * drain stdout), and route CLI/unexpected errors to stderr as exit 2. A `CliError` is a clean
 * usage error (prints the message + USAGE); any other throw is an UNEXPECTED failure (secret-free
 * message only). All error output is drained before the process exits.
 *
 * Exported (IDX-EXIT2-1) so the CliError → exit-2 mapping is directly TESTABLE in-process: a test
 * drives `run([...])` and asserts `process.exitCode` (2 for a usage/CLI error, 0/1 for the ok/not-ok
 * spec paths) — covering the exit-2 branch that `main` only THROWS into. `args` defaults to the real
 * CLI vector so the production call site (`run()`) is unchanged.
 */
export async function run(args?: readonly string[]): Promise<void> {
  try {
    process.exitCode = args === undefined ? await main() : await main(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CliError) {
      await writeDrained(
        process.stderr,
        `${JSON.stringify({ ok: false, cliError: message })}\n${USAGE}\n`,
      );
    } else {
      // An UNEXPECTED failure (not a handled spec/plan error — those are returned as ok:false).
      await writeDrained(process.stderr, `${JSON.stringify({ ok: false, cliError: message })}\n`);
    }
    process.exitCode = 2;
  }
}

// Run ONLY when executed as the CLI entrypoint (not when imported by a test). `argv[1]` is the script
// path Node was launched with (possibly a symlinked bin); realpath both sides before comparing so a
// symlinked `rayspec` bin still runs, while importing `main` stays side-effect free (the test drives
// `main()` directly and asserts the returned exit code).
function isMainEntry(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  try {
    return realpathSync(here) === realpathSync(entry);
  } catch {
    return here === entry;
  }
}

if (isMainEntry()) {
  run();
}
