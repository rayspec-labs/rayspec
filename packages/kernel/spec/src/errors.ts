/**
 * SpecError — the closed-code error envelope for the RaySpec config grammar.
 *
 * Mirrors the auth-core `ErrorCode`/`ErrorEnvelope` pattern (packages/auth-core/src/errors.ts):
 * a CLOSED Zod enum of codes + a flat `{ code, message, path? }` envelope. Closed-by-construction
 * so a fresh session reading a parse failure sees a finite, documented vocabulary — never a free
 * string. `parseSpec`/`lintSpec` aggregate the FULL list of violations (not the first), so an
 * author sees every problem in one pass.
 *
 * `path` is a JSON path into the spec (dot/bracket notation, e.g. `agents[0].backend`) so a
 * violation points at the exact offending node. It is absent for whole-document failures
 * (`yaml_parse_error`, `unsupported_version`) where no in-document path applies.
 */
import { z } from 'zod';

/**
 * The CLOSED set of spec-error codes. Every parse/lint failure carries exactly one of these.
 *
 *  - `yaml_parse_error`       — the raw text is not valid YAML (the `yaml` lib threw).
 *  - `unsupported_version`    — `version` is missing or not the supported literal ('1.0').
 *  - `schema_violation`       — a Zod shape failure that is not a pure unknown-key rejection
 *                               (wrong type, missing required field, bad enum value, …).
 *  - `unknown_field`          — a `.strict()` unknown-key rejection (fail-closed: any extra key).
 *  - `dangling_ref`          — a cross-reference points at an id/name that is not declared.
 *  - `duplicate_name`         — two entries in one section share an id/name.
 *  - `capability_violation`   — an agent demands a capability its chosen backend lacks
 *                               (via core `validateSpec`; e.g. native structured output on pi).
 *  - `invalid_embedded_schema`— an embedded JSON-Schema (tool `parameters`/`outputSchema`,
 *                               agent `outputSchema.schema`) failed to compile through Ajv2020.
 *  - `reserved_column_name`   — a store declares a business column whose name collides with a
 *                               tenancy/GDPR column the Slice-1 generator injects (`id`,
 *                               `tenant_id`, `created_at`, `deleted_at`, `retention_days`,
 *                               `region`) — fail-closed against a shadow/tenancy collision.
 *  - `reserved_query_keyword` — a store declares a business column whose name is one of the
 *                               list-query CONTROL keywords (`order`, `after`, `limit`). Those keys
 *                               steer the declarative `list` route's sorting + keyset pagination, so a
 *                               column of that name would be silently un-equality-filterable AND would
 *                               emit a DUPLICATE OpenAPI query parameter (control param + per-column
 *                               filter param, same name+location) → an invalid OpenAPI 3.1 document.
 *                               Rename the business column.
 *  - `frontend_route_collision` — a declared static frontend mount's `route` collides with another
 *                               mount, with a declared `api[].path`, or with a reserved system prefix
 *                               (`/v1`, `/health`, `/oidc`) — the static mount would either shadow or be
 *                               shadowed by that route. Root `/` is exempt (it coexists with `/v1/*` via
 *                               registration order). Rename the frontend route.
 *  - `frontend_dir_missing`   — a declared frontend `dir` does not resolve to a readable directory of
 *                               built assets (surfaced by `doctor`, which checks the filesystem).
 *  - `fk_cycle`               — the declared stores form a CIRCULAR foreign-key reference (store A
 *                               references B and B references A, directly or transitively). Such a set is
 *                               UNORDERABLE: each store's FK ADD needs its parent table to already exist,
 *                               so no CREATE order satisfies every FK. Rejected fail-closed at config time
 *                               rather than surfacing as a cryptic `42P01 relation does not exist` at
 *                               apply. Self-references are EXEMPT (a self-FK applies after its own CREATE).
 *
 * PRODUCT-YAML codes — used ONLY by the Product-YAML validation path (`parseProductSpec`,
 * `product-lint.ts`). They share this closed envelope so a fresh session sees ONE error vocabulary
 * across both document families; the RaySpec path never emits them.
 *  - `no_code_in_yaml`        — a code/handler/SQL/shell key or an inline-code string value appears
 *                               in a Product-YAML doc: implementation belongs in Tier A/B, not
 *                               in product meaning. The message names what the offending key should be.
 *  - `provider_native_leak`   — a provider-native wire blob (raw request/response payload) or a
 *                               provider/model policy field / provider name leaked into the executable
 *                               `workflows`/`agents` graph (which must stay provider-neutral so it
 *                               compiles through the workflow bridge). Provider policy is only allowed
 *                               in `capabilities[].provider_policy` / `deployment_overrides`.
 *  - `invalid_capability_status` — RESERVED (closed-code discipline). The earlier doc-level
 *                               rejection of `status:'available'` was retired (the Tier B
 *                               runtime is wired now); capability WIREDNESS is enforced at the deploy
 *                               composition (fail-closed `unsupported_spec`), not by the parser.
 *  - `invalid_contract`       — a `contracts[]` schema uses a key/type outside the closed, declarative
 *                               JSON-Schema-like vocabulary (no functions/transforms/computed
 *                               expressions/provider-native shapes).
 *  - `prompt_execution_claim` — a Product-YAML `workflows`/`agents` graph STRING claims prompt/LLM
 *                               EXECUTION (`llm call`, `agent call`, `prompt execution`, `execute
 *                               prompt`). Mirrors the workflow-bridge's `prompt_execution_claim` so a
 *                               doc that validates here also compiles through the bridge (anti-drift;
 *                               parity-tested). Prompt/agent execution is a Tier-B runtime concern.
 *  - `production_execution_claim` — a graph STRING claims production EXECUTION (`production_ready`,
 *                               `production execution`, `prod runtime`). Mirrors the bridge's
 *                               `production_execution_claim` (parity-tested): a product doc declares
 *                               meaning, not that it EXECUTES in production.
 *  - `invalid_dependency_order` — a workflow step's `depends_on` references a step that is NOT declared
 *                               before it (a forward/self reference). Declaration-order is required, which
 *                               structurally forbids dependency CYCLES (a cycle needs a forward edge).
 *  - `invalid_view`           — a view declaration violates the view semantics (product-views-lint):
 *                               a source/contract conflation (a source ref that names a
 *                               contract instead of a store/artifact/capability contract), a read/shape
 *                               context violation (page fields outside `list` mode, group outside `collect`,
 *                               …), incomplete param coverage, a shape that does not conform to its declared
 *                               response contract, a reserved (`__proto__`-class) name, or a pagination law
 *                               violation. Every mis-declared view construct is rejected — never skipped.
 *  - `invalid_store`          — a declared product store / store-step declaration violates the store
 *                               semantics: a store name colliding with a
 *                               derived collection store, a column name on the graph key denylist (it could
 *                               never be referenced from a workflow step), a key naming an undeclared or
 *                               nullable column, a store step targeting an undeclared store, a filter/values
 *                               column outside the store's declared columns, a write omitting the conflict-
 *                               key column, or store vocabulary on a non-store step type. Fail-closed.
 */
export const SpecErrorCode = z.enum([
  'yaml_parse_error',
  'unsupported_version',
  'schema_violation',
  'unknown_field',
  'dangling_ref',
  'duplicate_name',
  'capability_violation',
  'invalid_embedded_schema',
  'reserved_column_name',
  'reserved_query_keyword',
  'frontend_route_collision',
  'frontend_dir_missing',
  'fk_cycle',
  'no_code_in_yaml',
  'provider_native_leak',
  'invalid_capability_status',
  'invalid_contract',
  'prompt_execution_claim',
  'production_execution_claim',
  'invalid_dependency_order',
  'invalid_view',
  'invalid_store',
]);
export type SpecErrorCode = z.infer<typeof SpecErrorCode>;

/** A single fail-closed spec violation (closed code + message + optional JSON path). */
export const SpecError = z.object({
  code: SpecErrorCode,
  message: z.string(),
  /** JSON path into the spec document (e.g. `agents[0].backend`); absent for whole-doc failures. */
  path: z.string().optional(),
});
export type SpecError = z.infer<typeof SpecError>;

/** Construct a SpecError (path omitted when undefined so the envelope stays minimal). */
export function specError(code: SpecErrorCode, message: string, path?: string): SpecError {
  return path !== undefined ? { code, message, path } : { code, message };
}

/**
 * The CLOSED set of NON-FATAL spec-warning codes. A warning flags a documented, deliberately-permitted
 * interaction the author should be AWARE of — it does NOT fail `doctor`/`plan` (unlike a `SpecError`).
 * Kept a distinct closed vocabulary from `SpecErrorCode` so a fresh session never confuses "advisory"
 * with "fail-closed".
 *
 *  - `softdelete_fk_restrict` — a `softDelete` store is the TARGET of a `restrict` business-key
 *                               (`referencesColumn`) foreign key. Soft-deleting such a parent is an
 *                               `UPDATE(deleted_at)` that does NOT fire the database ON DELETE restrict,
 *                               so children keep pointing at the tombstoned row — the restrict guarantee
 *                               only binds on a HARD delete. This is a permitted, documented interaction.
 *  - `fk_forward_reference`   — a store declares a foreign key onto another store declared LATER in the
 *                               `stores` array. The product-SQL generator topo-sorts stores so the parent
 *                               table is created before the child's FK is added, so a forward reference
 *                               still applies cleanly; this advisory notes only that the declared order
 *                               relies on that reordering (declaring the parent first makes it explicit).
 *                               Acyclic by construction — a true cycle is the fail-closed `fk_cycle`
 *                               error, never a warning.
 */
export const SpecWarningCode = z.enum(['softdelete_fk_restrict', 'fk_forward_reference']);
export type SpecWarningCode = z.infer<typeof SpecWarningCode>;

/** A single NON-FATAL spec warning (closed code + message + optional JSON path). Never fails a parse. */
export const SpecWarning = z.object({
  code: SpecWarningCode,
  message: z.string(),
  /** JSON path into the spec document (e.g. `stores[0].softDelete`); absent for whole-doc warnings. */
  path: z.string().optional(),
});
export type SpecWarning = z.infer<typeof SpecWarning>;

/** Construct a SpecWarning (path omitted when undefined so the envelope stays minimal). */
export function specWarning(code: SpecWarningCode, message: string, path?: string): SpecWarning {
  return path !== undefined ? { code, message, path } : { code, message };
}

/**
 * The result of `parseSpec` — a discriminated `Result` so a caller MUST check `ok` before
 * touching `value` (the fail-closed contract: a spec with any violation yields `ok:false` and
 * the full violation list, never a partially-trusted value).
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; errors: E[] };
