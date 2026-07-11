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
 * The result of `parseSpec` — a discriminated `Result` so a caller MUST check `ok` before
 * touching `value` (the fail-closed contract: a spec with any violation yields `ok:false` and
 * the full violation list, never a partially-trusted value).
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; errors: E[] };
