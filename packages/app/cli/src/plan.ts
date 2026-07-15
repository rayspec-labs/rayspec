/**
 * `rayspec plan <spec.yaml> [--against <old-spec>] [--allowlist <file.json>]` — the `deploy()`
 * FRONT-HALF as a READ-ONLY dry-run, profile-aware (backend + product) with an
 * UPDATE mode.
 *
 * `deploy()` (packages/api-auth/src/engine/deploy.ts) runs the pipeline:
 *   1. VALIDATE   (pure)  — parseSpec / parseProductSpec
 *   2. DIFF       (pure)  — generateProductSql(stores) (first materialize) OR diffProductStores(old,new)
 *   3. LINT/GATE  (pure)  — scanMigrationSql(sql, allowlist)
 *   4. MIGRATE    (the FIRST DB mutation against the target) ← `plan` STOPS BEFORE this
 *   5. ROLL OUT / 6. DRIFT (touch the live target)           ← `plan` NEVER reaches these
 *
 * `plan` composes the pure FRONT-HALF (steps 1-3) DIRECTLY — it does NOT import or call `deploy()`
 * (so deploy.ts stays byte-unchanged), and it NEVER calls `applyMigration`, `detectDrift` against a
 * live target, rolls out, or registers anything. Its ONLY deeper-than-`doctor` check is an OPTIONAL
 * shadow-apply against a THROWAWAY DB (never the real target).
 *
 * TWO profiles (dispatched by `detectSpecKind` on the `product:` discriminant):
 *   • backend profile — `spec.stores` are the declared Tier-A stores.
 *   • product profile — the Tier-A stores are DERIVED from the declarations (the transcript sink +
 *     the artifact collection stores) via `@rayspec/product-yaml`'s `deriveProductStores`, exactly
 *     as the boot path derives them. `plan` also projects the product's section counts (capabilities /
 *     artifacts / workflows / views / extractors). The product-yaml import is DYNAMIC and only happens
 *     on the product branch, so `doctor` / a backend `plan` / `gen-handler` never load the runtime graph.
 *
 * UPDATE mode (`--against <old-spec>`): the baseline is the PRIOR SPEC FILE (same family), NOT live-DB
 * introspection — `plan` stays zero-real-DB-contact and the read-only proof is preserved. `plan` diffs
 * old→new (`diffProductStores`) into the DELTA migration, runs the gate over the delta, and (with
 * `--allowlist <file>`) lets a reviewed destructive change preview as would-pass. A destructive delta
 * with no covering allowlist entry is BLOCKED (`breakingChangeBlocked`, `ok:false phase:'gate'`); the
 * machine-PROPOSED allowlist is surfaced so a reviewer can copy it into the `--allowlist` file.
 *
 * BASELINE-SEEDED shadow (update mode + `SHADOW_DATABASE_URL`): on a throwaway DB, apply the OLD spec's
 * first-materialization, then the DELTA, then assert the end state satisfies the NEW spec (the same
 * `detectDrift` oracle the boot path uses). Non-vacuous: an unappliable delta fails on apply; a delta
 * that omits or mistypes something the NEW spec declares fails the drift oracle. That oracle is spec ⊆
 * live — it does NOT verify removals (see shadow-apply.ts for why a failed-DROP is unreachable through
 * `--against`'s real path). Read-only w.r.t. the target is unchanged (RO-1 below).
 *
 * READ-ONLY GUARANTEE — scoped to the real DB's CONTENTS (structural, not by convention):
 *   • no DML/DDL `plan` ever issues mutates the real target's schema or rows — every mutating
 *     statement targets a THROWAWAY DB whose name `plan` itself generated (`rayspec_plan_<…>`),
 *     CREATEd on the SHADOW server, and DROPped in a `finally` (see `shadow-apply.ts`);
 *   • the shadow connects ONLY to a URL DERIVED from `SHADOW_DATABASE_URL` (never `DATABASE_URL`);
 *   • RO-1 — a fail-closed STRUCTURAL guard REFUSES the shadow (and opens NO admin connection) when
 *     the resolved shadow URL points at the SAME host:port AND SAME database name as `DATABASE_URL`;
 *   • the update-mode baseline comes from the OLD SPEC FILE, never a live introspection of the target.
 *
 * The output is a stable JSON envelope (see `PlanResult`). Update/product fields are ADDITIVE and
 * omitted on the backend first-materialization path, so that output stays byte-identical. NO
 * secrets: the DB URL / credentials are NEVER echoed (only a throwaway DB NAME, which is non-sensitive).
 */
import {
  type AllowlistEntry,
  type DestructiveKind,
  type DriftFinding,
  diffProductStores,
  formatFindings,
  generateProductSql,
  type ScanResult,
  type StoreConflictKeys,
  scanMigrationSql,
} from '@rayspec/db';
import {
  detectSpecKind,
  type ProductSpec,
  parseProductSpec,
  parseSpec,
  type RaySpec,
  type SpecError,
  type StoreSpec,
} from '@rayspec/spec';
import { ReadSpecError, readSpecFile, resolveSpecPath } from './read-spec.js';
import {
  shadowApply as defaultShadowApply,
  shadowApplyBaselineUpdate as defaultShadowApplyBaselineUpdate,
} from './shadow-apply.js';

/** A declared store, projected to the plan-output shape (name + column/FK counts — no SQL leak). */
export interface PlanStore {
  readonly name: string;
  readonly columns: number;
  readonly foreignKeys: number;
}

/** A declared route, projected to the plan-output shape. */
export interface PlanRoute {
  readonly method: string;
  readonly path: string;
  /** The route action kind (`store` | `agent` | `handler` | `stream`). */
  readonly action: string;
}

/** A declared agent, projected to the plan-output shape. */
export interface PlanAgent {
  readonly id: string;
  readonly backend: string;
  readonly model: string;
}

/** A destructive-scan finding, projected to the plan-output shape (the gate's verdict per statement). */
export interface PlanGateFinding {
  readonly kind: string;
  readonly line: number;
  readonly allowed: boolean;
}

/** Section counts for a product-profile doc — the honest projection of what it declares. */
export interface PlanProduct {
  readonly capabilities: number;
  readonly artifacts: number;
  readonly workflows: number;
  readonly views: number;
  readonly extractors: number;
}

/** The `plan` JSON result. */
export interface PlanResult {
  /**
   * Overall verdict: the spec validated, the migration gate did not BLOCK, and (if a shadow ran) the
   * generated SQL applied cleanly. `ok:false` always carries `errors`/`gateFindings` explaining why.
   */
  readonly ok: boolean;
  /** Which pipeline phase produced a failure, when `ok:false` (`validate` aborts before the rest). */
  readonly phase?: 'validate' | 'gate' | 'shadow';
  readonly stores: PlanStore[];
  /** The deterministic, reviewable product-migration SQL (DIFF step). Empty for a stores-free spec. */
  readonly migrationSql: string;
  readonly routes: PlanRoute[];
  readonly agents: PlanAgent[];
  /** Per-statement destructive-scan findings over `migrationSql` (LINT/GATE step). */
  readonly gateFindings: PlanGateFinding[];
  /** A human-readable one-line-per-finding gate summary (from the shared `formatFindings`). */
  readonly gateSummary: string;
  /**
   * True iff the generated migration carries a destructive statement WITHOUT a reviewed allowlist
   * entry — i.e. the gate would BLOCK the deploy. For a first materialization (purely additive) this
   * is `false`; in UPDATE mode a destructive delta with no covering `--allowlist` entry sets it `true`
   * (and the plan returns `ok:false phase:'gate'`). A blocked plan never throws — it reports findings.
   */
  readonly breakingChangeBlocked: boolean;
  /** True iff the optional shadow-apply ran (SHADOW_DATABASE_URL was set + there was SQL to apply). */
  readonly shadowApplied: boolean;
  /** Validation / shadow errors (SpecError-shaped: closed code + message + optional path). */
  readonly errors: SpecError[];
  // ── ADDITIVE fields (omitted on the backend first-materialization path — byte-stable) ────────
  /** True iff `--against` was given (UPDATE mode: the migration is a DELTA, not a first materialization). */
  readonly updateMode?: boolean;
  /**
   * The MACHINE-PROPOSED allowlist for a destructive delta (byte-faithful to the gate). A reviewer
   * copies the entries they approve into the `--allowlist` file; this is a proposal, NOT self-approval.
   * Present in UPDATE mode (empty when the delta is purely additive).
   */
  readonly proposedAllowlist?: AllowlistEntry[];
  /**
   * Honest diff caveats (renames, no-default NN, USING casts, drop ordering) in UPDATE mode; ALSO
   * carries a single projection-only note when a product doc validated but its derived-store projection
   * was unavailable (no `--against`). Present when non-empty on either path; absent on the backend
   * first-materialization path (byte-stable).
   */
  readonly notes?: string[];
  /** Section counts — present for a product-profile doc. */
  readonly product?: PlanProduct;
  /** The baseline-seeded shadow's drift findings vs the NEW spec (empty = the delta produced the target). */
  readonly driftFindings?: DriftFinding[];
}

/** The RO-1 refusal message (kept identical across first-materialize + update mode; secret-free). */
const RO1_REFUSE_MESSAGE =
  'refusing to shadow-apply: the shadow database resolves to the same host and database ' +
  'as DATABASE_URL — point SHADOW_DATABASE_URL at a separate throwaway database';

/** Project a `StoreSpec[]` into the plan-output store shapes (no SQL/secret leak). */
function projectStores(stores: readonly StoreSpec[]): PlanStore[] {
  return stores.map((s) => ({
    name: s.name,
    columns: s.columns.length,
    foreignKeys: s.foreignKeys.length,
  }));
}

/** Project a RaySpec's route + agent sections into the plan-output shapes. */
function projectRoutesAgents(spec: RaySpec): { routes: PlanRoute[]; agents: PlanAgent[] } {
  const routes: PlanRoute[] = spec.api.map((r) => ({
    method: r.method,
    path: r.path,
    action: r.action.kind,
  }));
  const agents: PlanAgent[] = spec.agents.map((a) => ({
    id: a.id,
    backend: a.backend,
    model: a.model,
  }));
  return { routes, agents };
}

/** Project a Product-YAML doc's section counts. */
function projectProduct(spec: ProductSpec): PlanProduct {
  return {
    capabilities: spec.capabilities.length,
    artifacts: spec.artifacts.length,
    workflows: spec.workflows.length,
    views: spec.views.length,
    extractors: spec.extractors.length,
  };
}

/** Project a `ScanResult` into the plan-output gate findings. */
function projectGate(scan: ScanResult): PlanGateFinding[] {
  return scan.findings.map((f) => ({ kind: f.kind, line: f.line, allowed: f.allowed }));
}

/** The empty projection carried by every validate-abort return (shape-stable). */
function emptyProjection(): {
  stores: PlanStore[];
  migrationSql: string;
  routes: PlanRoute[];
  agents: PlanAgent[];
  gateFindings: PlanGateFinding[];
  gateSummary: string;
  breakingChangeBlocked: boolean;
  shadowApplied: boolean;
} {
  return {
    stores: [],
    migrationSql: '',
    routes: [],
    agents: [],
    gateFindings: [],
    gateSummary: '',
    breakingChangeBlocked: false,
    shadowApplied: false,
  };
}

/**
 * RO-1 — does `shadowUrl` resolve to the SAME real DB as `databaseUrl`? True iff they share host,
 * port AND database NAME. Same host with a DIFFERENT db name (the normal `rayspec` vs `rayspec_shadow`
 * setup) returns FALSE — that is fine. A URL that fails to parse is treated as NOT-same.
 *
 * RO-1-PORT: the default Postgres port is NORMALIZED before comparing (no port ⇒ '5432').
 * (`localhost` vs `127.0.0.1` is an intentional, documented non-equal limitation.)
 */
function shadowTargetsRealDb(shadowUrl: string, databaseUrl: string): boolean {
  let s: URL;
  let d: URL;
  try {
    s = new URL(shadowUrl);
    d = new URL(databaseUrl);
  } catch {
    return false;
  }
  const dbName = (u: URL): string => u.pathname.replace(/^\//, '');
  const port = (u: URL): string => u.port || (u.protocol.startsWith('postgres') ? '5432' : '');
  return s.hostname === d.hostname && port(s) === port(d) && dbName(s) === dbName(d);
}

/** The shadow decision: skip (no url / no SQL), refuse (RO-1), or run against `url`. */
type ShadowTarget = 'skip' | 'refuse' | { readonly url: string };

/** Resolve the shadow target from opts/env, applying RO-1. Opens NO connection (pure decision). */
function resolveShadowTarget(opts: RunPlanOpts, migrationSql: string): ShadowTarget {
  const shadowUrl =
    'shadowDatabaseUrl' in opts ? opts.shadowDatabaseUrl : process.env.SHADOW_DATABASE_URL;
  if (!shadowUrl || migrationSql.trim().length === 0) return 'skip';
  const databaseUrl = 'databaseUrl' in opts ? opts.databaseUrl : process.env.DATABASE_URL;
  if (databaseUrl && shadowTargetsRealDb(shadowUrl, databaseUrl)) return 'refuse';
  return { url: shadowUrl };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// --allowlist parsing (fail-closed: shape + kind). A bad allowlist ABORTS at validate — it never
// silently clears a finding (a typo'd kind that fell through would leave the change BLOCKED anyway).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** A fail-closed `--allowlist` parse/shape failure (surfaced as a validate-phase plan error). */
class AllowlistError extends Error {}

/**
 * The full closed set of destructive kinds `scanMigrationSql` can emit (mirrors migration-scan.ts's
 * `DestructiveKind` union — the fail-closed validation reference). An entry whose kind is not here is
 * rejected: a malformed allowlist must not pass validation.
 */
const KNOWN_DESTRUCTIVE_KINDS: ReadonlySet<string> = new Set<DestructiveKind>([
  'truncate',
  'using-cast',
  'type-change-no-using',
  'drop-column',
  'drop-table',
  'drop-database',
  'drop-owned',
  'drop-schema',
  'drop-view',
  'drop-constraint',
  'drop-index',
  'delete-from',
  'delete-no-where',
  'update-no-where',
  'rename-table',
  'rename-column',
  'add-column-not-null-no-default',
  'set-not-null',
]);

/** Parse + fail-closed validate a `--allowlist` JSON file into `AllowlistEntry[]`. THROWS AllowlistError. */
function parseAllowlist(text: string): AllowlistEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new AllowlistError(
      `--allowlist is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(data)) {
    throw new AllowlistError('--allowlist must be a JSON array of { kind, match, reason } entries');
  }
  return data.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new AllowlistError(`--allowlist entry [${i}] must be an object`);
    }
    const { kind, match, reason } = raw as Record<string, unknown>;
    if (typeof kind !== 'string' || !KNOWN_DESTRUCTIVE_KINDS.has(kind)) {
      throw new AllowlistError(
        `--allowlist entry [${i}].kind must be a known destructive kind (got ${JSON.stringify(kind)})`,
      );
    }
    if (typeof match !== 'string' || match.length === 0) {
      throw new AllowlistError(`--allowlist entry [${i}].match must be a non-empty string`);
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new AllowlistError(`--allowlist entry [${i}].reason must be a non-empty string`);
    }
    return { kind: kind as DestructiveKind, match, reason };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Product-profile store derivation — DYNAMIC import so the lean paths never load the runtime.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Derive a product doc's Tier-A stores exactly as the boot path does (`deriveProductStores` over
 * the validated ProductSpec + the SPEC-AWARE capability store names from the SHARED
 * `composeCapabilityStores` helper — `record_submissions` joins the exclusion/collision set iff
 * the doc declares `record_input`, exactly like boot/compose). The import is DYNAMIC and scoped to
 * the product branch, so `doctor` / a backend `plan` / `gen-handler` never load product-yaml. Returns
 * `{ ok:false, error }` for a structurally-ambiguous doc (a `DeriveStoresError` — e.g. no
 * derivable transcript sink) so the caller can decide (projection: a note; update: fatal).
 * (The projection stays Tier-A-only by design: capability-owned stores are the platform's, are not
 * part of the product's declared surface, and materialize at boot — unchanged for audio docs.)
 */
async function deriveStoresForCli(
  spec: ProductSpec,
): Promise<
  { ok: true; stores: StoreSpec[]; conflictKeys: StoreConflictKeys } | { ok: false; error: string }
> {
  try {
    const { composeCapabilityStores, deriveConflictKeys, deriveProductStores } = await import(
      '@rayspec/product-yaml'
    );
    const stores = deriveProductStores(spec, composeCapabilityStores(spec).names).stores;
    // The derived collection/transcript conflict keys (`*_ref`) + declared `key` columns stay
    // single-column; any other author unique is tenant-scoped compound.
    return { ok: true, stores, conflictKeys: deriveConflictKeys(spec, stores) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The shared store-diff / gate / shadow front-half (family-agnostic once stores are computed).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Inputs to the shared front-half (both families feed it computed stores + their projections). */
interface StorePlanInputs {
  /** The NEW declared/derived Tier-A stores (projected as `stores`; migrated to). */
  readonly newStores: StoreSpec[];
  /** The PRIOR stores — PRESENT ⇒ UPDATE mode (diff old→new); ABSENT ⇒ first materialization. */
  readonly oldStores?: StoreSpec[];
  /** The reviewed allowlist fed to the gate (empty unless `--allowlist`). */
  readonly allowlist: AllowlistEntry[];
  readonly opts: RunPlanOpts;
  readonly routes: PlanRoute[];
  readonly agents: PlanAgent[];
  /** Section counts for a product doc (woven into every return); absent for a backend doc. */
  readonly product?: PlanProduct;
  /** First-materialization SQL thunk (backend uses the `generateSql` seam; product uses the derived stores). */
  readonly firstMaterializeSql: () => string;
  /**
   * Per-store conflict-key carve-out for the NEW stores (the index shape to emit + the shape the
   * plan-time shadow oracle enforces). Present for the product profile (durable `ON CONFLICT` targets
   * stay single-column); ABSENT for the backend profile → every author `unique: true` column is
   * tenant-scoped compound (the secure default).
   */
  readonly newConflictKeys?: StoreConflictKeys;
  /**
   * Per-store conflict-key carve-out for the OLD (baseline) stores — the shape the LIVE indexes
   * have. Seeds the update-mode shadow baseline so it reproduces the real old→new reindex; used by
   * `diffProductStores` to detect a surviving column's carve-out change. Product profile only.
   */
  readonly oldConflictKeys?: StoreConflictKeys;
}

/**
 * The shared DIFF → GATE → (optional) SHADOW front-half. In UPDATE mode the migration is the
 * `diffProductStores` DELTA + the machine-proposed allowlist + honest notes, and the shadow is the
 * baseline-seeded update check; otherwise it is the first-materialization SQL + the plain shadow.
 */
async function planStores(inp: StorePlanInputs): Promise<PlanResult> {
  const stores = projectStores(inp.newStores);
  const updateMode = inp.oldStores !== undefined;

  let migrationSql: string;
  let proposedAllowlist: AllowlistEntry[] = [];
  let notes: string[] = [];
  let baselineSql = '';
  if (inp.oldStores !== undefined) {
    const diff = diffProductStores(inp.oldStores, inp.newStores, {
      newConflictKeys: inp.newConflictKeys,
      oldConflictKeys: inp.oldConflictKeys,
      // `backfillInjectedColumns` DEFAULTS OFF. This is a spec-vs-spec diff (both sides are declared
      // specs, not the live DB), and a declared spec never lists the constant platform-injected columns
      // (their names are reserved), so with the flag off the diff simply never touches them: two identical
      // specs produce an EMPTY delta — the common yaml-vs-yaml `--against` case is phantom-free (it no
      // longer dilutes every delta with ~18 no-op backfill statements). The real-DB reconcile — an old
      // target DB genuinely MISSING created_by / idempotency_key — is unreachable from a spec diff alone,
      // so it is an explicit operator opt-in via `--reconcile-injected-columns` (surfaced here). When set,
      // every surviving store emits the idempotent `ADD COLUMN IF NOT EXISTS` + idempotency-index backfill.
      backfillInjectedColumns: inp.opts.reconcileInjectedColumns ?? false,
    });
    migrationSql = diff.migrationSql;
    proposedAllowlist = diff.proposedAllowlist;
    notes = diff.notes;
    // Baseline seeding: the shadow baseline reproduces the LIVE (OLD) index shape, so it MUST use the
    // OLD stores' OWN conflict keys — never the NEW ones — or a genuine old→new reindex is not reproduced
    // (a demoted `key`→author-unique column would seed a compound index the diff then can't reindex).
    baselineSql = generateProductSql(inp.oldStores, inp.oldConflictKeys);
  } else {
    migrationSql = inp.firstMaterializeSql();
  }

  const scan = scanMigrationSql(migrationSql, inp.allowlist);
  const gateFindings = projectGate(scan);
  const gateSummary = formatFindings(scan);
  const breakingChangeBlocked = !scan.pass;

  const base = {
    stores,
    migrationSql,
    routes: inp.routes,
    agents: inp.agents,
    gateFindings,
    gateSummary,
    breakingChangeBlocked,
  };
  // Additive extras — omitted on the backend first-materialization path so its output is byte-stable.
  const extra: {
    updateMode?: boolean;
    proposedAllowlist?: AllowlistEntry[];
    notes?: string[];
    product?: PlanProduct;
  } = {};
  if (updateMode) {
    extra.updateMode = true;
    extra.proposedAllowlist = proposedAllowlist;
    extra.notes = notes;
  }
  if (inp.product) extra.product = inp.product;

  // A blocked gate is reported (ok:false) but the plan still ran (no throw). Skip the shadow when
  // blocked: we would not deploy this migration, so applying it to a shadow proves nothing useful.
  if (breakingChangeBlocked) {
    return { ok: false, phase: 'gate', ...base, ...extra, shadowApplied: false, errors: [] };
  }

  const target = resolveShadowTarget(inp.opts, migrationSql);
  if (target === 'skip') {
    return { ok: true, ...base, ...extra, shadowApplied: false, errors: [] };
  }
  if (target === 'refuse') {
    return {
      ok: false,
      phase: 'shadow',
      ...base,
      ...extra,
      shadowApplied: false,
      errors: [{ code: 'schema_violation', message: RO1_REFUSE_MESSAGE }],
    };
  }

  if (updateMode) {
    const run = inp.opts.shadowApplyBaselineUpdate ?? defaultShadowApplyBaselineUpdate;
    // ARM the plan-time drift oracle — thread the NEW conflict keys so the baseline-seeded
    // shadow's `detectDrift` flags a stale single-column GLOBAL unique index where a tenant-scoped
    // compound one is now expected (`stale_global_unique`, report-only). Boot/deploy stay LENIENT.
    const shadow = await run(
      target.url,
      baselineSql,
      migrationSql,
      inp.newStores,
      inp.newConflictKeys,
    );
    if (!shadow.ok) {
      return {
        ok: false,
        phase: 'shadow',
        ...base,
        ...extra,
        shadowApplied: true,
        driftFindings: shadow.drift ?? [],
        errors: [{ code: 'schema_violation', message: `shadow-apply failed: ${shadow.error}` }],
      };
    }
    return { ok: true, ...base, ...extra, shadowApplied: true, driftFindings: [], errors: [] };
  }

  const run = inp.opts.shadowApply ?? defaultShadowApply;
  const shadow = await run(target.url, migrationSql);
  if (!shadow.ok) {
    return {
      ok: false,
      phase: 'shadow',
      ...base,
      ...extra,
      shadowApplied: true,
      errors: [{ code: 'schema_violation', message: `shadow-apply failed: ${shadow.error}` }],
    };
  }
  return { ok: true, ...base, ...extra, shadowApplied: true, errors: [] };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Family handlers.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The backend-profile plan: `spec.stores` are the declared stores; update mode diffs old→new. */
async function planRaySpec(
  newText: string,
  oldText: string | undefined,
  allowlist: AllowlistEntry[],
  opts: RunPlanOpts,
): Promise<PlanResult> {
  const parsed = parseSpec(newText);
  if (!parsed.ok) {
    return { ok: false, phase: 'validate', ...emptyProjection(), errors: parsed.errors };
  }
  const spec = parsed.value;
  const { routes, agents } = projectRoutesAgents(spec);

  let oldStores: StoreSpec[] | undefined;
  if (oldText !== undefined) {
    const parsedOld = parseSpec(oldText);
    if (!parsedOld.ok) {
      return { ok: false, phase: 'validate', ...emptyProjection(), errors: parsedOld.errors };
    }
    oldStores = parsedOld.value.stores;
  }

  return planStores({
    newStores: spec.stores,
    oldStores,
    allowlist,
    opts,
    routes,
    agents,
    // The generator is injectable (ND-1) so a test can drive the gate-BLOCKED branch through runPlan's
    // OWN code with a destructive first-materialization. Production default: generateProductSql(stores).
    firstMaterializeSql: () =>
      (opts.generateSql ?? ((s: RaySpec) => generateProductSql(s.stores)))(spec),
  });
}

/** The product-profile plan: derive Tier-A stores + project section counts; update mode diffs derived. */
async function planProduct(
  newText: string,
  oldText: string | undefined,
  allowlist: AllowlistEntry[],
  opts: RunPlanOpts,
): Promise<PlanResult> {
  const parsed = parseProductSpec(newText);
  if (!parsed.ok) {
    return { ok: false, phase: 'validate', ...emptyProjection(), errors: parsed.errors };
  }
  const product = projectProduct(parsed.value);

  const derivedNew = await deriveStoresForCli(parsed.value);
  let projectionNote: string | undefined;
  let newStores: StoreSpec[] = [];
  // The per-store conflict-key carve-out for the derived product stores — kept SEPARATE for the
  // OLD and NEW sides (a surviving store's conflict keys CAN change across an update, e.g. a column
  // demoted from a durable `key` to a plain author-unique), so a single merged map cannot seed the
  // baseline's live shape nor let the diff detect a reindex.
  let newConflictKeys: StoreConflictKeys | undefined;
  let oldConflictKeys: StoreConflictKeys | undefined;
  if (derivedNew.ok) {
    newStores = derivedNew.stores;
    newConflictKeys = derivedNew.conflictKeys;
  } else if (oldText === undefined) {
    // Projection-only: the doc VALIDATED — surface the derivation gap as a note, project no stores.
    projectionNote = `derived-store projection unavailable: ${derivedNew.error}`;
  } else {
    // Update mode CANNOT diff without the new stores — fatal.
    return {
      ok: false,
      phase: 'validate',
      ...emptyProjection(),
      product,
      errors: [
        {
          code: 'schema_violation',
          message: `cannot derive stores for the new product spec: ${derivedNew.error}`,
        },
      ],
    };
  }

  let oldStores: StoreSpec[] | undefined;
  if (oldText !== undefined) {
    const parsedOld = parseProductSpec(oldText);
    if (!parsedOld.ok) {
      return {
        ok: false,
        phase: 'validate',
        ...emptyProjection(),
        product,
        errors: parsedOld.errors,
      };
    }
    const derivedOld = await deriveStoresForCli(parsedOld.value);
    if (!derivedOld.ok) {
      return {
        ok: false,
        phase: 'validate',
        ...emptyProjection(),
        product,
        errors: [
          {
            code: 'schema_violation',
            message: `cannot derive stores for the --against product spec: ${derivedOld.error}`,
          },
        ],
      };
    }
    oldStores = derivedOld.stores;
    oldConflictKeys = derivedOld.conflictKeys; // the OLD (live) carve-out shape — seeds the baseline
  }

  const result = await planStores({
    newStores,
    oldStores,
    allowlist,
    opts,
    routes: [], // a product doc materializes no Tier-A routes in the deploy front-half
    agents: [], // product extractors are counted in `product.extractors`, not projected as backend/model
    product,
    newConflictKeys,
    oldConflictKeys,
    firstMaterializeSql: () =>
      newStores.length > 0 ? generateProductSql(newStores, newConflictKeys) : '',
  });
  // Weave a projection-only derivation note (never in update mode, where a gap is fatal above).
  if (projectionNote !== undefined) {
    return { ...result, notes: [...(result.notes ?? []), projectionNote] };
  }
  return result;
}

/**
 * Test seams for `runPlan`. Each defaults to the real production implementation; tests inject these to
 * drive the gate-BLOCKED path through `runPlan`'s OWN code (`generateSql`, ND-1) and to prove RO-1 opens
 * NO admin connection (spying `shadowApply` / `shadowApplyBaselineUpdate`). `databaseUrl` defaults to
 * `process.env.DATABASE_URL`. `against`/`allowlist` are the UPDATE-mode input file paths (jailed like
 * the spec path); the CLI parses them from `--against`/`--allowlist`.
 */
export interface RunPlanOpts {
  /** The shadow server URL. Key PRESENT (even `undefined`) is authoritative; ABSENT ⇒ env fallback. */
  shadowDatabaseUrl?: string | undefined;
  /** The real-target URL RO-1 guards against. Defaults to `process.env.DATABASE_URL`. */
  databaseUrl?: string | undefined;
  /** First-materialization DIFF step (defaults to `generateProductSql`). Injectable to force destructive SQL. */
  generateSql?: (spec: RaySpec) => string;
  /** The plain shadow-apply (defaults to the real one). Injectable as a spy for RO-1's no-connection proof. */
  shadowApply?: typeof defaultShadowApply;
  /** The baseline-seeded shadow (defaults to the real one). Injectable as a spy for the update-mode RO-1 proof. */
  shadowApplyBaselineUpdate?: typeof defaultShadowApplyBaselineUpdate;
  /** UPDATE mode: the PRIOR spec file to diff against (baseline is the FILE, never live DB introspection). */
  against?: string;
  /** A reviewed-allowlist JSON file (AllowlistEntry[]) fed to the gate so a reviewed destructive change previews. */
  allowlist?: string;
  /**
   * REAL-DB reconcile opt-in (update mode only). When true, the delta ALSO carries the idempotent
   * injected-column backfill (`ADD COLUMN IF NOT EXISTS "created_by"/"idempotency_key"` + the
   * tenant-scoped idempotency index) for every surviving store. Use it when the target DB was
   * materialized before those platform columns existed and genuinely lacks them — a spec-vs-spec diff
   * cannot see the live DB, so it cannot infer the gap on its own. DEFAULT off ⇒ the common yaml-vs-yaml
   * plan stays phantom-free. Requires `--against` (inert on a first materialization, which creates the
   * columns fresh) — the combination without `--against` is rejected fail-closed.
   */
  reconcileInjectedColumns?: boolean;
}

/**
 * Run `plan` over the positional args. Reads the spec fail-closed, dispatches by profile (backend /
 * product), and — with `--against` — computes an UPDATE delta instead of a first
 * materialization. Returns the `PlanResult`; NEVER throws for an invalid spec / blocked gate / shadow
 * failure / bad `--allowlist` (each is surfaced in the result).
 */
export async function runPlan(
  positionals: readonly string[],
  opts: RunPlanOpts = {},
): Promise<PlanResult> {
  // Read the NEW spec fail-closed (same hardening as doctor).
  let text: string;
  try {
    text = await readSpecFile(resolveSpecPath(positionals));
  } catch (e) {
    if (e instanceof ReadSpecError) {
      return {
        ok: false,
        phase: 'validate',
        ...emptyProjection(),
        errors: [{ code: 'yaml_parse_error', message: e.message }],
      };
    }
    throw e;
  }
  const newKind = detectSpecKind(text);

  // --against: read the PRIOR spec (jailed) and require the SAME family (a cross-family diff is undefined).
  let oldText: string | undefined;
  if (opts.against !== undefined) {
    try {
      oldText = await readSpecFile(resolveSpecPath([opts.against]));
    } catch (e) {
      if (e instanceof ReadSpecError) {
        return {
          ok: false,
          phase: 'validate',
          ...emptyProjection(),
          errors: [{ code: 'yaml_parse_error', message: `--against: ${e.message}` }],
        };
      }
      throw e;
    }
    const oldKind = detectSpecKind(oldText);
    if (oldKind !== newKind) {
      return {
        ok: false,
        phase: 'validate',
        ...emptyProjection(),
        errors: [
          {
            code: 'schema_violation',
            message:
              `--against spec family (${oldKind}) does not match the new spec family (${newKind}) — ` +
              'update mode diffs two specs of the SAME family',
          },
        ],
      };
    }
  }

  // --reconcile-injected-columns: FAIL-CLOSED — it only augments an UPDATE delta. On a first
  // materialization the injected columns are created fresh, so the flag would be silently inert; reject
  // the combination rather than accept a no-op flag (mirrors `--allowlist requires --against`).
  if (opts.reconcileInjectedColumns && opts.against === undefined) {
    return {
      ok: false,
      phase: 'validate',
      ...emptyProjection(),
      errors: [
        {
          code: 'schema_violation',
          message:
            '--reconcile-injected-columns requires --against — the injected-column backfill only ' +
            'augments an update diff (a first materialization creates those columns fresh)',
        },
      ],
    };
  }

  // --allowlist: read (jailed) + fail-closed parse into AllowlistEntry[].
  let allowlist: AllowlistEntry[] = [];
  if (opts.allowlist !== undefined) {
    // FAIL-CLOSED: a reviewed allowlist only clears a DESTRUCTIVE DELTA, which only exists in update
    // mode. Without `--against` the first-materialization path never consults it — so an `--allowlist`
    // here would be silently inert. Reject the combination rather than accept a no-op flag.
    if (opts.against === undefined) {
      return {
        ok: false,
        phase: 'validate',
        ...emptyProjection(),
        errors: [
          {
            code: 'schema_violation',
            message:
              '--allowlist requires --against — a reviewed allowlist only applies to an update diff',
          },
        ],
      };
    }
    let allowlistText: string;
    try {
      allowlistText = await readSpecFile(resolveSpecPath([opts.allowlist]));
    } catch (e) {
      if (e instanceof ReadSpecError) {
        return {
          ok: false,
          phase: 'validate',
          ...emptyProjection(),
          errors: [{ code: 'yaml_parse_error', message: `--allowlist: ${e.message}` }],
        };
      }
      throw e;
    }
    try {
      allowlist = parseAllowlist(allowlistText);
    } catch (e) {
      if (e instanceof AllowlistError) {
        return {
          ok: false,
          phase: 'validate',
          ...emptyProjection(),
          errors: [{ code: 'schema_violation', message: e.message }],
        };
      }
      throw e;
    }
  }

  return newKind === 'product'
    ? planProduct(text, oldText, allowlist, opts)
    : planRaySpec(text, oldText, allowlist, opts);
}
