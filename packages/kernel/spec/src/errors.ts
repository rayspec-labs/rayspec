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
 *                               (wrong type, missing required field, bad enum value, …). ALSO emitted
 *                               by the lint pass, for an `api[].rateLimit.windowSeconds`/`max` that is
 *                               not a whole positive number (a safe integer greater than zero). Inside
 *                               `parseSpec` the grammar rejects those first, so that restatement is
 *                               defence in depth; it reports when `lintSpec` is run directly over a
 *                               spec value assembled in code rather than parsed.
 *  - `unknown_field`          — a `.strict()` unknown-key rejection (fail-closed: any extra key).
 *  - `reserved_document_key`  — the raw document carries a mapping key literally named `__proto__`
 *                               (anywhere, on either profile). It is refused by a scan over the
 *                               LOADED YAML rather than by the grammar, because no grammar rule can
 *                               report on it: `yaml` makes it a genuine own property, and where the
 *                               grammar reads the level the shape validator skips it by name in both
 *                               its readers — the strict unknown-key walk and the record branch —
 *                               without raising an issue, so the key is dropped and what was written
 *                               under it did nothing (a `project.rename` under that key renamed
 *                               nothing; a view field under it vanished). Inside a free-form
 *                               `z.unknown()` slot (a tool's `parameters`, a `contracts` body) the
 *                               level is not inspected at all, so there the key is NOT dropped — it
 *                               survives the parse and is emitted into the API contract, unreported.
 *                               Only `__proto__`: `constructor`/`prototype` survive validation as
 *                               ordinary keys and stay legal. Applies to a KEY only — a store
 *                               column named `__proto__` is a value and is still served.
 *  - `dangling_ref`          — a cross-reference points at an id/name that is not declared.
 *  - `duplicate_name`         — two entries in one section share an id/name.
 *  - `capability_violation`   — an agent demands a capability its chosen backend lacks
 *                               (via core `validateSpec`; e.g. native structured output on pi).
 *  - `invalid_embedded_schema`— an embedded JSON-Schema (tool `parameters`/`outputSchema`,
 *                               agent `outputSchema.schema`) failed to compile through Ajv2020.
 *  - `reserved_column_name`   — a store declares a business column whose name collides with a
 *                               tenancy/GDPR column the table generator injects (`id`,
 *                               `tenant_id`, `created_at`, `deleted_at`, `retention_days`,
 *                               `region`) — fail-closed against a shadow/tenancy collision.
 *  - `reserved_query_keyword` — a store declares a business column whose name is one of the
 *                               list-query CONTROL keywords (`order`, `after`, `limit`). Those keys
 *                               steer the declarative `list` route's sorting + keyset pagination, so a
 *                               column of that name would be silently un-equality-filterable AND would
 *                               emit a DUPLICATE OpenAPI query parameter (control param + per-column
 *                               filter param, same name+location) → an invalid OpenAPI 3.1 document.
 *                               Rename the business column.
 *  - `reserved_store_name`    — a declared store (or a product artifact `collection`, which derives a
 *                               store of that name) is named after a core/global PLATFORM table
 *                               (`runs`, `sessions`, `invites`, `orgs`, … — the tenant-scoped core set
 *                               plus the identity/auth cluster). Its `CREATE TABLE` would collide with
 *                               the platform's own table, and the boot registrar refuses to admit it
 *                               fail-closed (`@rayspec/db` composition, check 5), so the deployment
 *                               would never come up. Rename the store.
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
 *  - `agent_output_schema_shortcircuits_tools`
 *                             — an agent declares BOTH a non-empty `tools` list AND an `outputSchema`.
 *                               A backend with NATIVE structured output (`openai`, `anthropic`, `codex`)
 *                               projects the schema into that slot; the backend that EMULATES it through
 *                               instructions (`pi`) appends a JSON-only directive that pulls the answer
 *                               the same way. Either way the model answers in ONE turn and never calls a
 *                               tool — a lookup/persist loop silently never fires. Rejected UNIFORMLY,
 *                               fail-closed, on every backend (not per capability). The structured shape
 *                               belongs on the persist tool's `parameters`.
 *  - `projection_unknown_column` — a store-route response projection (`project`) member addresses
 *                               no column on the response: a `rename` key that names no declared
 *                               business / injected column, a `rename` of a column the projection
 *                               itself removes from the response (dead config — `omitInjected`
 *                               dropped it with no `fields` re-include, or the `fields` allowlist
 *                               excludes its wire name), or a `fields` entry matching no
 *                               post-casing/rename wire name (fields are matched AFTER the rename/
 *                               casing steps, so an author snake name no longer matches a re-cased
 *                               column).
 *  - `projection_collision`   — a response projection maps two exposed columns to the SAME wire
 *                               field name (a rename target colliding with another column's wire
 *                               name, or two snake names whose camelCase twins coincide under
 *                               `casing: camel`, e.g. `a_1`/`a1`). Post-projection field names must
 *                               be unique — one response key cannot carry two columns.
 *  - `projection_query_shadow`— a response projection `rename` target equals the AUTHOR name of
 *                               ANOTHER column of the same store. The list-query surface stays
 *                               author-named (filters/order/operator params address declared column
 *                               names), so a response field named after a different real column
 *                               would actively mislead callers (`?x=` filters the real `x` column
 *                               while the response field `x` carries another). A rename to a FRESH
 *                               wire name (e.g. `id` → `companionId`) is allowed and produces the
 *                               documented request/response naming split.
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
 *  - `experimental_section_disabled` — the document declares an EXPERIMENTAL section (`workforce:`)
 *                               and this entry point did not opt in. Fail-closed by DEFAULT: every
 *                               caller of `parseSpec` that has not decided rejects, so the section
 *                               can never leak into a surface that has not chosen to carry it.
 *  - `invalid_orchestrator`   — the workforce `orchestrator` violates the entry-point rules: the
 *                               named employee does not hold role `orchestrator`, a second employee
 *                               holds it, or the orchestrator declares `reportsTo` (the chain roots
 *                               AT the orchestrator).
 *  - `invalid_manager`        — a department `manager` holds neither role `manager` nor the
 *                               workforce `orchestrator` seat.
 *  - `manager_in_members`     — a department manager is also listed in its own `members` (a manager
 *                               answers FOR the department, never inside it).
 *  - `department_mismatch`    — employee↔department membership incoherence: an employee's declared
 *                               `department` does not list them (and they are not its manager), or a
 *                               department member's own `department` field names a different one.
 *  - `reporting_cycle`        — the EFFECTIVE reporting graph (explicit `reportsTo`, else the
 *                               declared department's manager) contains a cycle (self included).
 *  - `orphan_employee`        — an employee whose effective reporting chain never reaches the
 *                               orchestrator (or a non-orchestrator with no effective superior).
 *  - `invalid_reviewer`       — a review policy's `reviewer` holds neither role `reviewer` nor
 *                               role `manager`.
 *  - `budget_widening`        — a department budget out-rates the workforce ceiling that contains
 *                               it (per-hour-normalized: hourly=1h, daily=24h, weekly=168h — child
 *                               ceilings are only ever tighter, never wider).
 *  - `reserved_workforce_id`  — the workforce id is one of the kernel's reserved path segments, or
 *                               an employee id is `user` (the human-owner sentinel every task-owner
 *                               column and the redeploy gate reserve).
 *  - `reserved_tool_name`     — an agent a workforce employee runs declares a tool named after a
 *                               NATIVE workforce tool. Natives are injected by role at dispatch and
 *                               always win; a colliding declared tool would be silently shadowed,
 *                               so it is refused up front.
 *  - `workforce_label_unheld` — a review or approval rule's `requireWhen.labels` names a policy
 *                               label NO declared employee holds, so THAT CLAUSE can never fire:
 *                               labels match by exact equality against `employees[].labels` and
 *                               every holder is declared in the SAME document, so the only way one
 *                               arrives is a redeploy, which re-runs this lint. What the dead
 *                               clause costs depends on the rule. An approval rule's `requireWhen`
 *                               is `{ labels }` alone, so the rule dies and work that should park
 *                               for a human silently would not; a review rule naming only `labels`
 *                               dies the same way. A review rule that ALSO names `confidenceBelow`
 *                               keeps firing — the selectors are OR'd — but only via the branch the
 *                               submitting turn writes for itself, so the rule is silently
 *                               downgraded from a control to a heuristic. All three are refused;
 *                               the message names which case the author is in. Advisory until the
 *                               pre-freeze review, on the false premise that a label may arrive
 *                               later.
 *  - `multiple_workforces`    — the document spells `workforce:` as a LIST, or carries a plural
 *                               `workforces:` key. Exactly zero or one workforce may be declared
 *                               (D-010) and `workforce:` is a single mapping. Raised on the RAW
 *                               document before the shape parse, so the author gets the named rule
 *                               instead of a generic `unknown_field` / "expected object, received
 *                               array". Two literal `workforce:` keys stay `yaml_parse_error` —
 *                               YAML's own uniqueness refusal, not re-coded here.
 */
export const SpecErrorCode = z.enum([
  'yaml_parse_error',
  'unsupported_version',
  'schema_violation',
  'unknown_field',
  'reserved_document_key',
  'dangling_ref',
  'duplicate_name',
  'capability_violation',
  'invalid_embedded_schema',
  'reserved_column_name',
  'reserved_query_keyword',
  'reserved_store_name',
  'frontend_route_collision',
  'frontend_dir_missing',
  'fk_cycle',
  'agent_output_schema_shortcircuits_tools',
  'projection_unknown_column',
  'projection_collision',
  'projection_query_shadow',
  'no_code_in_yaml',
  'provider_native_leak',
  'invalid_capability_status',
  'invalid_contract',
  'prompt_execution_claim',
  'production_execution_claim',
  'invalid_dependency_order',
  'invalid_view',
  'invalid_store',
  'experimental_section_disabled',
  'invalid_orchestrator',
  'invalid_manager',
  'manager_in_members',
  'department_mismatch',
  'reporting_cycle',
  'orphan_employee',
  'invalid_reviewer',
  'budget_widening',
  'reserved_workforce_id',
  'reserved_tool_name',
  'workforce_label_unheld',
  'multiple_workforces',
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
 *  - `typescript_handler_module` — a `handlers[].module` path whose extension is TypeScript source
 *                               (`.ts`/`.tsx`/`.mts`/`.cts`). The production handler loader refuses
 *                               such a module fail-closed at boot (it loads compiled JavaScript only),
 *                               so the document needs a build step before it is deployed. It is
 *                               ADVISORY rather than fail-closed because authoring against TypeScript
 *                               source is the documented loop: the dev loader takes un-built source
 *                               through an explicit opt-in, and a build step compiles the modules and
 *                               rewrites these `module:` paths on the way to a deploy.
 *  - `stream_playback_media_token` — an `api[]` route whose action is `{kind:'stream', mode:'playback'}`.
 *                               Such a route mounts its OWN middleware tuple and is authenticated by a
 *                               signed `?token=` media JWT, NOT by the Bearer/tenant chain every other
 *                               route mounts on — so a Bearer token alone reads nothing there. The media
 *                               token is minted through `init.mintPlayToken`, a capability only a
 *                               `{kind:'handler'}` route's handler receives, so a deployment declaring no
 *                               route that mints one leaves the playback route unreachable WITHOUT an
 *                               externally issued token (the verifier authenticates a token on its
 *                               signature under the media signing key plus the pinned issuer/audience,
 *                               not on where it was minted). The advisory states that authorization
 *                               shape; it does NOT claim the mint route is missing, because the mint
 *                               call lives in handler module source and this pass is pure over the
 *                               parsed document.
 *  - `agent_untrusted_field_precedence` — an agent whose instructions NAME an unconstrained `text`
 *                               column of a declared store while stating no PRECEDENCE between it
 *                               and the structured fields, or without saying the stated rule is the
 *                               WHOLE rule. Both statements are asked for and the message names the
 *                               one that is missing: field precedence answers an ASSERTIVE attack and
 *                               a closed rule answers a POLICY one, so satisfying either alone leaves
 *                               the other class open. A `text` column declaring an `enum`
 *                               whitelist is excluded: its stored value must be one of the listed
 *                               literals, so it cannot carry an injected sentence — the one case
 *                               where the document itself rules the column out as a free-text
 *                               surface. The tool-dispatch boundary treats such content as data and
 *                               not as instructions, which stops an attack that COMMANDS ("ignore
 *                               your instructions") — it cannot stop one that instead ASSERTS a
 *                               different value for a structured field, or INVENTS a policy, because
 *                               both of those only inform the answer, which is what the boundary
 *                               permits. Closing them is the author's job in the instructions, and
 *                               the tool-dispatch trust boundary section of `docs/ARCHITECTURE.md`
 *                               documents the pattern. THE CHECK IS A KEYWORD HEURISTIC OVER
 *                               NATURAL LANGUAGE and is wrong in both directions by construction: it
 *                               looks for a small closed set of precedence words, so instructions
 *                               that state the rule in other words are flagged anyway (false
 *                               positive) and instructions that merely use one of those words are
 *                               not (false negative). It also cannot see whether the agent really
 *                               receives that row, nor in which DIRECTION it uses a named column —
 *                               an agent's `input` is a RUNTIME value and the handler that assembles
 *                               it lives in module source, which this pass does not read, so
 *                               instructions naming a column may equally describe what the agent
 *                               WRITES. The message therefore states only the two facts the DOCUMENT
 *                               carries — the column is unconstrained `text`, and the instructions
 *                               name it — and asserts nothing about it being input. Advisory for
 *                               exactly that reason: a heuristic over prose must never fail a deploy.
 *  - `cron_tenant_required`   — the document declares a `cron` or `manual` trigger. Both are fired by
 *                               the durable worker under ONE deployment tenant, read at boot from
 *                               `RAYSPEC_CRON_TENANT_ID` (an org id). That variable is not a document
 *                               field, so the requirement is invisible in the spec and an author who
 *                               does not know it meets it as a refused boot — this advisory states it
 *                               at authoring time instead. It is ADVISORY and necessarily so: whether
 *                               the variable is set belongs to the ENVIRONMENT, which this pass (pure
 *                               over the document) cannot read, so erroring would fail every valid
 *                               cron document including the ones that set it correctly. The org the
 *                               id names does NOT have to exist at boot — the scheduler starts and
 *                               skips each firing until it does — but the variable itself must be set.
 *  - `stale_suppression`      — a node's `lintSuppress` entry acknowledges an advisory code that no
 *                               longer fires on that node (`applyLintSuppressions`, lint.ts). The
 *                               acknowledgement has outlived its finding — the heuristic changed, or
 *                               the document did — so it is surfaced rather than silently kept: an
 *                               audit trail of "reviewed, not applicable" is only honest while the
 *                               finding it answers exists. It points at the suppression entry itself.
 *                               DELIBERATELY NOT SUPPRESSIBLE (see `SuppressibleWarningCode`): a rot
 *                               detector an author can acknowledge away detects nothing.
 */
export const SpecWarningCode = z.enum([
  'softdelete_fk_restrict',
  'fk_forward_reference',
  'typescript_handler_module',
  'stream_playback_media_token',
  'agent_untrusted_field_precedence',
  'cron_tenant_required',
  'stale_suppression',
]);
export type SpecWarningCode = z.infer<typeof SpecWarningCode>;

/**
 * The advisory codes a node's `lintSuppress` may acknowledge — every warning code EXCEPT
 * `stale_suppression`. Derived (never re-listed) so a new advisory code is suppressible by default
 * and the one exclusion stays visible here. `stale_suppression` is excluded because it reports on
 * the suppressions themselves: were it acknowledgeable, a rotted acknowledgement could be silenced
 * by one more acknowledgement, which is exactly the silent rot the code exists to prevent. Error
 * codes (`SpecErrorCode`) are structurally absent — a suppression can never name one, so
 * suppressing an error is not expressible at all (advisories only, fail-closed at parse).
 */
export const SuppressibleWarningCode = SpecWarningCode.exclude(['stale_suppression']);
export type SuppressibleWarningCode = z.infer<typeof SuppressibleWarningCode>;

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
 * One advisory moved out of `warnings` by a node's `lintSuppress` acknowledgement — the finding's
 * code + the author's recorded justification (`because`, verbatim from the suppression entry), with
 * the finding's own JSON path so a review can locate what was acknowledged. Visible in review,
 * quiet in the loop: `doctor` reports these in a `suppressed` array beside `warnings`, and they
 * never affect `ok` (exactly like the warnings they replace).
 */
export const SuppressedSpecWarning = z.object({
  code: SuppressibleWarningCode,
  because: z.string(),
  /** JSON path of the SUPPRESSED finding (e.g. `agents[0].instructions`); absent if it carried none. */
  path: z.string().optional(),
});
export type SuppressedSpecWarning = z.infer<typeof SuppressedSpecWarning>;

/**
 * The result of `parseSpec` — a discriminated `Result` so a caller MUST check `ok` before
 * touching `value` (the fail-closed contract: a spec with any violation yields `ok:false` and
 * the full violation list, never a partially-trusted value).
 */
export type Result<T, E> = { ok: true; value: T } | { ok: false; errors: E[] };
