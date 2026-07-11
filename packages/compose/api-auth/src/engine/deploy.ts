/**
 * The GitOps DEPLOY command — one flow wiring the full deploy pipeline.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PIPELINE (fixed order — abort-on-fail at EVERY step).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *   1. VALIDATE   — `parseSpec` (YAML → strict Zod → `lintSpec`). A `!ok` ABORTS (the full
 *                   SpecError list is surfaced; nothing else runs). A Product-YAML doc
 *                   validates via `parseProductSpec`, then its runtime is COMPOSED from the
 *                   deployer-supplied `rollout.productYaml` (@rayspec/product-yaml) and the
 *                   composed engine spec flows through the SAME steps 2–6 below.
 *   2. DIFF       — `generateProductSql(spec.stores)` produces the deterministic, REVIEWABLE
 *                   migration SQL (the committed/generated SQL is the artifact, never blind
 *                   `drizzle-kit generate`). The deployer reviews THIS SQL; a `drizzle-kit generate`
 *                   cross-check is AVAILABLE but advisory — the generated SQL is canonical. The
 *                   deployer passes the migration(s) it intends to apply (so a destructive
 *                   forward-fix migration the deployer authored is gated too, not just the additive
 *                   first materialization).
 *   3. LINT/GATE  — `scanMigrationSql` (the home-grown destructive policy) over EACH migration with
 *                   its reviewed allowlist. A destructive statement WITHOUT a reviewed allowlist
 *                   entry BLOCKS the deploy (abort) — never a silent apply.
 *   4. MIGRATE    — apply each migration to the target DB via the injected `applyMigration` seam,
 *                   ABORT-ON-FAIL (a failed apply aborts — no partial roll-out; the next step never
 *                   runs). [Rollback is FORWARD-FIX only — see the rollback note below.]
 *   5. ROLL OUT   — VERIFY each product table is admitted by the real TenantDb chokepoint (the A1
 *                   precondition — see below), load handlers (path-jailed, fail-closed), register
 *                   triggers (parse/register only), and build the app via the
 *                   deployer-supplied `buildApp` callback (the platform stays PRODUCT-FREE: the
 *                   deployment owns AppDeps assembly).
 *   6. DRIFT      — `detectDrift` introspects the LIVE DB and compares the load-bearing facts; it is
 *                   REPORT-ONLY (never auto-heals; reconciliation goes back through the full
 *                   gate as a reviewed forward migration). Drift is reported, NOT a deploy failure.
 *
 * HONESTY NOTES (so a future maintainer is not misled about what is / is NOT a gate):
 *  • The DIFF step does NOT enforce `migrations[]` ↔ `generateProductSql(spec.stores)` EQUIVALENCE. A
 *    divergent or even EMPTY `migrations[]` only surfaces (post-migrate) as REPORT-ONLY drift — it is
 *    never a deploy abort (by design; recovery is a reviewed forward migration). DIFF is the
 *    review artifact, not a gate.
 *  • The DROP-COLUMN allowlist (LINT/GATE) matches on the EXACT whitespace-collapsed applied-migration
 *    statement text (MIG-3). A schema-qualifier or different quoting on the live statement re-BLOCKS it
 *    (fail-closed by design) — the allowlist entry must be byte-faithful to the statement deploy runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TENANT-TABLE REGISTRATION = A COMMITTED-SOURCE PRECONDITION (A1 / ZPC-3 — PM call, constraint-
 * dictated). deploy() VERIFIES, never mutates the deny-by-default Set.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Correction A1 (binding): a product table is registered in `TENANT_SCOPED_TABLES` ONLY as COMMITTED
 * SOURCE — the codegen emits `generated/product-schema.ts`, which composes the table into the
 * tuple, and that file is COMMITTED before deploy. A runtime append to the Set was REJECTED as
 * type-infeasible (the tuple is a literal member type) AND as a security hole (the deny-by-default Set
 * mutator `registerScopedTables` is deliberately gate/test-only — ZPC-3 — and FORBIDDEN in shipped
 * scoped roots by the Biome ban + `gate:chokepoint`). So a `stores` change is an honest CODEGEN →
 * COMMIT → MIGRATE round-trip, not a hot reload — the cost A1 documents.
 *
 * Therefore deploy() treats "each declared store's table is in `TENANT_SCOPED_TABLES`" as a
 * deployment PRECONDITION and FAIL-CLOSED VERIFIES it: for each declared store it asks the deployer's
 * `verifyTenantScoped` seam to probe the REAL chokepoint (a `TenantDb.select(table)` admission check
 * that throws deny-by-default if the table is not registered). A store whose table is NOT registered
 * ABORTS the deploy with an actionable error (run the codegen + commit the generated product-schema,
 * then redeploy) — deploy() NEVER registers the table itself. (The acceptance TEST simulates the
 * committed tuple by registering the throwaway tables via the test seam BEFORE driving deploy().)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ROLLBACK / RECOVERY — FORWARD-FIX ONLY.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * There are NO down-migrations anywhere in RaySpec. `abort-on-fail` (step 4) covers ONLY a
 * migration that FAILS TO APPLY (the transaction rolls back; nothing is half-applied). It does NOT
 * cover a migration that APPLIES cleanly but is wrong (drops a still-needed column, corrupts data).
 * Recovery from a bad-but-applied migration is a NEW reviewed FORWARD migration that goes through
 * THIS SAME pipeline (validate → diff → lint/gate → migrate → roll out → drift). Expand-contract
 * (additive → backfill → drop in a later reviewed migration) is the authoring DISCIPLINE that keeps
 * a destructive change reversible across two deploys; no new tooling implements it. Backup/PITR is
 * deferred. This is stated here so a future maintainer is not misled.
 *
 * PRODUCT-AGNOSTIC: every step derives from the validated spec + the deployer-supplied seams. No
 * product table, route, handler, or name lives in this module — the throwaway is the TEST SUBJECT.
 */
import type { Backend, BackendId } from '@rayspec/core';
import {
  type AllowlistEntry,
  type DriftFinding,
  detectDrift,
  formatFindings,
  generateProductSql,
  scanMigrationSql,
} from '@rayspec/db';
import {
  loadHandlers,
  type ModuleImporter,
  type ResolvedHandler,
  registerTriggers,
  type TriggerRegistry,
} from '@rayspec/platform';
// The Product-YAML deploy composition. deploy() stays a thin mapping — every decision about
// WHAT the Product-YAML runtime supports (and every fail-closed unsupported-section rejection) lives
// in @rayspec/product-yaml's composeProductDeploy, reviewable outside this core module.
import {
  type ComposedProductDeploy,
  composeProductDeploy,
  ProductComposeError,
  type ProductYamlRollout,
} from '@rayspec/product-yaml';
import {
  detectSpecKind,
  type RaySpec,
  parseProductSpec,
  parseSpec,
  type SpecError,
} from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DeclarativeEngine } from '../app-context.js';

/** A reviewed migration the deployer intends to apply (the committed SQL artifact + its allowlist). */
export interface PlannedMigration {
  /** The migration's basename (for logging + allowlist keying). */
  readonly name: string;
  /** The migration SQL (the committed artifact — reviewed; read-not-blind). */
  readonly sql: string;
  /** The reviewed destructive-statement allowlist for THIS migration (empty for a purely-additive one). */
  readonly allowlist?: AllowlistEntry[];
}

/**
 * The DB-side capability seam the deploy needs. Injected so the platform code never names `public`
 * (or any concrete client) and the throwaway test can drive the SAME flow against an isolated schema
 * / a throwaway DB. The deployer owns the connection; deploy() only orchestrates.
 */
export interface DeployTarget {
  /**
   * Apply ONE migration's SQL to the target DB, ALL-OR-NOTHING (the deployer wraps it in a
   * transaction). Rejects (throws) on a failed apply → deploy() aborts (no partial roll-out).
   */
  applyMigration(migration: PlannedMigration): Promise<void>;
  /**
   * FAIL-CLOSED VERIFY that `table` (a built product table for a declared store) is admitted by the
   * REAL TenantDb chokepoint — i.e. it is registered in `TENANT_SCOPED_TABLES` (the committed A1
   * tuple). The deployer implements this by probing the real chokepoint (e.g.
   * `forTenant(db, anyTenant).select(table)`, which runs `assertScoped` and THROWS deny-by-default if
   * the table is not registered). deploy() NEVER mutates the Set — it only asks this to throw on a
   * missing registration so the deploy aborts with an actionable error. `storeName` is for the message.
   */
  verifyTenantScoped(table: PgTable, storeName: string): void;
  /**
   * Run parameterized introspection SQL against the LIVE DB (the `detectDrift` query thunk). Used
   * only by the report-only drift step.
   */
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  /**
   * The Postgres schema `detectDrift` introspects (`information_schema` filtered by `table_schema`).
   * A test passes its isolated schema; a real deploy passes `public`. Default `public`.
   */
  readonly driftSchema?: string;
}

/** The roll-out inputs the deployer supplies (the platform ships none — zero-product-code). */
export interface RolloutConfig {
  /**
   * The CANONICAL product tables — the SAME `PgTable` instances the deployment's committed
   * `generated/product-schema.ts` composed into `TENANT_SCOPED_TABLES` (A1). deploy() VERIFIES each
   * is admitted by the chokepoint (deny-by-default rejects a non-tuple instance) and threads THESE
   * into the engine. They MUST be the registered instances — the chokepoint Set is keyed by object
   * identity, so a freshly-built table (a different object) would not be admitted. Declared store
   * name → its committed `PgTable`. A store with no entry here aborts the deploy (fail-closed). A
   * stores-free spec passes an empty map.
   */
  readonly productTables: ReadonlyMap<string, PgTable>;
  /** The path-jailed escape-hatch root all `handlers[].module` paths resolve within. */
  readonly escapeHatchRoot: string;
  /** Optional module importer (default: the real path-jailed dynamic import; a test injects a fake). */
  readonly importer?: ModuleImporter;
  /** Backend INSTANCE per BackendId for declared agents (the deployment wires the adapter instances). */
  readonly agentBackends?: ReadonlyMap<BackendId, Backend>;
  /**
   * The Product-YAML rollout — what a deployment supplies to MOUNT a Product-YAML document
   * (deployment tenant, durable workflow enqueuer, STT adapter, agent extraction executors, Tier-A
   * store bindings). Deploying a Product-YAML doc WITHOUT this stays the fail-closed
   * `unsupported_spec` rejection (validation via doctor/plan needs none of it).
   */
  readonly productYaml?: ProductYamlRollout;
  /**
   * Build the running app from the assembled `DeclarativeEngine`. The deployer owns AppDeps assembly
   * (stores/services/secrets) so the platform stays product-free; deploy() hands it the engine it
   * built (spec + product tables + handlers + backends) and the deployer returns the app object.
   * `App` is generic so the deployer is not forced to import the api-auth app type here.
   */
  buildApp<App>(engine: DeclarativeEngine): App;
}

/** A per-migration gate result (surfaced even on success so the deploy log shows what was scanned). */
export interface MigrationGateResult {
  readonly name: string;
  /** True iff every destructive finding had a reviewed allowlist entry (safe to apply). */
  readonly pass: boolean;
  /** A human-readable one-line-per-finding summary (for the deploy log). */
  readonly summary: string;
}

/** The outcome of a successful deploy (deploy() throws on any abort, so a return = success). */
export interface DeployResult<App = unknown> {
  /** The validated spec that was deployed. */
  readonly spec: RaySpec;
  /** The deterministic, reviewable product-store migration SQL the DIFF step generated. */
  readonly generatedStoreSql: string;
  /** Per-migration gate results (every planned migration passed, or the deploy aborted). */
  readonly gateResults: MigrationGateResult[];
  /** Declared store name → runtime PgTable (built + chokepoint-verified, NOT registered by deploy). */
  readonly productTables: ReadonlyMap<string, PgTable>;
  /** Boot-loaded handler id → resolved fn + kind (path-jailed). */
  readonly handlers: ReadonlyMap<string, ResolvedHandler>;
  /** The registered triggers (parse/register only — a fire is fail-closed-rejected). */
  readonly triggers: TriggerRegistry;
  /** The running app the deployer's `buildApp` produced (engine wired). */
  readonly app: App;
  /** The report-only drift findings (empty = the live schema matches the spec). */
  readonly drift: DriftFinding[];
  /**
   * Present iff the deployed spec was a Product-YAML document — the composed product runtime
   * (compiled workflows + the tenant-bound node-registry builder the deployment's workflow resolver
   * binds, trigger events, view routes). Absent for a RaySpec deploy.
   */
  readonly product?: ComposedProductDeploy;
}

/**
 * Thrown on any abort-on-fail step. `step` names which pipeline step failed (for the deploy log).
 *  - `unsupported_spec` — the spec is a VALID Product-YAML document, but it
 *    is not MOUNTABLE as configured: either the deploy supplies no `rollout.productYaml` (validation
 *    stays doctor/plan's job), or the document declares a section/policy/operation the composition
 *    has no runtime for (composeProductDeploy's fail-closed rejection, section named) — never a
 *    silent skip, never an inert mount. (An INVALID Product-YAML doc aborts at `validate` with its
 *    full SpecError list, like an invalid RaySpec.)
 */
export class DeployError extends Error {
  constructor(
    readonly step: 'validate' | 'unsupported_spec' | 'lint/gate' | 'migrate' | 'roll out',
    message: string,
    readonly details?: SpecError[] | MigrationGateResult[],
  ) {
    super(`deploy aborted at [${step}]: ${message}`);
    this.name = 'DeployError';
  }
}

/** The deploy inputs. `specSource` is the raw YAML text (validated by step 1). */
export interface DeployConfig {
  /** The raw `rayspec.yaml` text — validated (parseSpec) by step 1; a `!ok` aborts. */
  readonly specSource: string;
  /**
   * The reviewed migrations to apply (the deployer reviews the generated SQL + commits it; here
   * it passes the migration(s) it intends to apply, each gated by step 3). For a first
   * materialization this is the generator's additive output; a forward-fix passes its own migration.
   * Applied in array order, abort-on-fail.
   */
  readonly migrations: PlannedMigration[];
  readonly target: DeployTarget;
  readonly rollout: RolloutConfig;
}

/**
 * Run the full GitOps deploy pipeline. Returns a `DeployResult` on success; THROWS `DeployError`
 * (abort-on-fail) at the first failing step — never a partial roll-out. The drift step is report-only
 * (a drift finding is returned, not an abort).
 */
export async function deploy<App = unknown>(config: DeployConfig): Promise<DeployResult<App>> {
  const { specSource, migrations, target, rollout } = config;

  // --- 1. VALIDATE -------------------------------------------------------------------------
  // Document-family dispatch: a Product-YAML doc
  // (`product_yaml_version`) is a DIFFERENT document from a `rayspec.yaml` — it declares product
  // MEANING (capabilities/artifacts/workflows/views). deploy() FULLY VALIDATES it (so `doctor`/
  // `plan` and a deploy attempt surface the same fail-closed errors), then COMPOSES its runtime from
  // the deployer-supplied `rollout.productYaml` via @rayspec/product-yaml (audio capability
  // mount + bridge-compiled durable workflows + trigger wiring + declarative views + the
  // tenant-bound node registry — production-owned). The composed engine spec
  // then flows through the SAME pipeline below (diff → lint/gate → migrate → roll out → drift), so
  // a product deploy gets the identical store/migration/chokepoint discipline. FAIL-CLOSED both
  // ways: no `rollout.productYaml` → the mount is rejected (validation-only stays doctor/plan's
  // job); any declared-but-unserved section → composeProductDeploy throws (ProductComposeError,
  // mapped 1:1 here) naming the section — never a silent skip, never an inert mount.
  let spec: RaySpec;
  let product: ComposedProductDeploy | undefined;
  if (detectSpecKind(specSource) === 'product') {
    const parsedProduct = parseProductSpec(specSource);
    if (!parsedProduct.ok) {
      throw new DeployError(
        'validate',
        `Product-YAML validation failed (${parsedProduct.errors.length} error(s)) — see details.`,
        parsedProduct.errors,
      );
    }
    if (!rollout.productYaml) {
      throw new DeployError(
        'unsupported_spec',
        `spec '${parsedProduct.value.product.id}' is a valid Product-YAML document, but this deploy ` +
          'supplies no Product-YAML rollout (rollout.productYaml) — the runtime composition (workflow ' +
          'enqueuer, STT adapter, agent executors, store bindings) is deployer-wired (PY-D5). Supply ' +
          'rollout.productYaml to mount it, or use `doctor`/`plan` to validate only.',
      );
    }
    try {
      product = composeProductDeploy(parsedProduct.value, rollout.productYaml);
    } catch (e) {
      if (e instanceof ProductComposeError) throw new DeployError(e.step, e.message);
      throw e;
    }
    spec = product.engineSpec;
  } else {
    const parsed = parseSpec(specSource);
    if (!parsed.ok) {
      throw new DeployError(
        'validate',
        `spec validation failed (${parsed.errors.length} error(s)) — see details.`,
        parsed.errors,
      );
    }
    spec = parsed.value;
  }

  // --- 2. DIFF (deterministic, reviewable SQL — read-not-blind) ----------------------------
  // The generator's product-store SQL is the canonical reviewable artifact. We surface it so the
  // deploy log records WHAT the spec materializes; the deployer applies the reviewed `migrations`.
  const generatedStoreSql = generateProductSql(spec.stores);

  // --- 3. LINT/GATE (the home-grown destructive policy — blocks unreviewed destructive) ----
  const gateResults: MigrationGateResult[] = [];
  for (const migration of migrations) {
    const result = scanMigrationSql(migration.sql, migration.allowlist ?? []);
    gateResults.push({
      name: migration.name,
      pass: result.pass,
      summary: formatFindings(result),
    });
  }
  const blocked = gateResults.filter((g) => !g.pass);
  if (blocked.length > 0) {
    throw new DeployError(
      'lint/gate',
      `${blocked.length} migration(s) carry a destructive statement WITHOUT a reviewed allowlist ` +
        `entry: ${blocked.map((b) => b.name).join(', ')}. Add a reviewed allowlist entry or revise.`,
      gateResults,
    );
  }

  // --- 4. MIGRATE (abort-on-fail; no partial roll-out) ------------------------------------
  for (const migration of migrations) {
    try {
      await target.applyMigration(migration);
    } catch (e) {
      throw new DeployError(
        'migrate',
        `migration '${migration.name}' failed to apply (${
          e instanceof Error ? e.message : String(e)
        }). No roll-out. Recovery is a new reviewed FORWARD migration (Fork #4).`,
      );
    }
  }

  // --- 5. ROLL OUT (verify A1 precondition → load handlers → triggers → build app) --------
  // Use the deployer-supplied CANONICAL product tables (the committed A1 tuple instances), then
  // FAIL-CLOSED VERIFY each declared store has one AND it is admitted by the real chokepoint (deploy
  // NEVER registers — see the header). A missing entry / a non-registered instance aborts.
  const productTables = rollout.productTables;
  for (const store of spec.stores) {
    const table = productTables.get(store.name);
    if (!table) {
      throw new DeployError(
        'roll out',
        `store '${store.name}' is declared in the spec but no product table was supplied for it in ` +
          'rollout.productTables — the deployment must export it from the committed generated ' +
          'product-schema.ts (A1: registration = committed source) and pass it here. deploy() never ' +
          'builds/registers product tables itself.',
      );
    }
    try {
      target.verifyTenantScoped(table, store.name);
    } catch (e) {
      throw new DeployError(
        'roll out',
        `store '${store.name}' is declared in the spec but its table is NOT registered in ` +
          'TENANT_SCOPED_TABLES (the deny-by-default chokepoint rejected it: ' +
          `${e instanceof Error ? e.message : String(e)}). Run the Slice-1 codegen and COMMIT the ` +
          'generated product-schema.ts (A1: registration = committed source), then redeploy. deploy() ' +
          'never mutates the Set.',
      );
    }
  }

  let handlers: Map<string, ResolvedHandler>;
  try {
    handlers = await loadHandlers(rollout.escapeHatchRoot, spec.handlers, rollout.importer);
  } catch (e) {
    throw new DeployError(
      'roll out',
      `handler load failed (path-jailed, fail-closed): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // Merge the COMPOSED product handlers (audio capability + views mounts) into the engine's
  // handler map. An id collision with an escape-hatch handler is a deploy abort (never a silent
  // override in either direction).
  if (product) {
    for (const [id, handler] of product.handlers) {
      if (handlers.has(id)) {
        throw new DeployError(
          'roll out',
          `composed product handler id '${id}' collides with a loaded escape-hatch handler — ` +
            'handler ids must be unique across the deployment.',
        );
      }
      handlers.set(id, handler);
    }
  }

  let triggers: TriggerRegistry;
  let app: App;
  try {
    // Register triggers (parse/register only). A dangling agent/handler ref aborts here.
    triggers = registerTriggers(spec, {
      handlers,
      agentIds: new Set(spec.agents.map((a) => a.id)),
    });
    const engine: DeclarativeEngine = {
      spec,
      productTables,
      handlers,
      ...(rollout.agentBackends ? { agentBackends: rollout.agentBackends } : {}),
    };
    app = rollout.buildApp<App>(engine);
  } catch (e) {
    if (e instanceof DeployError) throw e;
    throw new DeployError(
      'roll out',
      `app assembly failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // --- 6. DRIFT (report-only — never auto-heals) -------------------------------------------
  const drift =
    spec.stores.length > 0
      ? await detectDrift(spec.stores, target.driftSchema ?? 'public', (sql, params) =>
          target.query(sql, params),
        )
      : [];

  return {
    spec,
    generatedStoreSql,
    gateResults,
    productTables,
    handlers,
    triggers,
    app,
    drift,
    ...(product ? { product } : {}),
  };
}
