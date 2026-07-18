/**
 * `lintSpec` — the semantic pass beyond Zod shape validation.
 *
 * Zod (`grammar.ts`) proves SHAPE (types, enums, strict unknown-key rejection). The lint pass
 * proves SEMANTICS that Zod cannot express across sections:
 *
 *  1. Cross-references RESOLVE — every `tooling.handler`, `agents[].tools[]`, `api.action.*`,
 *     `triggers.action.*`, and `stores[].foreignKeys[].references` points at a declared id/name.
 *  2. NO DUPLICATE ids/names within any section — incl. tooling by `name` (the dispatchTool
 *     registry keys on `spec.name`, dispatch.ts), api routes by `${method} ${path}`, and store
 *     columns by `name` within a store.
 *  3. CAPABILITY — every agent is run through core `validateSpec(syntheticAgentSpec, backend, …)`
 *     so a capability the backend lacks fails at CONFIG time (the canonical violation:
 *     `outputSchema` + `requireNativeStructuredOutput:true` on `backend:'pi'`).
 *  4. EMBEDDED SCHEMAS COMPILE — every tool `parameters`/`outputSchema` AND every agent
 *     `outputSchema.schema` is compiled with Ajv2020 at load; a malformed one is
 *     `invalid_embedded_schema`. A tool's `parameters` must additionally be an OBJECT schema
 *     (`type:'object'`) — all 3 backends require object-typed tool args (`schema_violation`).
 *  5. KIND→FIELD coherence — a `cron` trigger requires `schedule`; an `event` trigger requires
 *     `event`; a handler referenced by `tooling` must be `kind:'tool'`, by `api` must be `route`,
 *     by `triggers` must be `trigger` (so a handler is wired through the right chokepoint).
 *  6. DDL COHERENCE — a store column may not collide with an injected tenancy/GDPR column
 *     (`reserved_column_name`); an FK `onDelete:'set null'` requires a NULLABLE local column
 *     (`schema_violation`).
 *
 * NOTE on `deployment`: the optional `deployment.durableWorker` is a
 * DEPLOYMENT declaration ("does this deployment run a durable off-request worker?"), gated by
 * `.strict()` shape validation. For the per-REQUEST `async:true` run signal there is NO grammar field
 * to cross-check (it is `StartRunRequest.async`, runs.ts), and the LOAD-BEARING async gate is the
 * RUNTIME one: `async:true` + no durable executor wired ⇒ a clean fail-closed 501 at `executeAgentRun`.
 * BUT a declared `cron` OR `manual` TRIGGER is a CONFIG-LEVEL coupling we CAN check: both are fired by
 * the durable worker (a cron on its crontab, a manual on demand), so a `cron`/`manual` trigger WITHOUT
 * `deployment.durableWorker:true` would be silently never scheduled / un-fireable — rule (5) below
 * rejects that (`schema_violation`). The composition root ALSO boot-aborts on the same coupling
 * (defense-in-depth), but the static lint rule fails it at parse/deploy time.
 *
 * Returns the FULL list of violations (closed `SpecError` codes) — never the first. Pure function
 * over an already-shape-valid `RaySpec` (the parser calls it after the Zod parse succeeds).
 */
import { type AgentSpec, type BackendId, validateSpec } from '@rayspec/core';
// ajv ships CJS with no `exports` map; under NodeNext + verbatimModuleSyntax the default import
// types as the module NAMESPACE even though at runtime it IS the class (ajv sets
// module.exports.default = module.exports). Resolve the constructor at runtime across both interop
// shapes and take the instance TYPE from the named class export — exactly as dispatch.ts does.
import type { Ajv2020 as Ajv2020Class } from 'ajv/dist/2020.js';
import * as Ajv2020Module from 'ajv/dist/2020.js';
import { type SpecError, type SpecWarning, specError, specWarning } from './errors.js';
import { type ColumnType, MAX_IDENTIFIER_LENGTH, type RaySpec } from './grammar.js';

type AjvInstance = Ajv2020Class;
const Ajv2020Ctor = ((Ajv2020Module as { default?: unknown }).default ?? Ajv2020Module) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;

/**
 * Column names the table generator INJECTS on every product table (the tenancy/GDPR pattern —
 * see packages/db/src/schema.ts). An author-declared business column with one of these names
 * would shadow/collide with the injected column, so the linter rejects it fail-closed.
 */
export const RESERVED_COLUMN_NAMES: ReadonlySet<string> = new Set([
  'id',
  'tenant_id',
  'created_at',
  'deleted_at',
  'retention_days',
  'region',
  // The injected actor + idempotency columns (server-controlled, never author-declarable).
  'created_by',
  'idempotency_key',
]);

/**
 * The list-query CONTROL keywords — the reserved query-string keys the declarative `list` route
 * uses to steer sorting, keyset pagination, and substring search (mirrors `CONTROL_KEYS` in the compose
 * package's store-query.ts; @rayspec/spec cannot import the compose package, so this is the KEEP-IN-SYNC
 * copy).
 *
 * A declared BUSINESS column of one of these names is a config error, because at the `list` route it is
 * (a) silently un-equality-filterable — `buildListQuery` routes `?order=`/`?after=`/`?limit=`/`?search=`
 * to the control parsers and never reaches the per-column equality lookup — AND (b) it makes the emitted
 * OpenAPI document carry a DUPLICATE query parameter (the hard-coded control param + the per-column
 * filter param share a `name`+`in`), which is an INVALID OpenAPI 3.1 doc. This is a SEPARATE set from
 * `RESERVED_COLUMN_NAMES` on purpose — that Set is meta-test-locked to equal the injected columns
 * (`INJECTED_COLUMN_NAMES`); these keywords are not injected columns, they are query controls.
 */
export const RESERVED_QUERY_KEYWORDS: ReadonlySet<string> = new Set([
  'order',
  'after',
  'limit',
  'search',
  // The ranked full-text-search control key (see `FTS_SEARCH_PARAM`) — reserved for the SAME reason as
  // `search`: a business column of this name would be un-filterable (routed to the FTS control parser)
  // and would emit a duplicate OpenAPI query parameter on a full-text-search store.
  '__search',
]);

/**
 * The name of the GENERATED tsvector column the store generator injects when a store declares
 * `fullTextSearch: true` (a GENERATED-ALWAYS-STORED `to_tsvector('simple', …)` column over the store's
 * text columns, backed by a GIN index — see @rayspec/db generate-product-sql). It is a DB-level search
 * structure (NOT represented in the Drizzle ORM twins, exactly like the injected `<table>_tenant_idx`
 * and the idempotency unique index), so it never surfaces in a list response. Reserved: an FTS store may
 * not declare a business column of this name (the FTS coherence check below rejects the clash).
 */
export const FTS_COLUMN_NAME = 'search_vector';

/**
 * The ranked full-text-search list-query control key (`?__search=<term>`). Distinct from the substring
 * `search` control key: `__search` is available ONLY on a store that declares `fullTextSearch: true`,
 * runs a `search_vector @@ websearch_to_tsquery('simple', term)` match, and orders by `ts_rank` DESC.
 * A store WITHOUT full-text search rejects the param fail-closed. Mirrored in the compose package's
 * store-query.ts `CONTROL_KEYS` (this package cannot import compose — a KEEP-IN-SYNC copy, guarded by
 * the reserved-keyword membership above).
 */
export const FTS_SEARCH_PARAM = '__search';

/**
 * Route prefixes the PLATFORM owns — a declared static frontend mount may neither claim one nor nest
 * under one (the frontend lint rule below), and the static runtime declines any request under one so a
 * platform miss falls through to the uniform JSON 404 rather than a served file / SPA shell
 * (serve-static.ts consumes this SAME constant so the two never drift). Root `/` is NOT here: it is a
 * legitimate static catch-all that coexists with `/v1/*` via registration order + fall-through.
 */
export const RESERVED_ROUTE_PREFIXES = ['/v1', '/health', '/oidc'] as const;

/**
 * Find duplicate keys in a list, reporting each duplicate occurrence (by index) as a SpecError.
 * `keyOf` extracts the dedup key; `pathOf` builds the JSON path for a violating index.
 */
function findDuplicates<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  section: string,
  pathOf: (index: number) => string,
): SpecError[] {
  const errors: SpecError[] = [];
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const key = keyOf(item);
    if (seen.has(key)) {
      errors.push(
        specError(
          'duplicate_name',
          `duplicate ${section} '${key}' (each ${section} id/name must be unique)`,
          pathOf(index),
        ),
      );
    } else {
      seen.add(key);
    }
  });
  return errors;
}

/**
 * snake_case -> camelCase, IDENTICAL to the generator's `toCamel` (generate-product-schema.ts), so
 * the collision check here predicts the exact JS identifier the generator would emit. (TEN-3)
 *
 * EXPORTED for the product-store column-collision check in `product-lint.ts` —
 * the ONE spec-side copy of the rule. KEEP-IN-SYNC (honest replication, dependency direction:
 * spec must not import platform/db): the SAME rule also lives in
 *  - packages/db/src/generated/generate-product-schema.ts (`toCamel`) + build-product-tables.ts,
 *  - packages/platform/src/handlers/store-facade.ts (`snakeToCamel`),
 *  - packages/api-auth/src/engine/injected-columns-view.ts (`snakeToCamel`).
 * A literal-example pin test (product-stores.test.ts, "snake→camel pin") guards this copy against
 * drift; if the rule ever changes, ALL copies + the pin must move together.
 */
export function toJsIdentifier(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/**
 * Detect a foreign-key CYCLE among the declared stores (A→B, B→A, directly or transitively). Returns
 * the cycle as a node-name chain (e.g. `['a','b','a']`) or `null` when the product→product FK graph is
 * acyclic. SELF-references are excluded (a self-FK applies fine after the table's own CREATE) and so are
 * references to undeclared stores (already reported as `dangling_ref`). Mirrors the generator's
 * `topoSortStoresByFk` cycle condition, so a spec that lints clean here never throws at generation/apply.
 */
function findFkCycle(stores: RaySpec['stores']): string[] | null {
  const inSet = new Set(stores.map((s) => s.name));
  // parents[name] = the DISTINCT in-set, non-self stores `name` references (the DDL parents).
  const parents = new Map<string, string[]>();
  for (const s of stores) {
    const ps: string[] = [];
    for (const fk of s.foreignKeys) {
      if (fk.references === s.name) continue; // self-FK: legal, not a cycle edge
      if (!inSet.has(fk.references)) continue; // dangling: reported as dangling_ref elsewhere
      if (!ps.includes(fk.references)) ps.push(fk.references);
    }
    parents.set(s.name, ps);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(stores.map((s) => [s.name, WHITE]));
  const stack: string[] = [];
  let cycle: string[] | null = null;
  const visit = (node: string): boolean => {
    color.set(node, GRAY);
    stack.push(node);
    for (const parent of parents.get(node) ?? []) {
      const pc = color.get(parent);
      if (pc === GRAY) {
        // A back-edge to a node still on the stack ⇒ the cycle is stack[parent..node] + parent.
        const idx = stack.indexOf(parent);
        cycle = [...stack.slice(idx), parent];
        return true;
      }
      if (pc === WHITE && visit(parent)) return true;
    }
    stack.pop();
    color.set(node, BLACK);
    return false;
  };
  for (const s of stores) {
    if (color.get(s.name) === WHITE && visit(s.name)) break;
  }
  return cycle;
}

/**
 * The JSON-Schema types a declared store column of each `ColumnType` accepts when a run's validated
 * output is written into it (the `persistTo` cross-check). A `jsonb` column accepts any JSON value; a
 * scalar column accepts only its matching JSON-Schema scalar (a `timestamp` takes an ISO string, which
 * the store facade coerces to a Date). Deliberately permissive on `integer` (accepts JSON `number` too —
 * numeric↔numeric) so the check flags only genuine SHAPE mismatches (e.g. an object into a text column),
 * never a false positive on a numeric-typed property. `null` is universally compatible (handled below).
 */
const PERSIST_COLUMN_COMPAT: Record<ColumnType, ReadonlySet<string>> = {
  text: new Set(['string']),
  uuid: new Set(['string']),
  timestamp: new Set(['string']),
  integer: new Set(['integer', 'number']),
  boolean: new Set(['boolean']),
  jsonb: new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']),
};

/** snake_case → camelCase — the SAME rule the store facade + product-table builder use for columns. */
function toCamelIdent(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** The declared JSON-Schema type(s) of a property schema, as a list ([] when none is declared). */
function jsonSchemaTypes(propSchema: unknown): string[] {
  if (typeof propSchema !== 'object' || propSchema === null) return [];
  const t = (propSchema as { type?: unknown }).type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

/**
 * Validate an agent action's optional `persistTo` (shared by api routes AND triggers). Two directions,
 * both fail-closed at DEPLOY so nothing surfaces at the runtime persist write; aggregates ALL violations:
 *
 *  FORWARD — the target store must be declared, the referenced agent must declare an OBJECT
 *  `outputSchema`, and EVERY output property must map to a WRITABLE business column of a compatible type.
 *
 *  REVERSE — every REQUIRED (NOT-NULL, no-default) business column of the store must be reliably produced
 *  by the output: (a) a matching output property exists, (b) that property is in the schema's `required`
 *  array (an optional property the model may omit would violate NOT-NULL), and (c) the property's type
 *  does not include `null`. Plus (d): where a store column and the mapped property BOTH declare an `enum`,
 *  the property's enum must be a subset of the column's whitelist. Without the reverse pass, an uncovered
 *  NOT-NULL column (or a nullable/optional property mapped to one) fails the INSERT with a NOT-NULL
 *  violation AFTER the run has billed — silently defeating the exactly-once persist.
 */
function checkPersistTo(
  persistTo: string,
  agentId: string,
  storeByName: ReadonlyMap<string, RaySpec['stores'][number]>,
  agentById: ReadonlyMap<string, RaySpec['agents'][number]>,
  pathPrefix: string,
  refLabel: string,
): SpecError[] {
  const out: SpecError[] = [];
  const store = storeByName.get(persistTo);
  if (!store) {
    out.push(
      specError(
        'dangling_ref',
        `${refLabel} persists to unknown store '${persistTo}'`,
        `${pathPrefix}.persistTo`,
      ),
    );
    return out; // no store ⇒ the column checks below cannot run
  }
  // A dangling agent ref is reported by the caller's agent-existence check; only proceed if resolvable.
  const agent = agentById.get(agentId);
  if (!agent) return out;
  const schema = agent.outputSchema?.schema as { properties?: unknown } | undefined;
  if (!agent.outputSchema || schema === undefined) {
    out.push(
      specError(
        'schema_violation',
        `${refLabel} sets persistTo '${persistTo}' but agent '${agentId}' declares no outputSchema — there ` +
          'is no structured output to persist. Declare an outputSchema on the agent, or drop persistTo',
        `${pathPrefix}.persistTo`,
      ),
    );
    return out;
  }
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    out.push(
      specError(
        'schema_violation',
        `${refLabel} sets persistTo '${persistTo}' but agent '${agentId}' outputSchema declares no object ` +
          "'properties' — persistTo requires an object output whose properties map to the store's columns",
        `${pathPrefix}.persistTo`,
      ),
    );
    return out;
  }
  // name (snake OR camel) → the declared business column of the target store (the facade accepts both).
  const columnByName = new Map<string, (typeof store.columns)[number]>();
  for (const c of store.columns) {
    columnByName.set(c.name, c);
    columnByName.set(toCamelIdent(c.name), c);
  }
  for (const [propName, propSchema] of Object.entries(properties as Record<string, unknown>)) {
    const column = columnByName.get(propName);
    if (!column) {
      out.push(
        specError(
          'schema_violation',
          `${refLabel} persists to store '${persistTo}', but the agent's output property '${propName}' is ` +
            'not a writable business column of that store (server-controlled columns like id/tenant_id/' +
            'created_at/created_by are not writable — check the declared column name)',
          `${pathPrefix}.persistTo`,
        ),
      );
      continue;
    }
    const declaredTypes = jsonSchemaTypes(propSchema);
    const compat = PERSIST_COLUMN_COMPAT[column.type];
    const incompatible = declaredTypes.filter((t) => t !== 'null' && !compat.has(t));
    if (declaredTypes.length > 0 && incompatible.length > 0) {
      out.push(
        specError(
          'schema_violation',
          `${refLabel} persists output property '${propName}' (type ${incompatible
            .map((t) => `'${t}'`)
            .join(
              '/',
            )}) into store '${persistTo}' column '${column.name}' of type '${column.type}', which ` +
            'is not a compatible type',
          `${pathPrefix}.persistTo`,
        ),
      );
    }
  }

  // The forward loop above proves every OUTPUT property maps to a compatible writable column. It does
  // NOT prove the CONVERSE: that every REQUIRED (NOT-NULL, no-default) business column of the store is
  // actually produced by the output. A business column defaults NOT NULL (grammar) and gets NO database
  // default (the product-table builder emits `.notNull()` with no `.default()` on business columns), so a
  // NOT-NULL column the output does not reliably fill fails the runtime INSERT with a NOT-NULL violation
  // AFTER the run has billed — silently defeating the exactly-once persist. Reject that at DEPLOY. The
  // server-controlled/injected columns (id / tenant_id / created_at / created_by / region / …) are filled
  // by the platform, never by the output — RESERVED_COLUMN_NAMES is the authoritative injected-column set
  // (meta-locked to INJECTED_COLUMN_NAMES), so they are exempt.
  const props = properties as Record<string, unknown>;
  const requiredSet = new Set(
    Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required?: unknown }).required as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [],
  );
  // The OUTPUT property that maps to a store column (snake OR camel — the facade accepts both), if any.
  const propNameForColumn = (columnName: string): string | undefined => {
    if (columnName in props) return columnName;
    const camel = toCamelIdent(columnName);
    if (camel in props) return camel;
    return undefined;
  };
  for (const column of store.columns) {
    // Only NOT-NULL business columns must be covered; a nullable column may be omitted safely. Injected
    // columns are platform-filled (never author-declarable as business columns anyway) — skip them.
    if (column.nullable === true) continue;
    if (RESERVED_COLUMN_NAMES.has(column.name)) continue;
    const propName = propNameForColumn(column.name);
    if (propName === undefined) {
      // (a) No output property maps to this NOT-NULL column → a runtime NOT-NULL violation.
      out.push(
        specError(
          'schema_violation',
          `${refLabel} persists to store '${persistTo}', but its NOT-NULL column '${column.name}' is not ` +
            `produced by agent '${agentId}' outputSchema — no output property maps to it, so the persist ` +
            "write would fail the column's NOT-NULL constraint at runtime. Add a matching output property " +
            `(named '${column.name}'), or make the column nullable`,
          `${pathPrefix}.persistTo`,
        ),
      );
      continue;
    }
    // (b) The property exists but is not in `required` → the model may OMIT it → a runtime NOT-NULL
    //     violation (a property present in `properties` but absent from `required` is optional output).
    if (!requiredSet.has(propName)) {
      out.push(
        specError(
          'schema_violation',
          `${refLabel} persists to store '${persistTo}': output property '${propName}' maps to NOT-NULL ` +
            `column '${column.name}' but is not in the outputSchema 'required' array — the model may omit ` +
            "it, failing the column's NOT-NULL constraint at runtime. Add it to 'required', or make the " +
            'column nullable',
          `${pathPrefix}.persistTo`,
        ),
      );
    }
    // (c) The property's declared type includes 'null' → the model may EMIT null into a NOT-NULL column.
    if (jsonSchemaTypes(props[propName]).includes('null')) {
      out.push(
        specError(
          'schema_violation',
          `${refLabel} persists to store '${persistTo}': output property '${propName}' declares a nullable ` +
            `type (includes 'null') but maps to NOT-NULL column '${column.name}' — an emitted null would ` +
            "fail the column's NOT-NULL constraint at runtime. Remove 'null' from the property's type, or " +
            'make the column nullable',
          `${pathPrefix}.persistTo`,
        ),
      );
    }
  }

  // (d) ENUM whitelist subset: a store column `enum` is a value whitelist the platform enforces
  // server-side (an out-of-whitelist write is a fail-closed StoreInputError at runtime). When the mapped
  // output property ALSO declares an `enum`, EVERY member must be within the column's whitelist — else the
  // model may legally emit a value the store rejects, failing the persist AFTER the run has billed. (A
  // property with NO enum against an enum column is deliberately NOT rejected here: the value may still be
  // bounded by the agent's instructions, and forcing an enum on every such property would be over-strict —
  // that residual is a runtime fail-closed case, documented rather than blocked at deploy.)
  for (const column of store.columns) {
    if (column.enum === undefined) continue;
    const propName = propNameForColumn(column.name);
    if (propName === undefined) continue; // coverage is handled above; nothing maps here
    const propSchema = props[propName];
    const propEnum =
      typeof propSchema === 'object' && propSchema !== null
        ? (propSchema as { enum?: unknown }).enum
        : undefined;
    if (!Array.isArray(propEnum)) continue; // no property enum → the documented runtime-fail-closed residual
    const allowed = new Set<string>(column.enum);
    // A member outside the whitelist — OR a non-string member (the enum column stores text) — is invalid.
    const offenders = propEnum.filter((v) => typeof v !== 'string' || !allowed.has(v));
    if (offenders.length > 0) {
      out.push(
        specError(
          'schema_violation',
          `${refLabel} persists to store '${persistTo}': output property '${propName}' enum includes ` +
            `${offenders.map((v) => JSON.stringify(v)).join('/')}, outside store column '${column.name}' ` +
            'enum whitelist — the store rejects an out-of-whitelist value fail-closed at runtime. Constrain ' +
            "the property's enum to a subset of the column's whitelist",
          `${pathPrefix}.persistTo`,
        ),
      );
    }
  }
  return out;
}

/** The full semantic pass. Input is already shape-valid (post-Zod-parse). */
export function lintSpec(spec: RaySpec): SpecError[] {
  const errors: SpecError[] = [];

  // ---- ID/NAME SETS (built once; reused by the cross-ref checks) ------------------------
  const storeNames = new Set(spec.stores.map((s) => s.name));
  // name -> store, so a business-key FK (`referencesColumn`) can resolve its referenced column in the
  // TARGET store (unique + type-match validation below).
  const storeByName = new Map(spec.stores.map((s) => [s.name, s]));
  // id -> agent, so an action's `persistTo` can resolve the referenced agent's outputSchema and check
  // it maps to the target store's columns.
  const agentById = new Map(spec.agents.map((a) => [a.id, a]));
  const agentIds = new Set(spec.agents.map((a) => a.id));
  const toolIds = new Set(spec.tooling.map((t) => t.id));
  // handlers indexed by id -> kind, so a ref can also assert the handler is the RIGHT kind.
  const handlerKindById = new Map(spec.handlers.map((h) => [h.id, h.kind]));

  // ---- 2. DUPLICATES (within each section) ----------------------------------------------
  errors.push(
    ...findDuplicates(
      spec.stores,
      (s) => s.name,
      'store name',
      (i) => `stores[${i}].name`,
    ),
    ...findDuplicates(
      spec.agents,
      (a) => a.id,
      'agent id',
      (i) => `agents[${i}].id`,
    ),
    ...findDuplicates(
      spec.tooling,
      (t) => t.id,
      'tooling id',
      (i) => `tooling[${i}].id`,
    ),
    // Tool NAME (not just id): dispatchTool keys its registry by `t.spec.name` (dispatch.ts), so
    // two tools sharing a name silently collide at runtime — one handler is lost. Reject at config.
    ...findDuplicates(
      spec.tooling,
      (t) => t.name,
      'tooling name',
      (i) => `tooling[${i}].name`,
    ),
    ...findDuplicates(
      spec.handlers,
      (h) => h.id,
      'handler id',
      (i) => `handlers[${i}].id`,
    ),
    ...findDuplicates(
      spec.triggers,
      (t) => t.name,
      'trigger name',
      (i) => `triggers[${i}].name`,
    ),
    // API route uniqueness: a duplicate `${method} ${path}` would register two handlers on one
    // route — the second silently shadows the first. Reject at config.
    ...findDuplicates(
      spec.api,
      (r) => `${r.method} ${r.path}`,
      'api route',
      (i) => `api[${i}].path`,
    ),
  );

  // ---- 1 & 5. CROSS-REFS + KIND COHERENCE -----------------------------------------------

  // stores: column uniqueness + reserved-name guard + FK resolution + FK on-delete coherence.
  spec.stores.forEach((store, si) => {
    // (6) Duplicate column names within this store.
    errors.push(
      ...findDuplicates(
        store.columns,
        (c) => c.name,
        'store column',
        (i) => `stores[${si}].columns[${i}].name`,
      ),
    );

    // A column -> column map (used by the FK column-resolution + 'set null' coherence check below).
    const columnByName = new Map(store.columns.map((c) => [c.name, c]));

    // (9) Reserved (injected) column names — a business column may not shadow a tenancy/GDPR column.
    store.columns.forEach((col, ci) => {
      if (RESERVED_COLUMN_NAMES.has(col.name)) {
        errors.push(
          specError(
            'reserved_column_name',
            `store '${store.name}' declares reserved column '${col.name}' — that column is injected ` +
              'by the generator (tenancy/GDPR); rename the business column',
            `stores[${si}].columns[${ci}].name`,
          ),
        );
      } else if (RESERVED_QUERY_KEYWORDS.has(col.name)) {
        // A column named after a list-query control keyword would be un-filterable AND would emit
        // a duplicate OpenAPI query parameter — reject at config with an explaining rename hint.
        errors.push(
          specError(
            'reserved_query_keyword',
            `store '${store.name}' declares column '${col.name}', which collides with a reserved ` +
              'list-query control keyword (order/after/limit/search/__search) the declarative list route ' +
              'uses for sorting/keyset pagination/substring/full-text search — the column would be ' +
              'un-filterable and would emit a duplicate OpenAPI query parameter; rename the business column',
            `stores[${si}].columns[${ci}].name`,
          ),
        );
      }
      // (enum) An `enum` whitelist is a TEXT-column value constraint the platform enforces server-side
      // (store-validation derives a `z.enum` → an out-of-whitelist create/update value is a 400). The
      // grammar already pins a non-empty array of non-empty members; the lint adds the two facts Zod
      // cannot express here: (a) it belongs ONLY on a text column; (b) the members are DISTINCT.
      if (col.enum !== undefined) {
        if (col.type !== 'text') {
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' column '${col.name}' declares an enum whitelist but is type ` +
                `'${col.type}' — enum is only valid on a 'text' column`,
              `stores[${si}].columns[${ci}].enum`,
            ),
          );
        }
        const seenValues = new Set<string>();
        for (const value of col.enum) {
          if (seenValues.has(value)) {
            errors.push(
              specError(
                'schema_violation',
                `store '${store.name}' column '${col.name}' enum has a duplicate value ` +
                  `'${value}' — enum members must be distinct`,
                `stores[${si}].columns[${ci}].enum`,
              ),
            );
            break; // one report per column is enough (the author fixes the list in one pass)
          }
          seenValues.add(value);
        }
      }
    });

    // (FTS) A store that opts into full-text search MUST declare at least one `text` column — the
    // generated tsvector is built over the store's text columns, so a text-less FTS store would index
    // nothing (fail-closed rather than materialize a useless empty-vector column). It also may not
    // declare a business column named `search_vector` (FTS_COLUMN_NAME), the reserved name the generator
    // injects for the GENERATED-ALWAYS tsvector column when full-text search is enabled.
    if (store.fullTextSearch === true) {
      if (!store.columns.some((c) => c.type === 'text')) {
        errors.push(
          specError(
            'schema_violation',
            `store '${store.name}' enables fullTextSearch but declares no 'text' column — the ` +
              'generated full-text-search vector would index nothing; add a text column or remove ' +
              'fullTextSearch',
            `stores[${si}].fullTextSearch`,
          ),
        );
      }
      const clashIndex = store.columns.findIndex((c) => c.name === FTS_COLUMN_NAME);
      if (clashIndex >= 0) {
        errors.push(
          specError(
            'reserved_column_name',
            `store '${store.name}' declares column '${FTS_COLUMN_NAME}', which is reserved for the ` +
              'generated tsvector column the generator injects when fullTextSearch is enabled; rename ' +
              'the business column',
            `stores[${si}].columns[${clashIndex}].name`,
          ),
        );
      }
    }

    store.foreignKeys.forEach((fk, fi) => {
      // (FK-NAME-LEN) The generated Postgres constraint name is a TOTAL function of
      // `(table, column, references, refCol)` — `<table>_<column>_<references>_<refCol>_fk` — mirroring
      // `fkConstraintName` in @rayspec/db, the single source of truth (kept in sync by this comment; the
      // db layer cannot be imported here — @rayspec/db depends on @rayspec/spec, so the reverse edge
      // would cycle). Each identifier is individually ≤ MAX_IDENTIFIER_LENGTH (SafeIdentifier), but their
      // CONCATENATION is not, and Postgres SILENTLY TRUNCATES an ADD CONSTRAINT name past 63 bytes. A
      // truncated name (a) breaks the store-route 23503 UPDATE discriminator, which matches the reported
      // `constraint_name` EXACTLY against this full computed name to tell an own-FK bad-INPUT update (400)
      // apart from a child-restrict conflict (409) — a truncation is a missed match → a wrongful 409; and
      // (b) can truncate-COLLIDE two distinct long FK names into one real DDL conflict. Reject it at config
      // time so the emitted name is never truncated (fail-closed at the source).
      const refCol = fk.referencesColumn ?? 'id';
      const constraintName = `${store.name}_${fk.column}_${fk.references}_${refCol}_fk`;
      if (constraintName.length > MAX_IDENTIFIER_LENGTH) {
        errors.push(
          specError(
            'schema_violation',
            `store '${store.name}' foreign key on column '${fk.column}' generates the constraint name ` +
              `'${constraintName}' (${constraintName.length} chars), which exceeds the ` +
              `${MAX_IDENTIFIER_LENGTH}-char Postgres identifier limit — Postgres would SILENTLY TRUNCATE ` +
              'it (breaking the update-conflict 400-vs-409 discriminator and risking a name collision). ' +
              'Use shorter identifiers for the store name, the FK column, the referenced store, or the ' +
              'referenced column',
            `stores[${si}].foreignKeys[${fi}].column`,
          ),
        );
      }
      if (!storeNames.has(fk.references)) {
        errors.push(
          specError(
            'dangling_ref',
            `store '${store.name}' foreign key references unknown store '${fk.references}'`,
            `stores[${si}].foreignKeys[${fi}].references`,
          ),
        );
      }
      const fkColumn = columnByName.get(fk.column);
      if (fkColumn === undefined) {
        errors.push(
          specError(
            'dangling_ref',
            `store '${store.name}' foreign key column '${fk.column}' is not a declared column`,
            `stores[${si}].foreignKeys[${fi}].column`,
          ),
        );
      } else if (fk.referencesColumn === undefined) {
        // ID-TARGET FK (default): the local column references the parent's injected uuid PK (`id`), so
        // it MUST be declared `type:'uuid'` (GEN-1). A non-uuid FK column diverges the generators (the
        // TS generator forces uuid() while the SQL generator emits the author type) and yields an
        // unappliable migration — reject it at config time.
        if (fkColumn.type !== 'uuid') {
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' foreign key column '${fk.column}' is type '${fkColumn.type}' but ` +
                "must be 'uuid' (it references the parent store's injected uuid primary key)",
              `stores[${si}].foreignKeys[${fi}].column`,
            ),
          );
        }
        if (fk.onDelete === 'set null' && fkColumn.nullable === false) {
          // (8) ON DELETE SET NULL requires a NULLABLE column — otherwise the DDL is self-contradictory.
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' foreign key on column '${fk.column}' uses onDelete:'set null' but ` +
                'the column is NOT NULL — make it nullable or change the on-delete policy',
              `stores[${si}].foreignKeys[${fi}].onDelete`,
            ),
          );
        }
      } else {
        // BUSINESS-KEY FK: the local column references a NAMED unique column of the target store — a
        // TENANT-SCOPED COMPOUND FK `(tenant_id, col) -> parent(tenant_id, refcol)`.
        //
        // (a) onDelete:'set null' is IMPOSSIBLE on a compound FK — it would have to null `tenant_id`,
        //     which is NOT NULL by construction. A business-key FK supports 'cascade' or 'restrict' only.
        if (fk.onDelete === 'set null') {
          errors.push(
            specError(
              'schema_violation',
              `store '${store.name}' foreign key on column '${fk.column}' uses onDelete:'set null' with ` +
                'referencesColumn — a business-key FK is a tenant-scoped compound key and cannot null ' +
                "tenant_id; use onDelete:'cascade' or 'restrict'",
              `stores[${si}].foreignKeys[${fi}].onDelete`,
            ),
          );
        }
        // (b) Resolve the referenced column in the TARGET store (skip when the target store is dangling —
        //     the dangling_ref above already reports that).
        const targetStore = storeByName.get(fk.references);
        if (targetStore !== undefined) {
          const targetCol = targetStore.columns.find((c) => c.name === fk.referencesColumn);
          if (targetCol === undefined) {
            errors.push(
              specError(
                'dangling_ref',
                `store '${store.name}' foreign key referencesColumn '${fk.referencesColumn}' is not a ` +
                  `declared column of the referenced store '${fk.references}'`,
                `stores[${si}].foreignKeys[${fi}].referencesColumn`,
              ),
            );
          } else {
            // (c) A FK can only reference a UNIQUE column (Postgres requires a matching unique index).
            if (targetCol.unique !== true) {
              errors.push(
                specError(
                  'schema_violation',
                  `store '${store.name}' foreign key referencesColumn ` +
                    `'${fk.references}.${fk.referencesColumn}' must be declared 'unique: true' — a ` +
                    'foreign key can only reference a unique column',
                  `stores[${si}].foreignKeys[${fi}].referencesColumn`,
                ),
              );
            }
            // (d) The local FK column's type MUST match the referenced column's type (relaxes the
            //     uuid-only GEN-1 rule for a non-id target — a slug FK is text, a code FK is integer, …).
            if (fkColumn.type !== targetCol.type) {
              errors.push(
                specError(
                  'schema_violation',
                  `store '${store.name}' foreign key column '${fk.column}' is type '${fkColumn.type}' but ` +
                    `references '${fk.references}.${fk.referencesColumn}' of type '${targetCol.type}' — ` +
                    "an FK column's type must match its referenced column",
                  `stores[${si}].foreignKeys[${fi}].column`,
                ),
              );
            }
          }
        }
      }
    });

    // (TEN-3) Two store columns whose names camelCase to the SAME JS identifier would collide as
    // duplicate keys in the generated TS table object (e.g. `foo_bar` and `fooBar` both -> fooBar).
    // The safe-identifier grammar narrows the input, but `_`-vs-camel ambiguity remains — reject it.
    errors.push(
      ...findDuplicates(
        store.columns,
        (c) => toJsIdentifier(c.name),
        'store column camelCase identifier',
        (i) => `stores[${si}].columns[${i}].name`,
      ),
    );
  });

  // (TEN-3) Two STORE names that camelCase to the same const identifier collide as duplicate consts
  // in the generated product-schema module (e.g. `audit_log` and `auditLog` both -> auditLog).
  errors.push(
    ...findDuplicates(
      spec.stores,
      (s) => toJsIdentifier(s.name),
      'store camelCase identifier',
      (i) => `stores[${i}].name`,
    ),
  );

  // FK CYCLE — a circular foreign-key reference (A→B, B→A, directly or transitively) is UNORDERABLE:
  // no CREATE order lets every store's FK ADD find its parent table already present, so it fails at
  // apply (42P01). Reject it fail-closed at config time (the generator's topoSortStoresByFk throws on
  // the same condition — this is the config-level gate so it never reaches apply). Self-references and
  // references to an unknown store (already `dangling_ref`) are excluded from the graph.
  const fkCycle = findFkCycle(spec.stores);
  if (fkCycle !== null) {
    const si = spec.stores.findIndex((s) => s.name === fkCycle[0]);
    errors.push(
      specError(
        'fk_cycle',
        `stores form a circular foreign-key reference (${fkCycle.join(' -> ')}) — a circular FK is ` +
          "unorderable (each store's FK ADD needs its parent table created first) and cannot be " +
          'applied; break the cycle (make one side nullable and add it in a separate migration)',
        si >= 0 ? `stores[${si}].foreignKeys` : undefined,
      ),
    );
  }

  // tooling[].handler -> a declared handler of kind 'tool'.
  spec.tooling.forEach((tool, ti) => {
    const kind = handlerKindById.get(tool.handler);
    if (kind === undefined) {
      errors.push(
        specError(
          'dangling_ref',
          `tool '${tool.id}' references unknown handler '${tool.handler}'`,
          `tooling[${ti}].handler`,
        ),
      );
    } else if (kind !== 'tool') {
      errors.push(
        specError(
          'dangling_ref',
          `tool '${tool.id}' references handler '${tool.handler}' of kind '${kind}', expected 'tool'`,
          `tooling[${ti}].handler`,
        ),
      );
    }
  });

  // agents[].tools[] -> declared tooling ids.
  spec.agents.forEach((agent, ai) => {
    agent.tools.forEach((toolId, tidx) => {
      if (!toolIds.has(toolId)) {
        errors.push(
          specError(
            'dangling_ref',
            `agent '${agent.id}' references unknown tool '${toolId}'`,
            `agents[${ai}].tools[${tidx}]`,
          ),
        );
      }
    });
  });

  // api[].action.* -> declared store/agent/handler/stream (handler must be kind 'route').
  spec.api.forEach((route, ri) => {
    const action = route.action;
    if (action.kind === 'store') {
      if (!storeNames.has(action.store)) {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} references unknown store '${action.store}'`,
            `api[${ri}].action.store`,
          ),
        );
      }
    } else if (action.kind === 'agent') {
      if (!agentIds.has(action.agent)) {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} references unknown agent '${action.agent}'`,
            `api[${ri}].action.agent`,
          ),
        );
      }
      if (action.persistTo !== undefined) {
        errors.push(
          ...checkPersistTo(
            action.persistTo,
            action.agent,
            storeByName,
            agentById,
            `api[${ri}].action`,
            `route ${route.method} ${route.path}`,
          ),
        );
      }
    } else {
      // handler OR stream action — both resolve `action.handler` against a declared `route`-kind
      // handler (a stream handler dispatches through the api chokepoint, like a `{handler}` route —
      // the ingest/playback `mode` is a runtime concern, not a handler kind). The shared
      // resolution below covers both kinds.
      const kind = handlerKindById.get(action.handler);
      if (kind === undefined) {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} references unknown handler '${action.handler}'`,
            `api[${ri}].action.handler`,
          ),
        );
      } else if (kind !== 'route') {
        errors.push(
          specError(
            'dangling_ref',
            `route ${route.method} ${route.path} handler '${action.handler}' is kind '${kind}', expected 'route'`,
            `api[${ri}].action.handler`,
          ),
        );
      }
    }
  });

  // ---- frontend[] static mounts — route COLLISIONS (fail-closed) -------------------------------
  // A declared static frontend mount is served alongside the API (composition-root / serve-static.ts).
  // Its `route` must not collide with (a) another mount, (b) a declared `api[].path` (one would shadow
  // the other), or (c) a reserved system prefix (`/v1`, `/health`, `/oidc` — platform-owned). Root `/`
  // is EXEMPT: it never equals an api path nor nests under a reserved prefix, and a static-last `/` mount
  // legitimately coexists with `/v1/*` (registration order + a static miss fall-through).
  const apiRoutePaths = new Set(spec.api.map((r) => r.path));
  const seenFrontendRoutes = new Set<string>();
  (spec.frontend ?? []).forEach((mount, fi) => {
    const route = mount.route;
    // (a) DUPLICATE mount route.
    if (seenFrontendRoutes.has(route)) {
      errors.push(
        specError(
          'frontend_route_collision',
          `duplicate frontend route '${route}' (each frontend mount route must be unique)`,
          `frontend[${fi}].route`,
        ),
      );
    } else {
      seenFrontendRoutes.add(route);
    }
    // (b) EXACTLY equals a declared api route path — a static mount and an api route cannot share a path.
    if (apiRoutePaths.has(route)) {
      errors.push(
        specError(
          'frontend_route_collision',
          `frontend route '${route}' collides with a declared api route path — a static mount and an ` +
            'api route cannot share a path; choose a different frontend route',
          `frontend[${fi}].route`,
        ),
      );
    }
    // (c) EQUALS or NESTS UNDER a reserved system prefix (root `/` is exempt — it matches neither).
    if (RESERVED_ROUTE_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`))) {
      errors.push(
        specError(
          'frontend_route_collision',
          `frontend route '${route}' is reserved for the platform (${RESERVED_ROUTE_PREFIXES.join(
            ', ',
          )}); choose a different route`,
          `frontend[${fi}].route`,
        ),
      );
    }
  });

  // ---- extensions[] DUPLICATE ids (cross-ref/merge resolution lands in `loadExtensions`) ----------------
  // The `loadExtensions` merge keys packs by `id`; two refs sharing an id would silently
  // collide (one pack lost). Reject at config time — symmetric with the other section dup checks.
  errors.push(
    ...findDuplicates(
      spec.extensions,
      (e) => e.id,
      'extension id',
      (i) => `extensions[${i}].id`,
    ),
  );

  // triggers[].action.* -> declared agent/handler (handler must be kind 'trigger'); kind->field.
  spec.triggers.forEach((trigger, ti) => {
    const action = trigger.action;
    if (action.kind === 'agent') {
      if (!agentIds.has(action.agent)) {
        errors.push(
          specError(
            'dangling_ref',
            `trigger '${trigger.name}' references unknown agent '${action.agent}'`,
            `triggers[${ti}].action.agent`,
          ),
        );
      }
      if (action.persistTo !== undefined) {
        errors.push(
          ...checkPersistTo(
            action.persistTo,
            action.agent,
            storeByName,
            agentById,
            `triggers[${ti}].action`,
            `trigger '${trigger.name}'`,
          ),
        );
      }
    } else {
      const kind = handlerKindById.get(action.handler);
      if (kind === undefined) {
        errors.push(
          specError(
            'dangling_ref',
            `trigger '${trigger.name}' references unknown handler '${action.handler}'`,
            `triggers[${ti}].action.handler`,
          ),
        );
      } else if (kind !== 'trigger') {
        errors.push(
          specError(
            'dangling_ref',
            `trigger '${trigger.name}' handler '${action.handler}' is kind '${kind}', expected 'trigger'`,
            `triggers[${ti}].action.handler`,
          ),
        );
      }
    }
    // kind -> required field coherence (cron needs schedule; event needs event).
    if (trigger.kind === 'cron' && trigger.schedule === undefined) {
      errors.push(
        specError(
          'schema_violation',
          `cron trigger '${trigger.name}' is missing 'schedule'`,
          `triggers[${ti}].schedule`,
        ),
      );
    }
    // A cron trigger is FIRED by the durable off-request worker. Without
    // `deployment.durableWorker:true` no worker is wired, so the cron would be SILENTLY not scheduled
    // (it never fires — no error at deploy, just nothing at 2am). Reject at config time: a declared
    // cron REQUIRES the durable worker. (Defense-in-depth: composition-root ALSO boot-aborts if a cron
    // is registered with no worker wired — see deployDeclaredSpec.)
    if (trigger.kind === 'cron' && spec.deployment?.durableWorker !== true) {
      errors.push(
        specError(
          'schema_violation',
          `cron trigger '${trigger.name}' requires 'deployment.durableWorker: true' — a cron is fired ` +
            'by the durable off-request worker; without it the trigger would never fire (silently ' +
            'unscheduled). Set deployment.durableWorker:true or remove the cron trigger',
          `triggers[${ti}].kind`,
        ),
      );
    }
    // A manual trigger is FIRED on demand through the SAME durable off-request worker (its exactly-once
    // reserve→dispatch machinery). Without `deployment.durableWorker:true` no worker is wired, so an
    // explicit fire could never dispatch — the trigger would be declared but un-fireable. Reject at
    // config time: a declared manual trigger REQUIRES the durable worker. (Defense-in-depth: the
    // composition-root boot ALSO aborts if a fireable trigger is registered with no worker wired.)
    if (trigger.kind === 'manual' && spec.deployment?.durableWorker !== true) {
      errors.push(
        specError(
          'schema_violation',
          `manual trigger '${trigger.name}' requires 'deployment.durableWorker: true' — a manual ` +
            'trigger is fired on demand through the durable off-request worker; without it the trigger ' +
            'could never dispatch. Set deployment.durableWorker:true or remove the manual trigger',
          `triggers[${ti}].kind`,
        ),
      );
    }
    if (trigger.kind === 'event' && trigger.event === undefined) {
      errors.push(
        specError(
          'schema_violation',
          `event trigger '${trigger.name}' is missing 'event'`,
          `triggers[${ti}].event`,
        ),
      );
    }
    // `catchUp` is a CRON-ONLY opt-in (missed-interval make-up work is meaningful only for a
    // scheduled trigger). It is fail-closed-rejected for ANY presence (even `false`) on a
    // non-cron trigger — a webhook/event/manual trigger declaring catchUp is a coherence error,
    // never silently ignored, so the author fixes the spec rather than shipping a dead field.
    if (trigger.catchUp !== undefined && trigger.kind !== 'cron') {
      errors.push(
        specError(
          'schema_violation',
          `trigger '${trigger.name}' declares 'catchUp' but kind is '${trigger.kind}' — catchUp is ` +
            "valid ONLY for 'cron' triggers (it opts a scheduled trigger into replaying intervals " +
            'missed while the worker was down). Remove catchUp or change the trigger to kind:cron',
          `triggers[${ti}].catchUp`,
        ),
      );
    }
  });

  // ---- 3. CAPABILITY (every agent through core validateSpec) -----------------------------
  spec.agents.forEach((agent, ai) => {
    // A synthetic neutral AgentSpec for capability validation. `input` is a runtime value the
    // config omits, so we supply a placeholder ('') — validateSpec ignores input, it inspects
    // outputSchema + tools against the backend's capabilities. Tools are referenced by id in the
    // config; capability validation only needs to know whether the agent uses ANY tools (the
    // backend must be tool-capable), so we attach lightweight neutral ToolSpecs for the resolved
    // tool ids. Cross-ref resolution above already flags an unknown tool id; here we only build
    // capability input from the ids that resolve.
    const resolvedToolSpecs = agent.tools
      .filter((id) => toolIds.has(id))
      .map((id) => {
        const t = spec.tooling.find((tool) => tool.id === id);
        return {
          name: t?.name ?? id,
          description: t?.description ?? '',
          parameters: (t?.parameters ?? {}) as Record<string, unknown>,
        };
      });
    const synthetic: AgentSpec = {
      name: agent.name,
      instructions: agent.instructions,
      model: agent.model,
      input: '',
      tools: resolvedToolSpecs,
      maxTurns: agent.maxTurns,
      ...(agent.outputSchema ? { outputSchema: agent.outputSchema } : {}),
    };
    const res = validateSpec(synthetic, agent.backend as BackendId, {
      requireNativeStructuredOutput: agent.requireNativeStructuredOutput,
    });
    if (!res.ok) {
      for (const v of res.violations) {
        errors.push(
          specError(
            'capability_violation',
            `agent '${agent.id}' (backend '${agent.backend}'): ${v.message}`,
            `agents[${ai}].backend`,
          ),
        );
      }
    }
  });

  // ---- 4. EMBEDDED SCHEMAS COMPILE (tool parameters/outputSchema + agent outputSchema.schema) --
  // One Ajv instance for the whole pass. strict:false so a tool schema using vendor keywords or
  // draft-mixing does not hard-fail compilation (matches dispatch.ts) — a STRUCTURALLY malformed
  // schema still throws (verified: {type:'not-a-type'} / non-array required / non-object schema).
  const ajv = new Ajv2020Ctor({ allErrors: true, strict: false });

  /** Compile an embedded JSON-Schema; push `invalid_embedded_schema` on a compile throw. */
  const compileEmbedded = (schema: unknown, label: string, path: string): void => {
    try {
      ajv.compile(schema as Record<string, unknown>);
    } catch (e) {
      errors.push(
        specError(
          'invalid_embedded_schema',
          `${label} is a malformed JSON-Schema: ${String(e instanceof Error ? e.message : e)}`,
          path,
        ),
      );
    }
  };

  spec.tooling.forEach((tool, ti) => {
    compileEmbedded(tool.parameters, `tool '${tool.id}' 'parameters'`, `tooling[${ti}].parameters`);
    // (7) Tool args must be an OBJECT schema — all 3 backends require object-typed tool args. A
    // compilable-but-non-object `parameters` (e.g. type:'string', or no type) is a config error.
    const params = tool.parameters as { type?: unknown };
    if (params.type !== 'object') {
      errors.push(
        specError(
          'schema_violation',
          `tool '${tool.id}' 'parameters' must be an object JSON-Schema (type:'object'); ` +
            `got type:${JSON.stringify(params.type)}`,
          `tooling[${ti}].parameters`,
        ),
      );
    }
    if (tool.outputSchema) {
      compileEmbedded(
        tool.outputSchema,
        `tool '${tool.id}' 'outputSchema'`,
        `tooling[${ti}].outputSchema`,
      );
    }
  });

  // (3) An agent's structured-output schema is also embedded JSON-Schema — compile it too, so a
  // malformed agent output schema fails at config time rather than reaching the backend.
  spec.agents.forEach((agent, ai) => {
    if (agent.outputSchema) {
      compileEmbedded(
        agent.outputSchema.schema,
        `agent '${agent.id}' 'outputSchema.schema'`,
        `agents[${ai}].outputSchema.schema`,
      );
    }
  });

  return errors;
}

/**
 * The NON-FATAL semantic-warning pass — advisory findings that do NOT fail a parse (unlike `lintSpec`).
 * Pure over an already-shape-valid `RaySpec`. `doctor`/`plan` surface these alongside the `ok` result so
 * an author sees a documented interaction without being blocked.
 *
 * Today it flags ONE interaction: a `softDelete` store that is the TARGET of a `restrict` foreign key —
 * EITHER an id-target FK (referencing the parent's injected `id`) OR a business-key FK
 * (`referencesColumn`). Both carry the identical footgun: soft-deleting such a parent is an
 * `UPDATE(deleted_at)` that does NOT fire the database ON DELETE restrict, so the referencing rows keep
 * pointing at the (tombstoned) parent — the restrict guarantee only binds on a HARD delete. This is a
 * permitted, documented interaction, so it is a WARNING, not a fail-closed error.
 */
export function lintSpecWarnings(spec: RaySpec): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  spec.stores.forEach((store, si) => {
    if (store.softDelete !== true) return;
    for (const other of spec.stores) {
      for (const fk of other.foreignKeys) {
        // Fire for ANY restrict FK onto this softDelete parent — id-target OR business-key. A soft
        // delete is an UPDATE(deleted_at), which does NOT fire ON DELETE restrict on either FK shape.
        if (fk.references === store.name && fk.onDelete === 'restrict') {
          const fkDesc =
            fk.referencesColumn !== undefined
              ? `business-key foreign key from '${other.name}.${fk.column}' (referencesColumn ` +
                `'${fk.referencesColumn}')`
              : `foreign key from '${other.name}.${fk.column}' (references '${store.name}.id')`;
          warnings.push(
            specWarning(
              'softdelete_fk_restrict',
              `store '${store.name}' is softDelete AND is the target of a restrict ${fkDesc} — ` +
                `soft-deleting a referenced '${store.name}' row is an UPDATE that does NOT fire the ` +
                `database ON DELETE restrict, so '${other.name}' rows keep pointing at the tombstoned ` +
                'parent; the restrict guarantee only binds on a hard delete',
              `stores[${si}].softDelete`,
            ),
          );
        }
      }
    }
  });

  // FK FORWARD-REFERENCE — a store whose FK references a store declared LATER in the array. The
  // product-SQL generator topo-sorts stores so the parent table is created before the child's FK is
  // added, so a forward reference still APPLIES cleanly; this advisory just tells the author the declared
  // order relies on that reordering (a true cycle is the fail-closed `fk_cycle` error, never a warning).
  const storeIndexByName = new Map(spec.stores.map((s, i) => [s.name, i]));
  spec.stores.forEach((store, si) => {
    store.foreignKeys.forEach((fk, fi) => {
      if (fk.references === store.name) return; // self-FK applies after this table's own CREATE
      const parentIndex = storeIndexByName.get(fk.references);
      if (parentIndex === undefined || parentIndex <= si) return; // unknown (dangling) or already-before
      warnings.push(
        specWarning(
          'fk_forward_reference',
          `store '${store.name}' declares a foreign key referencing '${fk.references}', which is ` +
            'declared LATER in the stores list — the generator reorders stores so the parent table is ' +
            `created first (it applies cleanly); declare '${fk.references}' before '${store.name}' to ` +
            'make the dependency order explicit',
          `stores[${si}].foreignKeys[${fi}]`,
        ),
      );
    });
  });

  return warnings;
}
