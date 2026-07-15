/**
 * The Product-YAML grammar — `ProductSpec` and its sections.
 *
 * A Product-YAML document declares PRODUCT MEANING ONLY (Tier C — the Product-YAML
 * program): product identity, required Tier-B capabilities, product-owned artifact kinds + response
 * contracts, declarative TYPED PRODUCT STORES (data shape, never handlers/SQL),
 * declarative agent EXTRACTION contracts, workflow COMPOSITION over Tier A/B primitives, grounding
 * policy, and declarative view/read contracts. It is a DIFFERENT document family from `RaySpec`
 * (grammar.ts): its `extractors` are extraction contracts (not backend/model/instructions wrappers),
 * and it deliberately has NO `handlers`/`tooling`/`api` — the whole point is that NO product-owned backend
 * code lives here (that belongs in Tier A/B). The minimal typed `stores` section below reuses the
 * backend column vocabulary so the derived output stays a standard `StoreSpec`. The two
 * profiles share ONE `version:'1.0'` key and are told apart by the presence of the `product:`
 * section (the archetype discriminant) at the parse/deploy/CLI layer (`detect.ts`); the backend
 * profile (`RaySpec`) IS the internal engine target and its shape stays byte-unchanged.
 *
 * ENFORCEMENT POINT: this module IS the real, fail-closed parser for the product profile — the closed
 * grammar is enforced here (an unknown key is rejected — see below), not merely described. The product
 * profile carries the unified production version literal `'1.0'` (the product profile of one language).
 *
 * FAIL-CLOSED BY CONSTRUCTION: every object level is `.strict()` (an unknown key is rejected — no
 * silent passthrough, mirroring grammar.ts). The `contracts[]` values are INTENTIONALLY open
 * records (they ARE JSON-Schema-like payloads) — their CLOSED vocabulary is enforced separately
 * by `product-lint.ts`, exactly as `RaySpec` validates a tool's `parameters` via ajv in lint
 * rather than by strict-key rejection.
 *
 * BRIDGE ALIGNMENT: the `workflows`/`extractors` shapes here are FIELD-COMPATIBLE
 * with `ProductYamlBridgeInput` (`@rayspec/product-yaml-workflow-bridge`) — same key names (workflows:
 * id/trigger{capability,event,scope}/steps[]{id,type,use,inputs,outputs,depends_on,on_error,retry}; and
 * the extractor extraction contract) — so a validated `ProductSpec` feeds the real bridge compiler unchanged.
 *
 * REPRESENTABLE: only string/literal/enum/array/record/object/boolean/number types are used, so
 * `z.toJSONSchema` (export.ts `exportProductJsonSchema`) exports it without throwing.
 */
import { z } from 'zod';
// Reuse the SAME safe-identifier rule + the SAME store-column vocabulary as the RaySpec grammar
// (grammar.ts stays byte-unchanged; these are IMPORTS, not modifications) so a product id / artifact
// kind / declared store column is rejected the same way backend store/column names are — and so a derived
// product store is a standard `StoreSpec` the whole backend store machinery (generateProductSql /
// diffProductStores / drift / classify / the update seam) consumes UNCHANGED.
import { SafeIdentifier, SPEC_VERSION, StoreColumn } from './grammar.js';
// The view read+projection vocabulary — a SEPARATE module so this file's diff
// stays minimal. See product-views.ts for the design laws.
import { ViewConditionalRead, ViewParamSpec, ViewRead } from './product-views.js';

// One language, one version constant: the product profile and the backend profile share the single
// `SPEC_VERSION` ('1.0') from grammar.ts. The top-level dispatch key is `version` (the same literal as
// the backend profile); the two profiles are told apart by the presence of the required `product:`
// section (the archetype discriminant — see detect.ts). Parsed FIRST (two-phase, `product-parse.ts`)
// so an unknown version fails cleanly with `unsupported_version` instead of a wall of strict errors.

// ---------------------------------------------------------------------------------------
// product — identity + metadata (product meaning boundary; NOT a tenant id / route prefix)
// ---------------------------------------------------------------------------------------

export const ProductIdentity = z
  .object({
    /** Stable safe identifier (e.g. `acme_notes`) — same safe-identifier rule as store/column names. */
    id: SafeIdentifier,
    name: z.string().min(1),
    description: z.string().optional(),
    /** Human ownership metadata (free-form small strings). */
    owners: z.array(z.string().min(1)).optional(),
    /** Small string metadata — NOT runtime behavior. */
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type ProductIdentity = z.infer<typeof ProductIdentity>;

// ---------------------------------------------------------------------------------------
// requires — the capability ids the product depends on (each must resolve to capabilities[].id)
// ---------------------------------------------------------------------------------------

export const RequiresSpec = z
  .object({
    capabilities: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type RequiresSpec = z.infer<typeof RequiresSpec>;

// ---------------------------------------------------------------------------------------
// capabilities[] — product REFERENCES to Tier B contracts (declaration, not implementation)
// ---------------------------------------------------------------------------------------

/** Reusable Tier B capability references are tier `B` (the draft's only allowed tier). */
export const CapabilityTier = z.enum(['B']);
export type CapabilityTier = z.infer<typeof CapabilityTier>;

/**
 * A capability's runtime availability. All three statuses are shape-valid: `available`
 * declares the capability is runtime-backed; `reserved`/`not_yet_runtime` declare a future
 * dependency. WIREDNESS is enforced at the deploy composition, not here — a MOUNT rejects any
 * capability that is not `available` + actually runtime-backed (fail-closed, section named), while
 * `doctor`/`plan` (validate-only) accept all three (the frozen donor stays valid).
 */
export const CapabilityStatus = z.enum(['reserved', 'not_yet_runtime', 'available']);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

/**
 * Narrow, DECLARATIVE provider policy (draft): provider/model SELECTION by policy — NOT a
 * provider-native request/response blob. Allowed ONLY here (on a capability) and in
 * `deployment_overrides`; product-lint rejects provider policy that leaks into `workflows`/`extractors`.
 */
export const ProviderPolicy = z
  .object({
    default_provider: z.string().min(1).optional(),
    default_model: z.string().min(1).optional(),
    adapter_visibility: z.enum(['internal', 'public']).optional(),
  })
  .strict();
export type ProviderPolicy = z.infer<typeof ProviderPolicy>;

/**
 * OPTIONAL declarative INPUT-NORMALIZE step for a submit-ingress capability (default OFF). When
 * declared, a submitted record is transformed by the named agent AFTER shape-validation and BEFORE
 * persist — the NORMALIZED value is what is re-validated, stored, and emitted. ABSENT ⇒ behaviour is
 * byte-identical to today (a capability that does not declare it is completely unaffected). The agent
 * runs through the platform's neutral agent-invocation path (the deployment wires a normalizer for the
 * declared `agent` id — the config-side wiring precedent); the model output must conform to
 * `output_contract`. Fail-closed: a normalize failure REJECTS the submit and persists nothing.
 */
export const CapabilityInputNormalize = z
  .object({
    /**
     * The config-side agent id that normalizes the submitted record (same safe-identifier discipline as
     * every sibling id). It is a stable label the deployment binds a normalizer to — NOT a declared
     * `extractors[]` id (an input-normalize step is the record-ingress equivalent of the config-side
     * responder, wired at deploy, not a workflow-graph extractor).
     */
    agent: SafeIdentifier,
    /**
     * The declared contract id the NORMALIZED record must conform to before persist (product-lint
     * resolves it against `contracts[]` / a declared capability contract, exactly like an
     * `artifacts[].contract` ref). The runtime uses it as the agent's expected output shape.
     */
    output_contract: z.string().min(1),
  })
  .strict();
export type CapabilityInputNormalize = z.infer<typeof CapabilityInputNormalize>;

export const CapabilitySpec = z
  .object({
    id: z.string().min(1),
    tier: CapabilityTier,
    status: CapabilityStatus,
    /** Named input/output contracts the capability provides (contract ids). */
    contracts: z.array(z.string().min(1)).default([]),
    provider_policy: ProviderPolicy.optional(),
    /** Non-normative explanation (may mention providers — this is NOT the executable graph). */
    runtime_notes: z.string().optional(),
    /** OPTIONAL declarative input-normalize step (default OFF — see CapabilityInputNormalize). */
    input_normalize: CapabilityInputNormalize.optional(),
  })
  .strict();
export type CapabilitySpec = z.infer<typeof CapabilitySpec>;

// ---------------------------------------------------------------------------------------
// artifacts[] — product-owned meaning + output contracts
// ---------------------------------------------------------------------------------------

export const ArtifactProvenance = z
  .object({
    /** Source artifact/span contract id (e.g. `stt.transcript_span`). */
    source: z.string().min(1).optional(),
    /** The candidate field carrying evidence span ids. */
    evidence_field: z.string().min(1).optional(),
    /**
     * OPT-IN quote-text verification (default OFF). Names a STRING property of this artifact's
     * `contract` that carries a VERBATIM quote. When declared, grounding additionally requires that
     * quote to be a token-run subset of the TEXT of at least one of the member's cited, in-closed-set
     * spans (per-span, never the concatenation — see grounding-runtime). ABSENT ⇒ behaviour is
     * byte-identical to id-only closed-set grounding (the default-off invariant: a product that does
     * NOT declare a quote_field is completely unaffected). The consequence of an unsupported quote is
     * `grounding.on_unquoted_claim` (default `'ignore'` = advisory). Compose-time, a declared
     * quote_field must name a string property of the contract (fail-closed; product-lint `dangling_ref`).
     * Coupling note: a product with paraphrasing extractors opts in only by declaring a `quote_field`
     * plus an `on_unquoted_claim` mode; until it declares one it is unaffected and never enforces
     * quote-text — so enabling this feature cannot retroactively break an existing deployed product.
     */
    quote_field: z.string().min(1).optional(),
    required: z.boolean().optional(),
  })
  .strict();
export type ArtifactProvenance = z.infer<typeof ArtifactProvenance>;

export const ArtifactLifecycle = z
  .object({
    persist: z.boolean().optional(),
    preserve_human_edits: z.boolean().optional(),
    reconcile_stale_rows: z.boolean().optional(),
  })
  .strict();
export type ArtifactLifecycle = z.infer<typeof ArtifactLifecycle>;

export const ArtifactSpec = z
  .object({
    /** Safe identifier (e.g. `decision`) — same rule as store/column names. */
    kind: SafeIdentifier,
    label: z.string().min(1).optional(),
    /** Contract id for the artifact payload (product-lint resolves it against `contracts`). */
    contract: z.string().min(1),
    /** Object scope such as `session`. */
    scope: z.string().min(1).optional(),
    collection: z.string().min(1).optional(),
    provenance: ArtifactProvenance.optional(),
    lifecycle: ArtifactLifecycle.optional(),
  })
  .strict();
export type ArtifactSpec = z.infer<typeof ArtifactSpec>;

// ---------------------------------------------------------------------------------------
// contracts — named dictionary of reusable product-local JSON-Schema-like contracts
// ---------------------------------------------------------------------------------------

/**
 * `contracts` maps a contract id to a JSON-Schema-like payload. INTENTIONALLY an OPEN record at the
 * grammar level (like a `RaySpec` tool's `parameters` — a free-form schema slot): its CLOSED
 * declarative vocabulary (allowed keys: type/description/properties/items/required/enum/
 * additional_properties/nullable/ref; allowed types: object/array/string/number/integer/boolean/null;
 * FORBIDDEN: functions/transforms/computed expressions/provider-native shapes) is enforced by
 * `product-lint.ts` (`invalid_contract`), which walks each contract schema against the allowlist.
 */
export const ContractsSpec = z.record(z.string(), z.record(z.string(), z.unknown()));
export type ContractsSpec = z.infer<typeof ContractsSpec>;

// ---------------------------------------------------------------------------------------
// extractors[] — declarative EXTRACTION contracts (NOT RaySpec backend/model/instructions agents)
// Field-compatible with the bridge's ProductYamlAgentDeclaration. Each extractor declares a runtime
// `agent.<id>` operation (the byte-identity runtime namespace) — the section is `extractors`, the
// runtime operation it registers is `agent.<id>`.
// ---------------------------------------------------------------------------------------

export const AgentArtifactInput = z
  .object({
    name: z.string().min(1),
    ref: z.string().min(1),
    kind: z.string().min(1),
    required: z.boolean().optional(),
    source_step_id: z.string().min(1).optional(),
  })
  .strict();
export type AgentArtifactInput = z.infer<typeof AgentArtifactInput>;

export const AgentArtifactOutput = z
  .object({
    name: z.string().min(1),
    ref: z.string().min(1),
    kind: z.string().min(1),
    schema_ref: z.string().min(1).optional(),
    materialization_target: z.string().min(1).optional(),
  })
  .strict();
export type AgentArtifactOutput = z.infer<typeof AgentArtifactOutput>;

export const RequiredOutputShape = z
  .object({
    schema_ref: z.string().min(1),
    required_paths: z.array(z.string().min(1)).optional(),
    additional_properties: z.boolean().optional(),
  })
  .strict();
export type RequiredOutputShape = z.infer<typeof RequiredOutputShape>;

export const AcceptanceBoundary = z
  .object({
    type: z.literal('validation_node'),
    /** Tier-B validation/grounding operations the candidate must clear (e.g. grounding.check). */
    requires: z.array(z.string().min(1)).min(1),
    closed_source_artifacts: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type AcceptanceBoundary = z.infer<typeof AcceptanceBoundary>;

export const ArtifactMaterialization = z
  .object({
    target: z.literal('typed_artifact_ref'),
    persist_via: z.string().min(1).optional(),
    handle_ref: z.string().min(1).optional(),
  })
  .strict();
export type ArtifactMaterialization = z.infer<typeof ArtifactMaterialization>;

export const AgentExtraction = z
  .object({
    /** Stable extraction intent (e.g. `note_extraction`). */
    intent: z.string().min(1),
    input_artifacts: z.array(AgentArtifactInput).default([]),
    output_artifacts: z.array(AgentArtifactOutput).default([]),
    required_output_shape: RequiredOutputShape,
    acceptance_boundary: AcceptanceBoundary,
    materialization: ArtifactMaterialization,
  })
  .strict();
export type AgentExtraction = z.infer<typeof AgentExtraction>;

export const ExtractorSpec = z
  .object({
    /**
     * Stable safe identifier (e.g. `note_extractor`) — the SAME SafeIdentifier
     * discipline as every sibling id (product id / artifact kind / store name+key / store-step ids).
     * SECURITY: the extractor id flows UNSANITIZED into the per-agent
     * extractor-config PATH (`resolveExtractorConfigPath` → `<specDir>/extraction/<id>.extractor.json`),
     * so a `..`/`/` id would escape the extraction dir under `path.resolve`. Constraining it here closes
     * that source at parse; `resolveExtractorConfigPath` adds a belt-and-suspenders traversal jail.
     */
    id: SafeIdentifier,
    purpose: z.string().min(1),
    extraction: AgentExtraction,
    /** Declarative extraction LIMITS — plain text, NOT executable instructions. */
    extraction_constraints: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type ExtractorSpec = z.infer<typeof ExtractorSpec>;

// ---------------------------------------------------------------------------------------
// stores[] — declared TYPED product stores
// ---------------------------------------------------------------------------------------

/**
 * A declared product store: the MINIMAL typed data declaration the store_read/store_write step
 * runtime targets, and the backing for store-sourced views. DESIGN LAWS:
 *  - the columns are EXACTLY the backend `StoreColumn` vocabulary (imported from grammar.ts, which stays
 *    byte-frozen), so the DERIVED output (`deriveProductStores`) is a standard `StoreSpec` and the
 *    whole existing store machinery — `generateProductSql` (tenancy/GDPR injection), `diffProductStores`,
 *    drift/classify, the update seam, `eraseTenant` — consumes declared stores UNCHANGED;
 *  - authors declare BUSINESS columns only; the tenancy/GDPR columns (`id`/`tenant_id`/`created_at`/
 *    `deleted_at`/`retention_days`/`region`) are INJECTED downstream exactly like collection stores get
 *    them (declaring one is rejected by lint, `reserved_column_name`);
 *  - `key` is the REQUIRED conflict/idempotency identity: the durable engine's at-least-once law
 *    re-executes a mid-crash node, so EVERY store_write is an UPSERT on this declared key (C10 — never
 *    insert-and-recover; an in-tx unique-violation would poison the whole run transaction). It lives on
 *    the STORE (not the write step) because row identity is a property of the DATA — two write paths to
 *    one store must agree on one identity — and because the derivation must materialize the backing
 *    UNIQUE index (the key column derives `unique: true`). v1 admits EXACTLY ONE key column (the backend
 *    `StoreSpec` family has per-column uniques only — no composite/table-level unique vocabulary; a
 *    composite identity is composed into one column, the platform's `artifact_ref`/`track_ref` idiom);
 *  - deliberately NOT supported in v1 (honest scope): product-to-product foreign keys, composite keys,
 *    per-column defaults (the backend `StoreColumn` vocabulary carries none), non-tenant stores.
 */
export const ProductStoreSpec = z
  .object({
    /** The store name (same SafeIdentifier discipline as backend stores; lint rejects collisions with
     *  derived collection stores; the derivation rejects collisions with capability-owned stores). */
    name: SafeIdentifier,
    description: z.string().min(1).optional(),
    /** Business columns — EXACTLY the backend column vocabulary (name/type/nullable/unique). */
    columns: z.array(StoreColumn).min(1),
    /**
     * The REQUIRED conflict/idempotency key (see the design laws above): the declared column every
     * store_write upserts on. v1: exactly one column; it must be a declared, NON-nullable column
     * (lint-enforced) and derives `unique: true` (the backing index the upsert targets).
     */
    key: z
      .array(SafeIdentifier)
      .min(1)
      .max(
        1,
        'v1 supports exactly one conflict-key column (the backend StoreSpec family has no composite/' +
          'table-level unique vocabulary — compose a composite identity into one column, the ' +
          'artifact_ref/track_ref idiom; a multi-column key is a later spec-version decision)',
      ),
  })
  .strict();
export type ProductStoreSpec = z.infer<typeof ProductStoreSpec>;

// ---------------------------------------------------------------------------------------
// store step value sources (store_read filters / store_write values)
// ---------------------------------------------------------------------------------------

/** A value read from the TRIGGER EVENT payload (`payload[<event>]` — a scalar, fail-closed at run). */
export const StoreEventValue = z.object({ event: z.string().min(1) }).strict();
export type StoreEventValue = z.infer<typeof StoreEventValue>;

/**
 * A literal scalar. The FILTER variant excludes null (SQL equality on NULL never matches a row).
 *
 * ⚠ KNOWN LIMITATION (GLI-1 — INTENDED; do NOT "fix" by narrowing the guard): a `{const:}` literal
 * lives inside the `workflows` graph subtree, so the graph NEUTRALITY guardrails
 * (`scanProductGuardrails` — provider names, code-like tokens, handler/module paths,
 * production-/prompt-execution claims) scan it like every other graph string. A BUSINESS constant
 * that happens to contain such a token (e.g. a status text naming a provider, or `llm call`) is
 * therefore OVER-REJECTED fail-closed. This is the deliberate posture: the guard is trust-boundary-adjacent
 * and MUST NOT be weakened for literal convenience — rephrase the constant, or carry the value as
 * DATA through an `{event:}` / `{artifact:}` source instead of YAML meaning. Pinned by a lint test
 * (product-stores.test.ts GLI-1) so an accidental narrowing of the guard goes red.
 */
export const StoreFilterConstValue = z
  .object({ const: z.union([z.string(), z.number(), z.boolean()]) })
  .strict();
export type StoreFilterConstValue = z.infer<typeof StoreFilterConstValue>;

/** The write-variant literal (incl. null). The GLI-1 over-rejection note above applies here too. */
export const StoreWriteConstValue = z
  .object({ const: z.union([z.string(), z.number(), z.boolean(), z.null()]) })
  .strict();
export type StoreWriteConstValue = z.infer<typeof StoreWriteConstValue>;

/**
 * An UPSTREAM ARTIFACT value by its declared contract ref (last producer wins — the same resolution
 * every other node uses). Write-values only: it feeds a step's produced data (e.g. a store_read's
 * rows) into a written column; a whole artifact is not an equality-filter scalar.
 */
export const StoreArtifactValue = z.object({ artifact: z.string().min(1) }).strict();
export type StoreArtifactValue = z.infer<typeof StoreArtifactValue>;

/** store_read filter sources: event payload key or a non-null literal (EQUALITY-ONLY, see below). */
export const StoreFilterValue = z.union([StoreEventValue, StoreFilterConstValue]);
export type StoreFilterValue = z.infer<typeof StoreFilterValue>;

/** store_write value sources: event payload key, literal (incl. null), or an upstream artifact. */
export const StoreWriteValue = z.union([StoreEventValue, StoreWriteConstValue, StoreArtifactValue]);
export type StoreWriteValue = z.infer<typeof StoreWriteValue>;

/**
 * The store_read row cap: `limit` may not exceed this (shape-level), the node clamps to it
 * (defense-in-depth), and an omitted limit defaults to `STORE_READ_DEFAULT_LIMIT`. A step read is a
 * BOUNDED reference lookup feeding a workflow node — unbounded reads belong to paged views.
 */
export const STORE_READ_MAX_LIMIT = 1000;
export const STORE_READ_DEFAULT_LIMIT = 100;

// ---------------------------------------------------------------------------------------
// workflows[] — composition over Tier A/B primitives (field-compatible with the bridge)
// ---------------------------------------------------------------------------------------

/**
 * The closed set of workflow step types. `capability`/`agent`/`validation`/`artifact_persist`/
 * `artifact_read` are what the bridge compiles today; `store_read`/`store_write` are draft Tier-A
 * node types (validated statically here, compiled by later stages). An unknown/typo'd `type` is
 * fail-closed-rejected by this enum (the fail-open lesson: never silently drop a step; reject loudly).
 */
export const WorkflowStepType = z.enum([
  'capability',
  'agent',
  'validation',
  'artifact_persist',
  'artifact_read',
  'store_read',
  'store_write',
]);
export type WorkflowStepType = z.infer<typeof WorkflowStepType>;

/** Bounded failure policy a step may select (Tier A runtime executes it). */
export const WorkflowOnError = z.enum(['fail', 'retry', 'drop', 'quarantine']);
export type WorkflowOnError = z.infer<typeof WorkflowOnError>;

/** A BOUNDED retry policy — a positive attempt cap (no unbounded loops). */
export const WorkflowRetry = z
  .object({
    max_attempts: z.number().int().positive(),
  })
  .strict();
export type WorkflowRetry = z.infer<typeof WorkflowRetry>;

export const WorkflowStep = z
  .object({
    id: z.string().min(1),
    type: WorkflowStepType,
    /** `namespace.operation` (e.g. `stt.transcribe_session`, `agent.note_extractor`). */
    use: z.string().min(1),
    /** Named input contract refs (product-lint resolves them). */
    inputs: z.record(z.string(), z.string().min(1)).optional(),
    /** Named output contract refs (product-lint resolves them). */
    outputs: z.record(z.string(), z.string().min(1)).optional(),
    depends_on: z.array(z.string().min(1)).optional(),
    on_error: WorkflowOnError.optional(),
    retry: WorkflowRetry.optional(),
    // ── the store-step vocabulary — ADDITIVE, all optional. ──────
    // Lint enforces the per-type discipline fail-closed: store_read carries store (+ optional
    // filter/limit) and EXACTLY ONE output (the rows artifact); store_write carries store + values
    // (which MUST include the store's conflict-key column); every other step type carries NONE of
    // these. DELIBERATELY NOT SUPPORTED (honest v1 scope): comparison/range/LIKE/IN filters (the
    // HandlerDb facade is equality-only by design), joins, multi-store transactions, deletes/updates
    // (a store_write is an UPSERT on the declared key — the only re-run-safe write under the durable
    // engine's at-least-once law).
    /** The DECLARED target store (must resolve to `stores[].name` — never a derived/capability store). */
    store: SafeIdentifier.optional(),
    /** store_read: EQUALITY-ONLY column filters, AND-combined (column → event-payload key | literal). */
    filter: z.record(SafeIdentifier, StoreFilterValue).optional(),
    /** store_read: the row cap (defaults to STORE_READ_DEFAULT_LIMIT; shape-capped at the max). */
    limit: z.number().int().positive().max(STORE_READ_MAX_LIMIT).optional(),
    /** store_write: the written row (column → event key | literal | upstream artifact).
     *  NOTE: `{const:}` string literals here are graph strings — the neutrality guardrails scan
     *  them, and business constants containing provider names / code-like tokens are over-rejected
     *  fail-closed BY DESIGN (GLI-1 — see StoreFilterConstValue above; do not narrow the guard). */
    values: z.record(SafeIdentifier, StoreWriteValue).optional(),
  })
  .strict();
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowTrigger = z
  .object({
    /** The Tier-B capability whose event fires the workflow (product-lint resolves it). */
    capability: z.string().min(1),
    event: z.string().min(1),
    scope: z.string().min(1).optional(),
  })
  .strict();
export type WorkflowTrigger = z.infer<typeof WorkflowTrigger>;

export const ProductWorkflowSpec = z
  .object({
    id: z.string().min(1),
    trigger: WorkflowTrigger,
    steps: z.array(WorkflowStep).min(1),
  })
  .strict();
export type ProductWorkflowSpec = z.infer<typeof ProductWorkflowSpec>;

// ---------------------------------------------------------------------------------------
// grounding — product policy for evidence validation (mechanics are Tier B; policy is here)
// ---------------------------------------------------------------------------------------

export const AttributionPolicy = z
  .object({
    /** Track → speaker-role mapping (e.g. mic → local, system → remote). */
    tracks: z.record(z.string(), z.string().min(1)).optional(),
  })
  .strict();
export type AttributionPolicy = z.infer<typeof AttributionPolicy>;

export const GroundingSpec = z
  .object({
    require_source_spans: z.boolean().optional(),
    source_span_contract: z.string().min(1).optional(),
    /** Bounded policy for an invalid citation (Tier A runtime executes it). */
    on_invalid_citation: z.enum(['prune', 'drop', 'repair', 'fail']).optional(),
    /** Bounded policy for a candidate with no evidence. */
    on_empty_evidence: z.enum(['drop', 'prune', 'keep', 'fail']).optional(),
    /**
     * Bounded policy for an UNSUPPORTED quote — a member whose declared `provenance.quote_field`
     * value is NOT a verbatim token-run subset of any of its cited, in-closed-set spans. Only bites
     * artifacts that declare a `quote_field` (default-off otherwise). Default `'ignore'` (advisory:
     * the `unsupported_claim` finding is recorded but the member persists) — a product must opt into
     * `'prune'` (drop the unsupporting citations, then the `on_empty_evidence` machinery), `'drop'`
     * (drop the whole member), or `'fail'` (terminal). Mirrors the bounded-enum idiom of
     * `on_invalid_citation` / `on_empty_evidence`.
     */
    on_unquoted_claim: z.enum(['fail', 'prune', 'drop', 'ignore']).optional(),
    validation_capability: z.string().min(1).optional(),
    attribution_policy: AttributionPolicy.optional(),
  })
  .strict();
export type GroundingSpec = z.infer<typeof GroundingSpec>;

// ---------------------------------------------------------------------------------------
// views[] — declarative read/command contracts (NOT route handlers)
// ---------------------------------------------------------------------------------------

/** Views are reads plus a playback-token command — GET/POST only (a mutating verb implies a handler). */
export const ViewMethod = z.enum(['GET', 'POST']);
export type ViewMethod = z.infer<typeof ViewMethod>;

export const ViewRoute = z
  .object({
    method: ViewMethod,
    path: z.string().min(1),
  })
  .strict();
export type ViewRoute = z.infer<typeof ViewRoute>;

export const ViewSource = z
  .object({
    kind: z.enum(['artifact_query', 'capability', 'store']),
    /** Contract / capability id the view reads from (product-lint resolves it). */
    ref: z.string().min(1),
  })
  .strict();
export type ViewSource = z.infer<typeof ViewSource>;

export const ViewPagination = z
  .object({
    limit_param: z.string().min(1).optional(),
    offset_param: z.string().min(1).optional(),
    max_limit: z.number().int().positive().optional(),
    /**
     * The limit applied when the request omits/mis-shapes the limit param. The frozen
     * clamp law (the golden): a missing / non-integer / `< 1` limit clamps to THIS default (never
     * an empty page), `> max_limit` clamps to `max_limit`, a negative/malformed offset clamps to 0.
     * Defaults to `max_limit` when omitted. Lint rejects `default_limit > max_limit`.
     */
    default_limit: z.number().int().positive().optional(),
  })
  .strict();
export type ViewPagination = z.infer<typeof ViewPagination>;

/**
 * Response behavior for processing/absent data. The draft BANS `processing_200`; this enum omits it, so
 * it is fail-closed-rejected by construction (a bad-enum `schema_violation`). `not_ready_409` preserves
 * the playback-token readiness contract; `empty_200` is the empty-read-model shape.
 */
export const ViewAbsentState = z.enum(['empty_200', 'not_ready_409']);
export type ViewAbsentState = z.infer<typeof ViewAbsentState>;

/**
 * VERSION-DISCIPLINE NOTE: the view read+projection vocabulary below (`params`/`read`/
 * `conditional_read` + `pagination.default_limit`) is a STRICTLY ADDITIVE, ALL-OPTIONAL extension of
 * the product profile, so it needs no version bump: every previously-valid product document parses
 * byte-identically (the `version` literal + `product:` discriminant select document PROFILES, not
 * additive vocabulary), and `.strict()` still rejects unknown keys fail-closed. The committed
 * schema and the fixtures are regenerated/updated DELIBERATELY with this change (never silently).
 *
 * SEMANTIC SPLIT (CL-BRIDGE-MINOR-1): `source` (+ `read`) declare the BACKING DATA and are validated
 * kind-aware (store name / declared artifact / capability contract — a contract id NEVER satisfies a
 * source); `response_contract` (+ `read.shape`) declare the DTO and are validated by the separate
 * shape⊆contract conformance pass. See product-views.ts + product-views-lint.ts.
 */
export const ProductViewSpec = z
  .object({
    id: z.string().min(1),
    route: ViewRoute,
    /** Named auth policy (e.g. `bearer_tenant`). */
    auth: z.string().min(1).optional(),
    /** Declared request inputs. Required (with full path-param coverage) when `read` is set. */
    params: z.record(z.string().min(1), ViewParamSpec).optional(),
    source: ViewSource.optional(),
    /** The declarative read + DTO projection — interpretable by @rayspec/views-runtime. */
    read: ViewRead.optional(),
    pagination: ViewPagination.optional(),
    absent_state: ViewAbsentState.optional(),
    /** Conditional-read behavior: `etag` → strong ETag + If-None-Match 304 on GET. */
    conditional_read: ViewConditionalRead.optional(),
    /** Contract id for generated clients (product-lint resolves it). */
    response_contract: z.string().min(1),
  })
  .strict();
export type ProductViewSpec = z.infer<typeof ProductViewSpec>;

// ---------------------------------------------------------------------------------------
// deployment_overrides — narrow provider bindings (NOT handler/route/migration code)
// ---------------------------------------------------------------------------------------

export const ProviderOverride = z
  .object({
    default_model: z.string().min(1).optional(),
    default_provider: z.string().min(1).optional(),
  })
  .strict();
export type ProviderOverride = z.infer<typeof ProviderOverride>;

export const DeploymentOverrides = z
  .object({
    providers: z.record(z.string(), ProviderOverride).optional(),
  })
  .strict();
export type DeploymentOverrides = z.infer<typeof DeploymentOverrides>;

// ---------------------------------------------------------------------------------------
// ProductSpec — the whole document
// ---------------------------------------------------------------------------------------

/**
 * The full Product-YAML document (the product profile of the unified `version:'1.0'` language). Its
 * top-level key is `version` (`z.literal('1.0')`) — checked FIRST by the two-phase `parseProductSpec`
 * (product-parse.ts) so an unsupported version yields a clean `unsupported_version` instead of a wall
 * of strict errors. The required `product:` section is the archetype discriminant that tells this
 * profile apart from the backend profile (which never carries `product:` — see detect.ts). `.strict()`
 * rejects any unknown top-level section. Only `product` is required; every other section defaults
 * ([]/{}), so a minimal doc (just `version` + `product`) is valid and a product need not declare every
 * section. The grammar is a single `z.literal(SPEC_VERSION)` — the parse boundary (product-parse.ts)
 * accepts exactly `version:'1.0'` and rejects any other version fail-closed.
 */
export const ProductSpec = z
  .object({
    version: z.literal(SPEC_VERSION),
    product: ProductIdentity,
    requires: RequiresSpec.default({ capabilities: [] }),
    capabilities: z.array(CapabilitySpec).default([]),
    artifacts: z.array(ArtifactSpec).default([]),
    /**
     * Declared typed product stores. The ABSENT-section default is [] — a NO-OP:
     * a document without a `stores` section (incl. the acme-notes reference product) parses and derives byte-identically.
     */
    stores: z.array(ProductStoreSpec).default([]),
    contracts: ContractsSpec.default({}),
    extractors: z.array(ExtractorSpec).default([]),
    workflows: z.array(ProductWorkflowSpec).default([]),
    grounding: GroundingSpec.optional(),
    views: z.array(ProductViewSpec).default([]),
    deployment_overrides: DeploymentOverrides.optional(),
  })
  .strict();
export type ProductSpec = z.infer<typeof ProductSpec>;
