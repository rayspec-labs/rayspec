/**
 * The RaySpec config grammar — `RaySpec` and its six sections.
 *
 * A deployed backend is ONE validated `RaySpec` (concept §9: stores · api · agents ·
 * tooling · triggers · handlers). This module defines ONLY the Zod grammar (shape). The
 * two-phase parser (`parse.ts`), the semantic linter (`lint.ts`), and the JSON-Schema exporter
 * (`export.ts`) build on top of it.
 *
 * FAIL-CLOSED BY CONSTRUCTION (concept §9): every GRAMMAR object level is `.strict()`, so an
 * unknown key is rejected — there is no silent passthrough of a typo'd or unrecognized field.
 * Verified (zod 4.4.3, doc-first probe): `.omit().extend().strict()` composes so the wrap layer
 * stays strict AND the exported JSON-Schema carries `additionalProperties:false` at every STRICT
 * grammar level. The THREE embedded JSON-Schema slots (a tool's `parameters`/`outputSchema` and an
 * agent's `outputSchema.schema`) are intentionally OPEN records — they ARE free-form JSON-Schema,
 * validated separately by ajv (lint.ts), not by strict-key rejection.
 *
 * HYBRID WRAP:
 *  - `agents[]` and `tooling[]` WRAP the neutral `core` types (`AgentSpec`/`ToolSpec`) — the
 *    literal interpreter input — so there is ONE source of truth for the neutral fields. Honest
 *    limit of the wrap: a neutral REMOVAL or RENAME surfaces LOUDLY (a `.omit()`/`.extend()` on a
 *    missing key is a compile error); a neutral ADDITION is ABSORBED SILENTLY into the grammar.
 *    The `AgentSpecConfig`/`ToolSpecConfig` shape-key PIN TESTS (grammar.test.ts) are what make an
 *    addition deliberate — a new neutral key fails the pin and forces a conscious spec-bump call.
 *  - `stores[]`, `api[]`, `triggers[]`, `handlers[]` are INDEPENDENT Zod types (no neutral
 *    precedent exists for them).
 *
 * RUNTIME vs CONFIG (load-bearing): `core.AgentSpec` includes `input` — that is the RUNTIME task
 * value supplied per request, NOT config. A declared agent MUST OMIT it (we `.omit({ input })`),
 * and supplies it at request time. Likewise `core.AgentSpec.tools` is an INLINE
 * neutral-tool array; in the config layer an agent references declared `tooling[]` entries BY ID,
 * so we omit the inline array and add an `id`-reference list (`tools: string[]`) instead. The
 * lint pass resolves those references against the `tooling[]` section.
 */
import {
  BackendId,
  AgentSpec as NeutralAgentSpec,
  ToolSpec as NeutralToolSpec,
} from '@rayspec/core';
import { z } from 'zod';

/** The supported spec major.minor. Parsed FIRST (two-phase) so an unknown major fails cleanly. */
export const SPEC_VERSION = '1.0' as const;

// ---------------------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------------------

/** Minimal deployment metadata. `name` identifies the backend; extend later as needed. */
export const Metadata = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
  })
  .strict();
export type Metadata = z.infer<typeof Metadata>;

// ---------------------------------------------------------------------------------------
// deployment — independent grammar (deployment PROPERTY, not a backend capability — C3)
// ---------------------------------------------------------------------------------------

/**
 * Deployment-level properties of a backend. These describe HOW the
 * deployment runs, NOT what any SDK can do — so `async`/off-request execution belongs HERE, on the
 * spec, gated by "is a durable worker configured?", and is INVISIBLE to the neutral `Backend`
 * interface and the per-backend `CapabilityDescriptor` (which must NOT be touched: whether a run
 * executes off-request has no backend asymmetry to absorb — `runAgent` takes the same `ctx`
 * in-request or off-request).
 *
 *  - `durableWorker` — when true, the deployment runs a durable off-request worker (DBOS),
 *    so a per-request `async:true` run is enqueued onto it (202 + runId) rather than fail-closed-501.
 *    A lint rule (lint.ts) enforces it: a spec must not be deployed expecting async without it — but
 *    the LOAD-BEARING gate is the RUNTIME one (the run surface 501s if no executor is wired,
 *    regardless of this flag), so this is a declaration + a static best-effort check, defense-in-depth.
 */
export const DeploymentSpec = z
  .object({
    durableWorker: z.boolean().optional(),
  })
  .strict();
export type DeploymentSpec = z.infer<typeof DeploymentSpec>;

// ---------------------------------------------------------------------------------------
// stores[] — independent grammar (DB-materialized product tables)
// ---------------------------------------------------------------------------------------

/**
 * The closed set of column types an author may declare. Small + closed so the store generator
 * can map each to a Drizzle/Postgres type deterministically and the migration gate sees a finite
 * vocabulary. (Authors declare BUSINESS columns only — the tenancy/GDPR columns `tenant_id`,
 * `id`, `created_at`, `deleted_at`, `retention_days`, `region` are INJECTED by the generator,
 * never declared here.)
 */
export const ColumnType = z.enum(['text', 'uuid', 'timestamp', 'integer', 'boolean', 'jsonb']);
export type ColumnType = z.infer<typeof ColumnType>;

/**
 * A SAFE SQL/TS IDENTIFIER for a store name / column name / FK column-or-reference (TEN-1).
 * Store/column names are interpolated VERBATIM into generated SQL (`CREATE TABLE "<name>"`)
 * AND generated TS (`export const <camel> = pgTable('<name>', …)`) — so an unconstrained
 * `z.string()` is an INJECTION seam (a name like `m" ); DROP …` lands in executable DDL, and the
 * destructive scan is a closed blocklist that can never catch every form). Fail-closed at the
 * SOURCE: a safe identifier is `[a-z_][a-z0-9_]*`, length 1..63 (the Postgres identifier limit),
 * lowercase only (Postgres folds unquoted idents to lowercase; we keep snake_case author names and
 * camelCase them for TS). `parseSpec` rejects a metacharacter/over-long name as `schema_violation`.
 * The generators re-assert the SAME shape (defense-in-depth for a code-built spec bypassing parse).
 */
export const SAFE_IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;
export const MAX_IDENTIFIER_LENGTH = 63;
export const SafeIdentifier = z
  .string()
  .min(1)
  .max(
    MAX_IDENTIFIER_LENGTH,
    `identifier must be <= ${MAX_IDENTIFIER_LENGTH} chars (Postgres limit)`,
  )
  .regex(
    SAFE_IDENTIFIER_RE,
    'identifier must match /^[a-z_][a-z0-9_]*$/ (lowercase letters/digits/underscore, no metacharacters)',
  );

/**
 * Re-assert the safe-identifier shape OUTSIDE Zod (the generators call this on a spec that may have
 * been built in code, bypassing parseSpec). THROWS — never returns a malformed identifier into
 * generated SQL/TS. Single source of the rule shared by the grammar refine above + both generators.
 */
export function assertSafeIdentifier(value: string, what: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    !SAFE_IDENTIFIER_RE.test(value)
  ) {
    throw new Error(
      `unsafe identifier for ${what}: ${JSON.stringify(value)} — must match ` +
        `/^[a-z_][a-z0-9_]*$/ and be <= ${MAX_IDENTIFIER_LENGTH} chars (injection guard, TEN-1)`,
    );
  }
}

/** One business column on a store. `nullable`/`unique` default false (the conservative shape). */
export const StoreColumn = z
  .object({
    name: SafeIdentifier,
    type: ColumnType,
    nullable: z.boolean().default(false),
    unique: z.boolean().default(false),
  })
  .strict();
export type StoreColumn = z.infer<typeof StoreColumn>;

/**
 * A child→parent foreign key (the throwaway has `transcripts` referencing `meetings`). The
 * generator emits the FK + `ON DELETE` policy; the parent must be another declared store (the
 * lint pass resolves `references`). This is a PRODUCT-to-PRODUCT FK; FK-to-core (e.g. orgs) is
 * the injected tenancy column, not declared here.
 */
export const StoreForeignKey = z
  .object({
    /** The local column carrying the FK (must be a DECLARED business column — lint-resolved). */
    column: SafeIdentifier,
    /** The referenced store name (must be a declared store — lint-resolved). */
    references: SafeIdentifier,
    /** ON DELETE policy; `cascade` mirrors the tenancy cascade discipline. */
    onDelete: z.enum(['cascade', 'restrict', 'set null']).default('cascade'),
  })
  .strict();
export type StoreForeignKey = z.infer<typeof StoreForeignKey>;

/**
 * A declared product store. Authors declare a name + business columns (+ optional child→parent
 * FKs). Tenancy is NON-OPTIONAL by construction — there is no opt-out field (a non-tenant store
 * would be the spec-level analogue of `.unscoped()`, deliberately not expressible in v1.0).
 */
export const StoreSpec = z
  .object({
    name: SafeIdentifier,
    columns: z.array(StoreColumn).min(1),
    foreignKeys: z.array(StoreForeignKey).default([]),
  })
  .strict();
export type StoreSpec = z.infer<typeof StoreSpec>;

// ---------------------------------------------------------------------------------------
// handlers[] — independent grammar (escape-hatch TS module references)
// ---------------------------------------------------------------------------------------

/**
 * What a handler is wired into. A logical id maps to a TS module + export; `kind` declares the
 * chokepoint it dispatches through (tool → dispatchTool; route → the api chokepoint; trigger →
 * the triggers seam). The loader resolves the symbol from a path-jailed escape-hatch
 * root — the grammar layer parses the mapping only.
 */
export const HandlerKind = z.enum(['tool', 'route', 'trigger']);
export type HandlerKind = z.infer<typeof HandlerKind>;

export const HandlerSpec = z
  .object({
    /** Logical id referenced by tooling/api/triggers. */
    id: z.string().min(1),
    /** The escape-hatch TS module path (resolved under the jailed root at load). */
    module: z.string().min(1),
    /** The named export within that module. */
    export: z.string().min(1),
    kind: HandlerKind,
  })
  .strict();
export type HandlerSpec = z.infer<typeof HandlerSpec>;

// ---------------------------------------------------------------------------------------
// agents[] — WRAP core.AgentSpec
// ---------------------------------------------------------------------------------------

/**
 * A declared agent. WRAPS `core.AgentSpec`:
 *  - `.omit({ input })` — `input` is the per-request RUNTIME value, never config.
 *  - `.omit({ tools })` — the neutral inline tool array is replaced by ID references into the
 *    `tooling[]` section (a config agent wires tools by id; lint resolves them).
 *  - `.extend(...)` — the wrap-layer fields the engine needs: a logical `id`, a `backend`
 *    selection, the `tools` id-reference list, and an optional `requireNativeStructuredOutput`
 *    flag so a capability violation (e.g. native structured output demanded on pi) is expressible
 *    and checked at config time (lint).
 *  - `.strict()` — fail-closed unknown-key rejection (applied last; verified to compose).
 *
 * Single source of truth: `name`/`instructions`/`model`/`outputSchema`/`maxTurns` come straight
 * from the neutral type. If the neutral `AgentSpec` churns, this wrap is where the compat decision
 * (minor vs major spec bump) is made — by design.
 */
export const AgentSpecConfig = NeutralAgentSpec.omit({ input: true, tools: true })
  .extend({
    /** Logical id (unique within `agents[]`). */
    id: z.string().min(1),
    /** Which backend runs this agent. */
    backend: BackendId,
    /** Tool ids referenced from the `tooling[]` section (lint-resolved). */
    tools: z.array(z.string().min(1)).default([]),
    /**
     * When true, an `outputSchema` DEMANDS native structured output — rejected at config time on
     * a backend that lacks it (pi). Threaded into core `validateSpec` by the lint pass.
     */
    requireNativeStructuredOutput: z.boolean().default(false),
  })
  .strict();
export type AgentSpecConfig = z.infer<typeof AgentSpecConfig>;

// ---------------------------------------------------------------------------------------
// tooling[] — WRAP core.ToolSpec
// ---------------------------------------------------------------------------------------

/**
 * A declared tool. WRAPS `core.ToolSpec` (name/description/parameters — the model-facing
 * declaration) + the wrap-layer fields the resolver needs to build a `NeutralTool`:
 *  - `id` — logical id referenced from `agents[].tools` and unique within `tooling[]`.
 *  - `handler` — a logical handler id from the `handlers[]` section (lint-resolved).
 *  - `idempotent` — REQUIRED, NO DEFAULT. This is the reviewed replay-safety declaration the whole
 *    `dispatchTool` contract keys off (a `false` tool must never re-fire / return a cached output
 *    on replay). There is no platform-side verification of this boolean — it must be an explicit,
 *    reviewed author decision, so we give it no default.
 *  - `timeoutMs` — bounds the handler (AbortSignal in dispatchTool).
 *  - `outputSchema` — optional embedded JSON-Schema validating the handler output (Ajv-compiled
 *    at load by the lint pass). `parameters` (the input schema) is inherited from `ToolSpec`.
 */
export const ToolSpecConfig = NeutralToolSpec.extend({
  /** Logical id (unique within `tooling[]`; referenced from `agents[].tools`). */
  id: z.string().min(1),
  /** A declared handler id (lint-resolved against `handlers[]`). */
  handler: z.string().min(1),
  /**
   * The replay-safety declaration — REQUIRED, no default (a reviewed author decision; the whole
   * dispatchTool replay contract keys off it).
   */
  idempotent: z.boolean(),
  /** Hard timeout for the handler (ms). */
  timeoutMs: z.number().int().positive(),
  /** Optional embedded JSON-Schema validating handler OUTPUT (Ajv-compiled at load). */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type ToolSpecConfig = z.infer<typeof ToolSpecConfig>;

// ---------------------------------------------------------------------------------------
// api[] — independent grammar (declared HTTP routes)
// ---------------------------------------------------------------------------------------

/** The HTTP method a route handles. */
export const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export type HttpMethod = z.infer<typeof HttpMethod>;

/** A CRUD operation against a materialized store. */
export const StoreOp = z.enum(['list', 'get', 'create', 'update', 'delete']);
export type StoreOp = z.infer<typeof StoreOp>;

/**
 * A `stream` route's runtime mode — discriminates the init shape the interpreter builds WITHIN the
 * `kind:'stream'` arm (NOT a union discriminant — the union still discriminates on `kind`):
 *  - `ingest`   — the binary write half: the interpreter reads the RAW request body.
 *  - `playback` — the media read half: Range/206 + conditional-GET from a `BlobStore`.
 *
 * `mode` is a per-arm field (like a store action's `op`), not a fourth `kind`: an ingest and a
 * playback route are the SAME kind of action (a raw-Request/Response stream handler) differing only
 * in runtime behavior, so one `kind` keeps the closed union minimal.
 */
export const StreamMode = z.enum(['ingest', 'playback']);
export type StreamMode = z.infer<typeof StreamMode>;

/**
 * A route action — a discriminated union over its `kind`:
 *  - `store`   — CRUD over a materialized store via TenantDb.
 *  - `agent`   — invoke a declared agent over the SSE/JSON run surface.
 *  - `handler` — a declared route-handler id.
 *  - `stream`  — a raw binary ingest / Range-206 playback handler; `mode`
 *               discriminates ingest vs playback WITHIN this arm (the union still keys on `kind`).
 *
 * The discriminant `kind` is an explicit field (not inferred from which payload is set) so the union
 * is unambiguous and fail-closed. The `stream` arm's `handler` resolves against a declared
 * `route`-kind handler — the SAME chokepoint a `kind:'handler'` route uses (a stream handler is a
 * route handler that receives a raw `Request` instead of parsed JSON; the raw-vs-JSON init shape is
 * a RUNTIME concern, not a grammar-kind concern — so no new `HandlerKind` is introduced).
 */
export const RouteAction = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('store'),
      /** The declared store name (lint-resolved). */
      store: z.string().min(1),
      op: StoreOp,
    })
    .strict(),
  z
    .object({
      kind: z.literal('agent'),
      /** The declared agent id (lint-resolved). */
      agent: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('handler'),
      /** The declared handler id (lint-resolved; must be a `route`-kind handler). */
      handler: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stream'),
      /**
       * The declared handler id (lint-resolved; must be a `route`-kind handler — a stream handler
       * dispatches through the api chokepoint, like a `kind:'handler'` route).
       */
      handler: z.string().min(1),
      /** ingest (raw binary write) vs playback (Range/206 media read) — see `StreamMode`. */
      mode: StreamMode,
    })
    .strict(),
]);
export type RouteAction = z.infer<typeof RouteAction>;

/** A declared HTTP route mounted on the existing auth chain. */
export const ApiRouteSpec = z
  .object({
    method: HttpMethod,
    /** Route path (e.g. `/meetings/{id}`); interpreted by the api interpreter. */
    path: z.string().min(1),
    action: RouteAction,
  })
  .strict();
export type ApiRouteSpec = z.infer<typeof ApiRouteSpec>;

// ---------------------------------------------------------------------------------------
// triggers[] — independent grammar (parse/register only)
// ---------------------------------------------------------------------------------------

/**
 * A trigger action — what fires when the trigger runs. A trigger fires an agent or a declared
 * trigger-handler (lint-resolved). Parse/register only (the durable worker is a deployment
 * property); a cron/async fire is fail-closed-rejected at runtime (not in this grammar).
 */
export const TriggerAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agent: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('handler'), handler: z.string().min(1) }).strict(),
]);
export type TriggerAction = z.infer<typeof TriggerAction>;

/**
 * A declared trigger. `kind` selects the descriptor:
 *  - `cron`    — requires `schedule` (a cron expression; not evaluated at the grammar level).
 *  - `webhook` — an inbound webhook (path interpreted later).
 *  - `event`   — requires `event` (a logical event name).
 *  - `manual`  — fired by an explicit call.
 *
 * `schedule`/`event` are optional at the GRAMMAR level (different kinds need different fields);
 * the lint pass enforces the kind→field requirement (cron needs schedule, event needs event) so a
 * malformed trigger fails fail-closed rather than parsing into a half-specified descriptor.
 */
export const TriggerKind = z.enum(['cron', 'webhook', 'event', 'manual']);
export type TriggerKind = z.infer<typeof TriggerKind>;

export const TriggerSpec = z
  .object({
    name: z.string().min(1),
    kind: TriggerKind,
    /** Cron expression — REQUIRED for `kind:'cron'` (lint-enforced). */
    schedule: z.string().min(1).optional(),
    /** Logical event name — REQUIRED for `kind:'event'` (lint-enforced). */
    event: z.string().min(1).optional(),
    action: TriggerAction,
  })
  .strict();
export type TriggerSpec = z.infer<typeof TriggerSpec>;

// ---------------------------------------------------------------------------------------
// extensions[] — independent grammar (extension-pack references)
// ---------------------------------------------------------------------------------------

/**
 * An EXACT semantic version pin (CLAUDE.md §3 "zero caret/tilde"). An extension
 * pack is product code authored + versioned in its OWN repo and named by reference here, so its
 * version MUST be pinned exactly — any range/wildcard/floating/partial form would let the resolved
 * pack drift silently between deploys, defeating the reviewed-deploy discipline.
 *
 * ALLOWLIST by construction (NOT a blocklist of range characters — a blocklist false-accepts forms
 * it doesn't enumerate, e.g. uppercase-X wildcards or floating dist-tags, AND false-rejects legit
 * exact pins whose prerelease/build metadata contains an `x`). We accept ONLY a strict-exact semver:
 * `MAJOR.MINOR.PATCH` (each numeric, no leading zeros) with an OPTIONAL `-prerelease` and/or
 * `+build` metadata segment (the canonical semver.org grammar, anchored). Everything else — every
 * range (`^`/`~`/`>=`/`<`/`=`), wildcard (`*`/`1.2.x`/`1.X`/`X`), floating dist-tag
 * (`latest`/`stable`/`beta`/`next`), partial version (`1`/`1.2`), set/hyphen range
 * (`1.0.0 || 2.0.0` / `1.0.0 - 2.0.0`), `v`-prefix, leading zero, or surrounding whitespace — fails
 * by NOT matching the allowlist, so no enumeration can leak a form.
 *
 * Accepted: `1.2.3`, `1.2.3-rc.1`, `1.0.0-linux.1`, `2.0.0+exp.sha`, `10.20.30` (exact prerelease/
 * build metadata — including the letter `x` inside it — is still an exact pin). We do NOT resolve
 * the pack here (its own loader, S4, resolves + validates the actual published version); this is the
 * fail-closed "is it EXACTLY one version?" guard at the grammar boundary.
 *
 * Implemented as `.regex()` (NOT `.refine()`): a `.regex()` serializes into the exported JSON-Schema
 * as a `pattern`, so the artifact (export.ts) ALSO enforces the exact-pin constraint — a `.refine()`
 * is dropped by `z.toJSONSchema`, which would leave the exported schema with NO version constraint.
 */
const EXACT_SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const ExactVersionPin = z
  .string()
  .min(1)
  .regex(EXACT_SEMVER_RE, {
    message:
      'extension version must be an EXACT semver pin (MAJOR.MINOR.PATCH with optional -prerelease/' +
      '+build) — ranges, wildcards (incl. uppercase X), floating dist-tags (latest/beta/…), and ' +
      'partial versions (1, 1.2) are rejected',
  });

/**
 * A reference to an extension pack to load. The pack carries ALL product code (its
 * own stores/handlers/tooling/route fragments + capability impls); core validates ONLY this
 * reference shape, never the pack's contents. `config` is an OPEN passthrough record whose CONTENTS
 * are validated by the PACK's own Zod at load time (S4), NEVER by core — but the ExtensionRef
 * wrapper itself is `.strict()`, so an unknown key ON THE REF is fail-closed-rejected.
 *
 *  - `id`      — a logical id for the pack (unique within `extensions[]`; lint-resolvable later).
 *  - `module`  — the pack module/directory reference (resolved + path-jailed by `loadExtensions`, S4).
 *  - `version` — an EXACT version pin (no range — see `ExactVersionPin`).
 *  - `config`  — optional opaque pack-validated config (passthrough; core does not inspect it).
 */
export const ExtensionRef = z
  .object({
    id: z.string().min(1),
    module: z.string().min(1),
    version: ExactVersionPin,
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ExtensionRef = z.infer<typeof ExtensionRef>;

// ---------------------------------------------------------------------------------------
// frontend[] — independent grammar (static frontend mounts served alongside the API)
// ---------------------------------------------------------------------------------------

/**
 * One static frontend mount served alongside the backend's API. A backend may declare a list of
 * these so a spec can ship its own web UI (built assets) next to the routes it exposes.
 *
 *  - `route` — the URL prefix the mount is served under (e.g. `/` or `/app`); must start with `/`.
 *  - `dir`   — the directory of built static assets, relative to the spec file.
 *  - `spa`   — when true, an unmatched path under `route` falls back to `index.html` (the
 *              History-API single-page-app fallback); default false (plain static file serving).
 *
 * `.strict()` — fail-closed unknown-key rejection, consistent with every other grammar level.
 */
export const FrontendSpec = z
  .object({
    route: z.string().min(1).regex(/^\//, 'route must start with "/"'),
    dir: z.string().min(1),
    spa: z.boolean().default(false),
  })
  .strict();
export type FrontendSpec = z.infer<typeof FrontendSpec>;

// ---------------------------------------------------------------------------------------
// RaySpec — the whole document
// ---------------------------------------------------------------------------------------

/**
 * The full RaySpec config document. `version` is `z.literal('1.0')` — but the parser checks it
 * FIRST (two-phase, see `parse.ts`) so an unsupported major yields a clean `unsupported_version`
 * SpecError instead of a wall of strict-shape errors. `.strict()` at the top level rejects any
 * unknown top-level section.
 *
 * Every section defaults to `[]` so a minimal spec (just `version` + `metadata`) is valid.
 */
export const RaySpec = z
  .object({
    version: z.literal(SPEC_VERSION),
    metadata: Metadata,
    stores: z.array(StoreSpec).default([]),
    api: z.array(ApiRouteSpec).default([]),
    agents: z.array(AgentSpecConfig).default([]),
    tooling: z.array(ToolSpecConfig).default([]),
    triggers: z.array(TriggerSpec).default([]),
    handlers: z.array(HandlerSpec).default([]),
    /**
     * OPTIONAL extension-pack references. Defaults to `[]` so a minimal spec (just
     * `version` + `metadata`) and every existing fixture stays valid — absent = NO-OP (no packs
     * loaded). Each entry's contents (`config`) are validated by the pack itself, never core;
     * the ref wrapper is `.strict()` (fail-closed on an unknown key). The `loadExtensions` merge
     * threads pack fragments into the other sections.
     */
    extensions: z.array(ExtensionRef).default([]),
    /**
     * OPTIONAL deployment properties. An object (not an array) — absent ⇒ no
     * durable worker (the default; a per-request `async:true` then fail-closed-501s at the run
     * surface). A minimal spec (just `version` + `metadata`) stays valid (deployment is omittable).
     */
    deployment: DeploymentSpec.optional(),
    /**
     * OPTIONAL static frontend mounts. A list of `{route, dir, spa?}` entries served alongside the
     * API (see `FrontendSpec`). `.optional()` (NOT `.default([])`) so a spec that omits `frontend`
     * parses byte-identically — absent = NO static mounts. A minimal spec (just `version` +
     * `metadata`) stays valid (frontend is omittable).
     */
    frontend: z.array(FrontendSpec).optional(),
  })
  .strict();
export type RaySpec = z.infer<typeof RaySpec>;
