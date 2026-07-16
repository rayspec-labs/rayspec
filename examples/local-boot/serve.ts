/**
 * DEV-ONLY generic, spec-driven local backend-boot wrapper.
 *
 * NOTE: the SHIPPED entrypoint (`@rayspec/server` `rayspec-serve`) now boots a backend-profile spec
 * WITH agents DIRECTLY — it builds each declared agent's backend from the ambient env, so a wrapper is
 * no longer REQUIRED to run an agent spec. This wrapper remains purely a DEV CONVENIENCE: it provisions
 * a FRESH throwaway dev DATABASE (DROP+CREATE) so the committed migration chain bootstraps it clean, and
 * it adds the `RAYSPEC_BOOT_UPDATE` redeploy/update flow. Its behavior below is otherwise unchanged.
 *
 * This is a thin wrapper over the REAL `@rayspec/server` composition root, PARAMETERIZED by
 * `RAYSPEC_SPEC_PATH` so it can boot ANY declarative spec (stores + CRUD api + agents +
 * tool-handler-backed agents) with NO product knowledge baked in. It:
 *   1. loads repo-root `.env` (the boot secrets + any provider credentials the declared agents need)
 *      — no dotenv dep,
 *   2. provisions a FRESH dev DATABASE (DROP+CREATE) so the committed migration chain bootstraps it
 *      CLEAN — never the stale hand-provisioned `public`,
 *   3. injects RAYSPEC_SPEC_PATH (the spec .yaml) so `assembleServer` runs the REAL `deploy()`
 *      pipeline for the declared stores + routes + agents, and
 *   4. builds the deployer-seam opts via the SHIPPED `assembleOptsFromEnv` (the SAME builder the
 *      `rayspec-serve` bin and the `rayspec deploy` CLI use): it registers the built product-table
 *      instances in the deny-by-default Set (a REAL deployment ships a committed generated
 *      product-schema.ts; this dev wrapper stands in for that committed tuple) AND wires each DECLARED
 *      agent's backend from the ambient env — demanding a provider credential ONLY when the spec
 *      declares an agent that needs it (an agent-free spec, e.g. a stores/api-only or Product-YAML
 *      doc, needs none and boots without one).
 * Then it serves with the loud LOCAL/pre-hardening banner.
 *
 * NOT production. LOCAL / internal-only; the external-exposure hardening layer (RLS/KMS/per-tenant
 * sandbox/DPoP) gates untrusted traffic and is NOT built. Lives OUTSIDE packages/ so the platform
 * stays product-free.
 *
 * TWO MODES:
 *   • FIRST-DEPLOY (default) — DROP+CREATE a fresh dev DB, run the FIRST materialization.
 *   • UPDATE (`RAYSPEC_BOOT_UPDATE=1`) — the redeploy/update flow. Boots against the EXISTING dev DB
 *     (NO DROP — existing rows survive) and hands `deploy()` a reviewed forward DELTA migration
 *     (`RAYSPEC_UPDATE_MIGRATION` = the delta `.sql`; `RAYSPEC_UPDATE_ALLOWLIST` = the reviewed
 *     allowlist JSON, optional) through the exported `DeployConfig.migrations`/`PlannedMigration`
 *     seam. `deploy()` GATES the delta (a destructive statement WITHOUT a covering allowlist entry
 *     BLOCKS with a `DeployError` at [lint/gate], never a silent apply) then applies it — evolving
 *     the schema in place. A drifted-refuse-boot is bypassed for a reviewed update (a legitimate
 *     update reconciles a schema intentionally drifted vs the NEW spec).
 *
 * Run (from the repo root):
 *   pnpm db:up                                                   # Docker Postgres on :5433
 *   # FIRST DEPLOY (fresh dev DB):
 *   RAYSPEC_SPEC_PATH=<abs path to the spec .yaml> \
 *     pnpm --filter @rayspec/local-boot serve                   # boot the declared backend
 *   BASE=http://127.0.0.1:8788 bash <path to the backend's own smoke test>.sh
 *   # UPDATE (redeploy onto the SAME dev DB):
 *   RAYSPEC_BOOT_UPDATE=1 \
 *   RAYSPEC_SPEC_PATH=<abs path to the NEW spec .yaml> \
 *   RAYSPEC_UPDATE_MIGRATION=<abs path to the delta 0001_*.sql> \
 *   [RAYSPEC_UPDATE_ALLOWLIST=<abs path to the reviewed allowlist.json>] \
 *     pnpm --filter @rayspec/local-boot serve
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { AllowlistEntry } from '@rayspec/db';
import {
  assembleOptsFromEnv,
  assembleServer,
  bootBanner,
  bootBaseUrl,
  loadServerConfig,
  type PlannedMigration,
  resolveBootTimeoutMs,
  type ServerConfig,
  withBootTimeout,
} from '@rayspec/server';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');

/**
 * Minimal `.env` loader (no dotenv dependency — keep the dev harness dep-light). Parses `KEY=VALUE`
 * lines, ignores comments/blank lines, supports a single optional pair of surrounding quotes, and
 * unescapes a literal `\n` (the repo's `.env` stores the PEM on one line). Does NOT override an
 * already-set process.env var (an explicit shell override wins) — so a `RAYSPEC_SPEC_PATH=… pnpm …`
 * invocation's spec path is never clobbered by `.env`.
 */
function loadEnv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.warn(`[local-boot] no .env at ${path} — relying on the ambient environment.`);
    return;
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    process.env[key] = value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
  }
}

/** Require an env var or fail closed with an actionable message. */
function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `[local-boot] required env var ${key} is not set. The boot secrets (RAYSPEC_API_KEY_PEPPER, ` +
        'RAYSPEC_JWT_SIGNING_KEY) and DATABASE_URL must be in repo-root .env (gitignored) or the ' +
        'ambient environment. A provider credential is demanded per declared agent (not here).',
    );
  }
  return v;
}

/** The update-mode env inputs. Read by `readUpdateMigrations` + the update `main()` branch. */
export interface UpdateMigrationEnv {
  /** RAYSPEC_UPDATE_MIGRATION — the delta `.sql` file (REQUIRED in update mode). */
  readonly migrationPath?: string;
  /** RAYSPEC_UPDATE_ALLOWLIST — the reviewed destructive-statement allowlist JSON (OPTIONAL; absent ⇒ []). */
  readonly allowlistPath?: string;
}

/**
 * Parse + fail-closed shape-validate a reviewed allowlist JSON file into `AllowlistEntry[]`. An absent
 * path ⇒ `[]` (a purely-additive delta needs none). A malformed file THROWS — never a silently-empty
 * allowlist. (`deploy()`'s gate is the ULTIMATE fail-closed authority regardless: a destructive
 * statement with no MATCHING entry BLOCKS with a `DeployError` at [lint/gate], however the allowlist
 * was shaped — a wrong `match` re-blocks, exactly like the byte-fidelity contract guarantees.)
 */
function readReviewedAllowlist(allowlistPath: string | undefined): AllowlistEntry[] {
  const path = allowlistPath?.trim();
  if (!path) return [];
  const resolved = resolve(path);
  let text: string;
  try {
    text = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(
      `[local-boot] RAYSPEC_UPDATE_ALLOWLIST points at an unreadable file: ${resolved}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `[local-boot] RAYSPEC_UPDATE_ALLOWLIST is not valid JSON (${resolved}): ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(data)) {
    throw new Error(
      `[local-boot] RAYSPEC_UPDATE_ALLOWLIST must be a JSON array of { kind, match, reason } ` +
        `entries (${resolved}).`,
    );
  }
  return data.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`[local-boot] RAYSPEC_UPDATE_ALLOWLIST entry [${i}] must be an object.`);
    }
    const { kind, match, reason } = raw as Record<string, unknown>;
    if (typeof kind !== 'string' || kind.length === 0)
      throw new Error(`[local-boot] RAYSPEC_UPDATE_ALLOWLIST entry [${i}].kind must be non-empty.`);
    if (typeof match !== 'string' || match.length === 0)
      throw new Error(
        `[local-boot] RAYSPEC_UPDATE_ALLOWLIST entry [${i}].match must be non-empty.`,
      );
    if (typeof reason !== 'string' || reason.length === 0)
      throw new Error(
        `[local-boot] RAYSPEC_UPDATE_ALLOWLIST entry [${i}].reason must be non-empty.`,
      );
    return { kind: kind as AllowlistEntry['kind'], match, reason };
  });
}

/**
 * Build the reviewed forward-DELTA migration(s) for the wrapper's UPDATE mode from the env inputs. The
 * delta `.sql` path is REQUIRED; the reviewed allowlist is optional (absent ⇒ empty — a purely-additive
 * delta). Returns exactly ONE `PlannedMigration` (the versioned delta authored via `rayspec plan
 * <new> --against <old>`, keyed by its filename) to hand to `deploy()` through `assembleServer`'s
 * `updateMigrations` seam. FAIL-CLOSED on a missing/unreadable delta or a malformed allowlist.
 */
export function readUpdateMigrations(env: UpdateMigrationEnv): PlannedMigration[] {
  const migrationPath = env.migrationPath?.trim();
  if (!migrationPath) {
    throw new Error(
      '[local-boot] update mode (RAYSPEC_BOOT_UPDATE=1) requires RAYSPEC_UPDATE_MIGRATION — the ' +
        'path to the reviewed delta .sql authored via `rayspec plan <new> --against <old>`.',
    );
  }
  const resolved = resolve(migrationPath);
  let sql: string;
  try {
    sql = readFileSync(resolved, 'utf8');
  } catch {
    throw new Error(
      `[local-boot] RAYSPEC_UPDATE_MIGRATION points at an unreadable file: ${resolved}`,
    );
  }
  const allowlist = readReviewedAllowlist(env.allowlistPath);
  return [{ name: basename(resolved), sql, allowlist }];
}

/**
 * Build the `assembleServer` opts for the wrapper's boot: the deployer-seam opts derived from the
 * ambient env + the parsed spec via the SHIPPED `assembleOptsFromEnv` (the SAME builder the
 * `rayspec-serve` bin and the `rayspec deploy` CLI use), plus the wrapper's UPDATE-mode
 * `updateMigrations` seam when present.
 *
 * `assembleOptsFromEnv` registers the built product tables (harmless when the spec declares none) and
 * returns an `agentBackendsFactory` ONLY when the spec declares ≥1 agent — building it fail-closes on
 * that backend's missing per-agent env. So this demands a provider credential ONLY for a spec that
 * declares an agent needing one; an agent-free spec (a stores/api-only backend, or a Product-YAML
 * doc) needs none, and the update boot of an agent-free spec no longer fails closed on an unused
 * provider key. Exported so a test can drive this exact opts-building deterministically (no DB, no listen).
 */
export function buildAssembleOpts(
  config: ServerConfig,
  updateMigrations?: PlannedMigration[],
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof assembleOptsFromEnv> & { updateMigrations?: PlannedMigration[] } {
  return {
    ...assembleOptsFromEnv(config, env),
    ...(updateMigrations ? { updateMigrations } : {}),
  };
}

/**
 * UPDATE-mode fail-closed pre-check: the update path redeploys onto an EXISTING dev DB (NO
 * DROP+CREATE). If that DB was never deployed (absent), `assembleServer` would otherwise blow up with a
 * raw postgres `database "…" does not exist` (SQLSTATE 3D000) deep in the migrator. Probe `pg_database`
 * up front (read-only admin `/postgres` connection — creates nothing) and throw an ACTIONABLE message
 * instead. Does NOT weaken fail-closed: an absent DB still aborts the boot; this only improves the error.
 */
async function assertDevDatabaseExists(baseUrl: string, devDbName: string): Promise<void> {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${devDbName}`;
    if (rows.length === 0) {
      throw new Error(
        `[local-boot] update mode (RAYSPEC_BOOT_UPDATE=1) needs an EXISTING deployed dev database, ` +
          `but '${devDbName}' does not exist. An update redeploys onto the backend's existing dev DB ` +
          'IN PLACE (it never creates one) — run a FIRST deploy (without RAYSPEC_BOOT_UPDATE) to ' +
          'materialize the backend and seed data before updating it. Fail-closed.',
      );
    }
  } finally {
    await admin.end();
  }
}

/**
 * Provision a FRESH dedicated dev DATABASE (DROP+CREATE — idempotent across re-runs) so the committed
 * migration chain (applied by assembleServer) bootstraps it CLEAN. NEVER the stale, hand-provisioned
 * `public` of the base DB. Returns the dev DB's connection URL.
 */
async function provisionDevDatabase(baseUrl: string, devDbName: string): Promise<string> {
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  try {
    console.log(`[local-boot] provisioning fresh dev database '${devDbName}' (DROP+CREATE)…`);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${devDbName}" WITH (FORCE)`);
    // Also drop the derived DBOS system DB so a fresh-empty app DB never pairs with a stale
    // `<devDbName>_dbos_sys` (orphaned workflow/queue state) auto-created by a durableWorker spec.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${devDbName}_dbos_sys" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${devDbName}"`);
  } finally {
    await admin.end();
  }
  const devUrl = new URL(baseUrl);
  devUrl.pathname = `/${devDbName}`;
  return devUrl.toString();
}

async function main(): Promise<void> {
  // Progress line BEFORE the (potentially slow) dev-DB provisioning + assemble step, so a hang is never
  // silent — the banner below prints only once the whole boot succeeds.
  console.log(
    '[local-boot] booting — provisioning the dev database, connecting, applying migrations…',
  );
  loadEnv(resolve(REPO_ROOT, '.env'));

  const baseUrl = requireEnv('DATABASE_URL');
  requireEnv('RAYSPEC_API_KEY_PEPPER');
  requireEnv('RAYSPEC_JWT_SIGNING_KEY');

  // The spec path is the ONE product input — supplied by the deployer (the platform ships none). It
  // must be set BEFORE this point (RAYSPEC_SPEC_PATH=… pnpm …); fail closed with an actionable msg.
  const specPath = process.env.RAYSPEC_SPEC_PATH?.trim();
  if (!specPath) {
    throw new Error(
      '[local-boot] RAYSPEC_SPEC_PATH is not set. This wrapper is spec-driven — point it at the ' +
        'spec .yaml, e.g.\n  RAYSPEC_SPEC_PATH=/abs/path/to/spec.yaml ' +
        'pnpm --filter @rayspec/local-boot serve',
    );
  }

  // UPDATE mode: RAYSPEC_BOOT_UPDATE=1 redeploys onto the EXISTING dev DB (NO DROP — existing rows
  // survive) with a reviewed forward delta. First-deploy mode (default) is unchanged.
  const isUpdate = ['1', 'true', 'yes'].includes(
    (process.env.RAYSPEC_BOOT_UPDATE ?? '').trim().toLowerCase(),
  );

  // A dev DB name DERIVED from the spec file's directory name keeps concurrently-authored backends from
  // colliding on one shared dev DB (each backend boots into its own fresh throwaway DB). The name is
  // sanitized to a safe pg identifier; an explicit RAYSPEC_DEV_DB overrides. Update mode reuses the
  // SAME derivation so it lands on the backend's existing dev DB.
  const specDirName = resolve(specPath).split('/').slice(-2, -1)[0] ?? 'spec';
  const derivedDbName = `rayspec_local_${specDirName.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const devDbName = process.env.RAYSPEC_DEV_DB || derivedDbName;

  // 1. Dev DATABASE. FIRST-DEPLOY: DROP+CREATE fresh → the migration chain bootstraps it clean.
  //    UPDATE: point at the EXISTING dev DB (NO DROP) so the seeded data survives the redeploy — the
  //    reviewed delta (below) evolves the live schema in place. Point DATABASE_URL at the chosen DB.
  const devUrl = isUpdate
    ? await (async () => {
        // UPDATE mode redeploys onto the EXISTING dev DB (no DROP). Fail closed with an actionable
        // message if the backend was never first-deployed (absent DB), instead of a raw postgres
        // 3D000 surfacing deep in assembleServer's migrator.
        await assertDevDatabaseExists(baseUrl, devDbName);
        const u = new URL(baseUrl);
        u.pathname = `/${devDbName}`;
        return u.toString();
      })()
    : await provisionDevDatabase(baseUrl, devDbName);
  process.env.DATABASE_URL = devUrl;
  process.env.PORT = process.env.PORT || '8788';
  // Dev-local SPA origins (cookie-CSRF only matters for cookie auth, which the curl smoke does not use).
  process.env.ALLOWED_ORIGINS =
    process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000';

  // 2. The injected spec path is already in RAYSPEC_SPEC_PATH; loadServerConfig reads it. The handler
  //    root defaults to the spec's directory (used only when the spec declares escape-hatch handlers);
  //    set it explicitly for clarity/parity with the platform.
  process.env.RAYSPEC_HANDLER_ROOT = process.env.RAYSPEC_HANDLER_ROOT || dirname(resolve(specPath));

  // 2b. UPDATE mode: build the reviewed forward-DELTA migration(s) from the env inputs (fail-closed on a
  //     missing/unreadable delta or malformed allowlist). deploy() GATES + applies them (below).
  const updateMigrations = isUpdate
    ? readUpdateMigrations({
        migrationPath: process.env.RAYSPEC_UPDATE_MIGRATION,
        allowlistPath: process.env.RAYSPEC_UPDATE_ALLOWLIST,
      })
    : undefined;

  // 3. Build the deployer-seam opts through the SHIPPED `assembleOptsFromEnv` (the SAME builder the
  //    `rayspec-serve` bin and the `rayspec deploy` CLI use), plus the wrapper's UPDATE-mode
  //    `updateMigrations` seam. `assembleOptsFromEnv` registers the built product tables via the
  //    SANCTIONED validating registrar (@rayspec/db/composition — which VALIDATES every table:
  //    tenant_id column / shape / FK → orgs — before it joins the deny-by-default chokepoint Set;
  //    a real deployment commits a generated product-schema.ts, this dev wrapper stands in for that
  //    committed tuple) AND returns an agent-backends factory built from the ambient env ONLY when the
  //    spec declares ≥1 agent (fail-closed on that backend's missing per-agent credential). An
  //    agent-free spec (a stores/api-only backend, or a Product-YAML doc) needs no provider key.
  //
  // Assemble the REAL composition root (applies the migration chain → runs deploy() for the spec). In
  // UPDATE mode, updateMigrations is threaded into deploy()'s DeployConfig.migrations seam (gated +
  // applied); deploy() throws a DeployError at [lint/gate] if the delta carries an unreviewed
  // destructive statement, which propagates here and aborts the boot (never a silent apply).
  const config = loadServerConfig();
  // Guard the assemble step (migration chain → product boot) with a boot timeout so a hung boot is
  // diagnosed rather than silent; the happy path is unchanged (a normal boot clears the timer well
  // under it). Overridable via RAYSPEC_BOOT_TIMEOUT_MS.
  const server = await withBootTimeout(
    assembleServer(config, buildAssembleOpts(config, updateMigrations)),
    resolveBootTimeoutMs(),
  );

  const httpServer = serve(
    { fetch: server.app.fetch, hostname: config.host, port: config.port },
    (info) => {
      // Log the ACTUAL bound address (info.address), never a hard-coded loopback — a non-loopback
      // RAYSPEC_HOST bind must be visible in the banner rather than masked behind a false 127.0.0.1.
      const base = bootBaseUrl(info.address, info.port);
      console.log(bootBanner(server, base));
      console.log(`  Spec:         ${resolve(specPath)}`);
      console.log(
        `  Dev database: ${devDbName}   ` +
          (isUpdate
            ? '(EXISTING — reviewed delta applied in place; data preserved)'
            : '(fresh; migration-chain bootstrapped; NOT public)'),
      );
      console.log(`  Now smoke it: BASE=${base} bash <path to the backend's own smoke test>.sh\n`);
    },
  );

  // Graceful shutdown: stop accepting connections + drain the server's pools so a Ctrl-C releases
  // everything cleanly.
  const shutdown = (signal: string): void => {
    console.log(`\n[local-boot] ${signal} received — shutting down…`);
    httpServer.close(async () => {
      await server.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only boot when run as the process entrypoint (`pnpm --filter @rayspec/local-boot serve`). When this
// module is IMPORTED (e.g. by a test to exercise `readUpdateMigrations`), do NOT boot.
const isEntrypoint =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((err) => {
    console.error('[local-boot] boot failed:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
