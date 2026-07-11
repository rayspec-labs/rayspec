/**
 * @rayspec/views-runtime — MOUNT-TIME compilation.
 *
 * `compileProductViews` turns validated `ProductViewSpec[]` into interpretable `CompiledView`s,
 * FAIL-CLOSED: it re-runs the SAME `lintProductViews` the parser runs (one source of truth — no
 * parse/mount drift) and then applies the MOUNT-ONLY checks that need the deployment's read surface:
 *
 *   - every backing store must EXIST in the injected read surface (the deployment's declared stores);
 *   - every referenced COLUMN must exist on its context store, COLUMN-TYPE-AWARE (never a blunt check —
 *     a `json`/`items` path requires a jsonb column; a `column` leaf's declared type must be
 *     producible by the column's SQL type; a param-valued filter must target a param-coercible
 *     column type);
 *   - injected server columns are a CLOSED allowlist (`id`, `created_at`) — `tenant_id` (and the
 *     other injected columns) can never be projected or filtered by a view (least exposure);
 *   - an `artifact_query` source must have an injected ARTIFACT BINDING (collection/kind → store);
 *   - every view must carry a RECOGNIZED auth policy (deny-by-default — no anonymous views);
 *   - a view that can not be interpreted (no `read`) and is not a capability delegation is
 *     REJECTED loudly — never skipped (the fail-open lesson).
 *
 * ANY violation aborts the mount with the FULL aggregated error list (never the first, never a
 * route that 500s at request time).
 */
import type {
  ArtifactSpec,
  CapabilitySpec,
  ColumnType,
  ContractsSpec,
  ProductViewSpec,
  StoreSpec,
  ViewConstValue,
  ViewField,
  ViewFilterArg,
  ViewLeafType,
  ViewMatchArg,
  ViewObjectShape,
  ViewParamSpec,
  ViewRead,
  ViewSubRead,
} from '@rayspec/spec';
import { lintProductViews } from '@rayspec/spec';

// ---------------------------------------------------------------------------------------
// config + result types
// ---------------------------------------------------------------------------------------

/** Binds an `artifact_query` source ref (a declared artifact kind or collection) to its backing store. */
export interface ArtifactBinding {
  /** The store (in the read surface) that persists this artifact kind/collection. */
  readonly store: string;
}

export interface ViewsCompileConfig {
  /** The validated view declarations (from a parsed ProductSpec — or code-built and re-validated here). */
  readonly views: readonly ProductViewSpec[];
  /** The product contracts (response-contract conformance + OpenAPI emission). */
  readonly contracts: ContractsSpec;
  /** The product's declared artifacts (artifact_query resolution). */
  readonly artifacts?: readonly ArtifactSpec[];
  /** The product's declared capabilities (capability-source resolution). */
  readonly capabilities?: readonly CapabilitySpec[];
  /**
   * THE READ SURFACE: the deployment's declared stores (names + columns). Every interpreted read
   * resolves against these at COMPILE time — an unknown store/column aborts the mount.
   */
  readonly stores: readonly StoreSpec[];
  /** artifact_query ref → backing store. REQUIRED for every artifact_query-sourced interpreted view. */
  readonly artifactBindings?: ReadonlyMap<string, ArtifactBinding>;
  /** The recognized auth policies (default: `bearer_tenant` only). A view outside the set is rejected. */
  readonly authPolicies?: ReadonlySet<string>;
  /**
   * TEN-2: the EXPLICIT policy → enforcement mapping (default: `DEFAULT_AUTH_POLICY_ENFORCEMENT`).
   * Recognition (`authPolicies`) alone is DECORATIVE — a policy must also map to a concrete
   * enforcement mechanism or the compile FAILS (fail-closed). When overriding, provide the FULL map
   * (it replaces the default, never merges) — an allowlisted-but-unmapped policy aborts the mount.
   */
  readonly authPolicyEnforcement?: ReadonlyMap<string, ViewAuthEnforcement>;
}

/**
 * The CLOSED enforcement vocabulary a recognized view auth policy maps onto (TEN-2).
 *  - `platform_handler_chain` — the mounted view route is a `{ kind:'handler' }` action registered
 *    by the platform's declared-routes engine behind the standard ordered chain
 *    `requireAuth → resolveTenant → requirePermission('store:write')` (the platform `{handler}`
 *    gate: every handler route is gated on the most-privileged product permission because the
 *    platform cannot statically prove a handler read-only — see register-declared-routes.ts).
 */
export type ViewAuthEnforcement = 'platform_handler_chain';

/**
 * TEN-2: `bearer_tenant` maps to the platform `{handler}` gate — that IS the enforcement of every
 * mounted view (the mount emits `{ kind:'handler' }` actions; nothing else enforces the policy).
 * A policy present in `authPolicies` but ABSENT here fails the compile: a recognized policy with no
 * mapped enforcement would be a decorative string on the declaration.
 */
export const DEFAULT_AUTH_POLICY_ENFORCEMENT: ReadonlyMap<string, ViewAuthEnforcement> = new Map([
  ['bearer_tenant', 'platform_handler_chain'],
]);

/** The per-store column index (declared business columns + the ALLOWLISTED injected columns). */
export type StoreIndex = ReadonlyMap<string, ReadonlyMap<string, ColumnType>>;

/** One interpretable view, compile-verified against the read surface. */
export interface CompiledView {
  readonly view: ProductViewSpec;
  readonly read: ViewRead;
  /** The resolved backing store name (source ref or artifact binding). */
  readonly storeName: string;
  /** The declared params (name → spec). */
  readonly params: ReadonlyMap<string, ViewParamSpec>;
}

/** The compile output: interpretable views + the capability views a mount must DELEGATE. */
export interface CompiledProductViews {
  readonly interpreted: readonly CompiledView[];
  readonly delegated: readonly ProductViewSpec[];
  /** The shared store index the interpreter coerces against. */
  readonly stores: StoreIndex;
}

export const DEFAULT_AUTH_POLICIES: ReadonlySet<string> = new Set(['bearer_tenant']);

/**
 * The CLOSED injected-column allowlist a view may reference (server-stamped columns beyond the
 * declared business columns). `tenant_id` is DELIBERATELY absent — a view can never project or
 * filter the tenant column (the tenant is structural, beneath the view); so are `deleted_at`/
 * `retention_days`/`region` (no current read model needs them — widen deliberately, never by default).
 */
const INJECTED_VIEW_COLUMNS: ReadonlyMap<string, ColumnType> = new Map([
  ['id', 'uuid'],
  ['created_at', 'timestamp'],
]);

/** The injected columns a view must NEVER reference (specific error over a generic unknown-column). */
const FORBIDDEN_INJECTED_COLUMNS: ReadonlySet<string> = new Set([
  'tenant_id',
  'deleted_at',
  'retention_days',
  'region',
]);

// ---------------------------------------------------------------------------------------
// type-compat tables (column-type-aware — never a too-blunt check)
// ---------------------------------------------------------------------------------------

/** Which DECLARED leaf types a column of a given SQL type can produce (jsonb can produce anything). */
const COLUMN_PRODUCES: Readonly<Record<ColumnType, ReadonlySet<ViewLeafType>>> = {
  text: new Set(['string']),
  uuid: new Set(['string']),
  timestamp: new Set(['string']), // the store facade serializes Date → ISO string
  integer: new Set(['integer', 'number']),
  boolean: new Set(['boolean']),
  jsonb: new Set(['string', 'number', 'integer', 'boolean', 'object', 'array']),
};

/** Which param SHAPES may filter a column of a given SQL type (with the coercion the interpreter applies). */
function paramFilterAllowed(colType: ColumnType, shape: ViewParamSpec['shape']): boolean {
  switch (colType) {
    case 'text':
    case 'uuid':
      return true; // params are strings; any preset produces a string
    case 'integer':
      return shape === 'positive_int' || shape === 'nonnegative_int'; // coerced to a number
    default:
      return false; // boolean/timestamp/jsonb equality on a request param — not expressible
  }
}

/** Does a CONST filter/match value match the column's SQL type (null is never an equality filter)? */
function constFilterAllowed(colType: ColumnType, value: ViewConstValue): boolean {
  if (value === null) return false; // `= NULL` never matches — a null filter is an authoring bug
  switch (colType) {
    case 'text':
    case 'uuid':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false; // timestamp/jsonb const equality — not expressible declaratively
  }
}

// ---------------------------------------------------------------------------------------
// the compile pass
// ---------------------------------------------------------------------------------------

/** Build the store index (declared columns + allowlisted injected columns) from the read surface. */
export function buildStoreIndex(stores: readonly StoreSpec[]): StoreIndex {
  const index = new Map<string, ReadonlyMap<string, ColumnType>>();
  for (const store of stores) {
    const cols = new Map<string, ColumnType>(INJECTED_VIEW_COLUMNS);
    for (const col of store.columns) cols.set(col.name, col.type);
    index.set(store.name, cols);
  }
  return index;
}

/**
 * Compile the declared views against the read surface. THROWS with the FULL aggregated error list on
 * any violation (fail-closed mount — never a silently-skipped view, never a route that 500s later).
 */
export function compileProductViews(config: ViewsCompileConfig): CompiledProductViews {
  const errors: string[] = [];
  const authPolicies = config.authPolicies ?? DEFAULT_AUTH_POLICIES;
  const authEnforcement = config.authPolicyEnforcement ?? DEFAULT_AUTH_POLICY_ENFORCEMENT;
  const stores = buildStoreIndex(config.stores);

  // 1. The SAME static validation the parser runs (single source of truth — no drift). A code-built
  //    spec that bypassed parseProductSpec is re-validated here.
  const lintErrors = lintProductViews({
    views: config.views,
    contracts: config.contracts,
    artifacts: config.artifacts ?? [],
    capabilities: config.capabilities ?? [],
  });
  for (const e of lintErrors)
    errors.push(`[${e.code}] ${e.message}${e.path ? ` (${e.path})` : ''}`);

  const interpreted: CompiledView[] = [];
  const delegated: ProductViewSpec[] = [];

  for (const view of config.views) {
    const label = `view '${view.id}'`;

    // ---- auth: deny-by-default (no anonymous views; unknown policies rejected) ------------
    if (!view.auth) {
      errors.push(`${label}: no auth policy declared — views are deny-by-default (declare auth)`);
    } else if (!authPolicies.has(view.auth)) {
      errors.push(
        `${label}: unknown auth policy '${view.auth}' (recognized: ${[...authPolicies].join(', ')})`,
      );
    } else if (!authEnforcement.has(view.auth)) {
      // TEN-2 fail-closed: recognized-but-unenforced is DECORATIVE — abort the mount.
      errors.push(
        `${label}: auth policy '${view.auth}' is allowlisted but has no mapped enforcement — a ` +
          'recognized policy must map to a concrete mechanism (authPolicyEnforcement, e.g. ' +
          "'bearer_tenant' → 'platform_handler_chain', the platform {handler} route gate); a " +
          'policy without enforcement is decorative and the mount is fail-closed',
      );
    }

    // ---- interpretable vs delegated vs unmountable ----------------------------------------
    if (!view.read) {
      if (view.source?.kind === 'capability') {
        delegated.push(view);
        continue;
      }
      errors.push(
        `${label}: has no read declaration and no capability source — it cannot be mounted ` +
          '(declare read for an interpreted view, or a capability source for a delegated one); ' +
          'a declaration-only view is REJECTED, never silently skipped',
      );
      continue;
    }

    // lint already rejected read-without-source / read-on-capability; guard for aggregation mode.
    if (!view.source || view.source.kind === 'capability') continue;

    // ---- resolve the backing store ----------------------------------------------------------
    let storeName: string;
    if (view.source.kind === 'store') {
      storeName = view.source.ref;
    } else {
      const binding = config.artifactBindings?.get(view.source.ref);
      if (!binding) {
        errors.push(
          `${label}: artifact_query source '${view.source.ref}' has no artifact binding — the ` +
            'deployment must map the artifact kind/collection to its backing store (artifactBindings)',
        );
        continue;
      }
      storeName = binding.store;
    }
    const columns = stores.get(storeName);
    if (!columns) {
      errors.push(
        `${label}: backing store '${storeName}' is not in the read surface (declared stores: ` +
          `${[...stores.keys()].join(', ') || '<none>'})`,
      );
      continue;
    }

    // ---- column-type-aware checks over the whole read ---------------------------------------
    const params = new Map(Object.entries(view.params ?? {}));
    const ctx: CheckCtx = { label, stores, params, errors };
    checkRead(view.read, storeName, ctx);

    interpreted.push({ view, read: view.read, storeName, params });
  }

  if (errors.length > 0) {
    throw new Error(
      `compileProductViews: ${errors.length} violation(s) — the mount is fail-closed:\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }

  return { interpreted, delegated, stores };
}

// ---------------------------------------------------------------------------------------
// read/shape column checks (context-store-aware walk)
// ---------------------------------------------------------------------------------------

interface CheckCtx {
  readonly label: string;
  readonly stores: StoreIndex;
  readonly params: ReadonlyMap<string, ViewParamSpec>;
  readonly errors: string[];
}

/** Resolve a column on a context store, with the closed injected allow/forbid lists. */
function columnType(
  store: string,
  column: string,
  where: string,
  ctx: CheckCtx,
): ColumnType | undefined {
  const cols = ctx.stores.get(store);
  if (!cols) {
    ctx.errors.push(`${ctx.label}: ${where} references unknown store '${store}'`);
    return undefined;
  }
  if (FORBIDDEN_INJECTED_COLUMNS.has(column)) {
    ctx.errors.push(
      `${ctx.label}: ${where} references injected column '${column}', which a view may never ` +
        "project or filter (closed allowlist: 'id', 'created_at'; the tenant is structural)",
    );
    return undefined;
  }
  const t = cols.get(column);
  if (!t) {
    ctx.errors.push(
      `${ctx.label}: ${where} references unknown column '${column}' on store '${store}'`,
    );
    return undefined;
  }
  return t;
}

function checkFilterArg(
  arg: ViewFilterArg | ViewMatchArg,
  colType: ColumnType | undefined,
  where: string,
  ctx: CheckCtx,
  parentStore?: string,
): void {
  if (colType === undefined) return;
  if ('param' in arg) {
    const p = ctx.params.get(arg.param);
    if (!p) return; // lint already reported the undeclared param
    if (!paramFilterAllowed(colType, p.shape)) {
      ctx.errors.push(
        `${ctx.label}: ${where} filters a '${colType}' column with param '${arg.param}' ` +
          `(shape '${p.shape}') — not coercible (text/uuid take any param; integer takes an int-shaped param)`,
      );
    }
    return;
  }
  if ('const' in arg) {
    if (!constFilterAllowed(colType, arg.const)) {
      ctx.errors.push(
        `${ctx.label}: ${where} filters a '${colType}' column with const ` +
          `${JSON.stringify(arg.const)} — the value type does not match the column (null is never an equality filter)`,
      );
    }
    return;
  }
  // { column } — the PARENT row's column must exist (its runtime value type comes from that column).
  if (parentStore !== undefined) {
    columnType(parentStore, arg.column, `${where} (parent column)`, ctx);
  }
}

function checkSubRead(sub: ViewSubRead, parentStore: string, where: string, ctx: CheckCtx): void {
  const childStore = sub.store;
  if (!ctx.stores.has(childStore)) {
    ctx.errors.push(`${ctx.label}: ${where} references unknown store '${childStore}'`);
    return;
  }
  for (const [col, arg] of Object.entries(sub.match)) {
    const t = columnType(childStore, col, `${where}.match.${col}`, ctx);
    checkFilterArg(arg, t, `${where}.match.${col}`, ctx, parentStore);
  }
  for (const ex of sub.exclude ?? []) {
    columnType(childStore, ex.column, `${where}.exclude`, ctx);
  }
  for (const ob of sub.order_by ?? []) {
    columnType(childStore, ob.column, `${where}.order_by`, ctx);
  }
}

/** A leaf's declared type must be producible by its column's SQL type (jsonb produces anything). */
function checkLeafCompat(
  colType: ColumnType | undefined,
  leafType: ViewLeafType,
  where: string,
  ctx: CheckCtx,
): void {
  if (colType === undefined) return;
  if (!COLUMN_PRODUCES[colType].has(leafType)) {
    ctx.errors.push(
      `${ctx.label}: ${where} declares leaf type '${leafType}' on a '${colType}' column — ` +
        `that column can only produce [${[...COLUMN_PRODUCES[colType]].join(', ')}]`,
    );
  }
}

function checkRead(read: ViewRead, storeName: string, ctx: CheckCtx): void {
  for (const [col, arg] of Object.entries(read.filter ?? {})) {
    const t = columnType(storeName, col, `read.filter.${col}`, ctx);
    checkFilterArg(arg, t, `read.filter.${col}`, ctx);
  }
  for (const ex of read.exclude ?? []) {
    columnType(storeName, ex.column, 'read.exclude', ctx);
  }
  for (const ob of read.order_by ?? []) {
    columnType(storeName, ob.column, 'read.order_by', ctx);
  }
  checkShape(read.shape, storeName, 'read.shape', ctx);
}

function checkShape(
  shape: ViewObjectShape,
  contextStore: string,
  where: string,
  ctx: CheckCtx,
): void {
  for (const [name, field] of Object.entries(shape.fields)) {
    checkField(field, contextStore, `${where}.${name}`, ctx);
  }
}

function checkField(field: ViewField, contextStore: string, where: string, ctx: CheckCtx): void {
  switch (field.kind) {
    case 'column': {
      const t = columnType(contextStore, field.column, where, ctx);
      checkLeafCompat(t, field.type, where, ctx);
      return;
    }
    case 'json': {
      const t = columnType(contextStore, field.column, where, ctx);
      if (t !== undefined && t !== 'jsonb') {
        ctx.errors.push(
          `${ctx.label}: ${where} walks a JSON path into column '${field.column}' of type '${t}' — ` +
            'a json field requires a jsonb column',
        );
      }
      return;
    }
    case 'items': {
      const t = columnType(contextStore, field.column, where, ctx);
      if (t !== undefined && t !== 'jsonb') {
        ctx.errors.push(
          `${ctx.label}: ${where} maps array items from column '${field.column}' of type '${t}' — ` +
            'an items field requires a jsonb column',
        );
      }
      return;
    }
    case 'list': {
      checkSubRead(field.source, contextStore, `${where}.source`, ctx);
      if (ctx.stores.has(field.source.store)) {
        checkShape(field.shape, field.source.store, `${where}.shape`, ctx);
      }
      return;
    }
    case 'lookup': {
      checkSubRead(field.source, contextStore, `${where}.source`, ctx);
      if (ctx.stores.has(field.source.store)) {
        const t = columnType(field.source.store, field.field.column, `${where}.field`, ctx);
        if (field.field.path && field.field.path.length > 0) {
          if (t !== undefined && t !== 'jsonb') {
            ctx.errors.push(
              `${ctx.label}: ${where} walks a JSON path into lookup column '${field.field.column}' ` +
                `of type '${t}' — a path requires a jsonb column`,
            );
          }
        } else {
          checkLeafCompat(t, field.type, where, ctx);
        }
      }
      return;
    }
    case 'counts': {
      if (field.of) {
        checkSubRead(field.of, contextStore, `${where}.of`, ctx);
        if (ctx.stores.has(field.of.store)) {
          columnType(field.of.store, field.by, `${where}.by`, ctx);
        }
      } else {
        columnType(contextStore, field.by, `${where}.by`, ctx);
      }
      return;
    }
    case 'group': {
      columnType(contextStore, field.column, where, ctx);
      if (field.value) {
        const t = columnType(contextStore, field.value.column, `${where}.value`, ctx);
        if (field.value.path && field.value.path.length > 0) {
          if (t !== undefined && t !== 'jsonb') {
            ctx.errors.push(
              `${ctx.label}: ${where}.value walks a JSON path into column '${field.value.column}' ` +
                `of type '${t}' — a path requires a jsonb column`,
            );
          }
        } else {
          checkLeafCompat(t, field.value.type, `${where}.value`, ctx);
        }
      }
      if (field.shape) checkShape(field.shape, contextStore, `${where}.shape`, ctx);
      return;
    }
    case 'page_items':
      checkShape(field.shape, contextStore, `${where}.shape`, ctx);
      return;
    default:
      return; // param/const/page_total/page_next_offset: no store refs
  }
}
