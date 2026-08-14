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
 *   1. loads a local `.env` (the boot secrets + any provider credentials the declared agents need)
 *      through the SHIPPED loader — the same two candidates in the same order as `rayspec deploy` and
 *      `rayspec-serve`: `$PWD/.env` first, then the install-root file, per key,
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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { AllowlistEntry } from '@rayspec/db';
import {
  applyServeAgentTracing,
  assembleOptsFromEnv,
  assembleServer,
  BootConfigError,
  BootTimeoutError,
  bootBanner,
  bootBaseUrl,
  loadLocalDotenvIfPresent,
  loadServerConfig,
  type PlannedMigration,
  resolveBootTimeoutMs,
  type ServerConfig,
  withBootTimeout,
} from '@rayspec/server';
import postgres from 'postgres';

/** Require an env var or fail closed with an actionable message. */
function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `[local-boot] required env var ${key} is not set. The boot secrets (RAYSPEC_API_KEY_PEPPER, ` +
        'RAYSPEC_JWT_SIGNING_KEY) and DATABASE_URL must be in a local .env — the invoking ' +
        'directory’s ./.env or the install-root one, both gitignored — or in the ambient ' +
        'environment. A provider credential is demanded per declared agent (not here).',
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

/** Postgres stores only the first `NAMEDATALEN - 1` bytes of an identifier; the rest is truncated. */
const MAX_IDENTIFIER_BYTES = 63;
/** The derived dev DB name's fixed prefix (14 bytes). */
const DEV_DB_PREFIX = 'rayspec_local_';
/** Hex characters of the spec-path digest appended to a name that had to be capped. */
const DIGEST_CHARS = 8;
/**
 * The companion database a durableWorker spec auto-creates beside the app database. The boot drops
 * `<devDbName>${DBOS_SYS_SUFFIX}` before creating `<devDbName>`, so a capped name must leave this
 * suffix room to survive Postgres's 63-byte truncation — at 63 bytes the two identifiers are equal
 * and that drop would name the app database instead of the companion.
 */
const DBOS_SYS_SUFFIX = '_dbos_sys';

/**
 * The throwaway dev DB name for a spec path, sanitized to a safe pg identifier.
 *
 * It is DERIVED from the spec file's directory so that concurrently-authored backends never collide on
 * one shared dev DB — each boots into its own, and a re-boot of the same backend lands on the same one.
 *
 * A spec inside a build-output directory is named after the BACKEND rather than the output directory.
 * The bundled build steps write `<backend>/dist/rayspec.yaml`, so reading the last segment alone would
 * give every built backend the single name `rayspec_local_dist` — reintroducing exactly the collision
 * this derivation exists to prevent, and silently, because the second boot would DROP and re-create the
 * first backend's database.
 *
 * LENGTH is the same collision by another route. Postgres truncates an identifier past 63 bytes, so two
 * names that differ only beyond that byte ARE one database — which, given the prefix and a sanitizer
 * that maps every character to one ASCII byte, is every pair of directory names 49 characters or longer
 * that agree that far. A name that does not fit is therefore CAPPED and disambiguated with a short
 * digest of the RESOLVED spec path, so the result is always ≤ 63 bytes and what keeps two capped
 * siblings apart is that digest rather than how much of their directory names happens to fit. A name
 * that already fits is returned UNCHANGED — an existing backend keeps the database it has been
 * booting into. (The one name that does change is a spec at a filesystem root, which used to derive
 * the empty-segment `rayspec_local_`; that name was shared by every such spec, so there was no single
 * backend's database to keep.)
 *
 * The cap also reserves room for `DBOS_SYS_SUFFIX`. The boot drops `<name>_dbos_sys` immediately
 * before creating `<name>`, so that a fresh-empty app database never pairs with stale DBOS workflow
 * state. Truncation makes those two identifiers EQUAL at exactly 63 bytes, which is the length a cap
 * that only respected `MAX_IDENTIFIER_BYTES` would produce every time — the drop would then name the
 * app database, already dropped one statement earlier, and the stale companion would survive. Capping
 * `MAX_IDENTIFIER_BYTES - DBOS_SYS_SUFFIX.length` bytes short keeps both identifiers whole and
 * distinct. A name that already FITS but is longer than that stays as it is and keeps the aliasing:
 * changing it would orphan the database that backend has been booting into, which is the cost this
 * derivation exists to avoid.
 *
 * What that buys is a BOUND, not a guarantee of distinctness, and the wrapper does not claim one.
 * `DIGEST_CHARS` hex characters are 32 bits, so two capped names still collide when their spec paths'
 * digests do (~1 in 2^32 per pair). A capped name is also itself a legal 49-character directory name,
 * so a directory named exactly like one derives the same database through the unchanged branch. Both are
 * accepted deliberately: this names a THROWAWAY dev database, and the failure the cap closes — every
 * sufficiently-long sibling pair colliding, by construction — is the one that actually happens.
 *
 * A spec at a filesystem root has an EMPTY directory segment (`resolve('/rayspec.yaml').split('/')` is
 * `['', 'rayspec.yaml']`), so the fallback tests the segment for emptiness rather than only for
 * `undefined` — otherwise every such spec shares the one name `rayspec_local_`.
 *
 * Exported so a test can pin the derivation without booting anything.
 */
export function devDatabaseName(specPath: string): string {
  const resolved = resolve(specPath);
  const segments = resolved.split('/');
  const dir = segments.slice(-2, -1)[0] || 'spec';
  const named = dir === 'dist' ? `${segments.slice(-3, -2)[0] || 'spec'}_dist` : dir;
  // Every surviving character is one ASCII byte, so the sanitized length IS the byte length.
  const sanitized = named.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const full = `${DEV_DB_PREFIX}${sanitized}`;
  if (full.length <= MAX_IDENTIFIER_BYTES) return full;
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, DIGEST_CHARS);
  const cap =
    MAX_IDENTIFIER_BYTES - DBOS_SYS_SUFFIX.length - DEV_DB_PREFIX.length - 1 - DIGEST_CHARS;
  return `${DEV_DB_PREFIX}${sanitized.slice(0, cap)}_${digest}`;
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
    // At exactly 63 bytes — the bound `devDatabaseName` caps to — Postgres truncates this name back
    // onto the app DB's own. That is inert here: the app DB was dropped by the statement above, so
    // this one finds nothing, and no separate system DB can exist under that name to be left behind.
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
  // The SHIPPED loader (@rayspec/server), not a private copy: this wrapper resolves its local `.env`
  // through the same two candidates in the same order as `rayspec deploy` and `rayspec-serve` —
  // `$PWD/.env` first, the install-root file second, per key, never overriding a set variable — and
  // honours `RAYSPEC_SKIP_DOTENV=1` like both of them. A wrapper-local parser is what let the two
  // documented entrypoints resolve different files from one checkout (issue #384).
  loadLocalDotenvIfPresent();

  // Consult RAYSPEC_AGENT_TRACING right after the `.env` load — so a value that file states counts —
  // and ahead of every boot input below, so no shape of this wrapper can ignore a stated intention
  // while its banner reports the posture. EXPLICIT-ONLY: unset or blank leaves the agent SDK's own
  // default (which exports) untouched, `off` disables the export through the SDK's programmatic switch
  // (the static import above has already built its trace provider, so an environment write alone would
  // arrive too late), and an unsupported value aborts with the message the documented entrypoints use.
  await applyServeAgentTracing();

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

  // An explicit RAYSPEC_DEV_DB overrides the derivation. Update mode reuses the SAME derivation so it
  // lands on the backend's existing dev DB.
  const devDbName = process.env.RAYSPEC_DEV_DB || devDatabaseName(specPath);

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
    if (err instanceof BootTimeoutError || err instanceof BootConfigError) {
      // A boot timeout and a refused boot configuration are operator-actionable diagnostics (see
      // @rayspec/server boot-timeout / agent-tracing) — print the message only, no stack. Anything else
      // is genuinely unexpected: keep the full stack.
      console.error(`[local-boot] ${err.message}`);
    } else {
      console.error('[local-boot] boot failed:', err instanceof Error ? err.stack : err);
    }
    process.exit(1);
  });
}
