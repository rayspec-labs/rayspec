/**
 * Drizzle schema — the identity cluster + the run journal.
 *
 * `org.id` IS the canonical tenant_id (the predicate contract). Every tenant-scoped
 * table carries `tenant_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE` so a GDPR
 * org-delete cascades the whole tenant and the TenantDb chokepoint can auto-inject
 * the predicate structurally. Users are GLOBAL principals (one human, many orgs via
 * memberships — the Org→Membership→User graph). HASHES ONLY, never
 * secrets: password_hash (argon2id), session token_hash, api_key key_hash (HMAC).
 *
 * The soft-delete/residency columns (deleted_at / retention_days / region) and the WorkOS seam
 * columns (external_idp_id / scim_provisioned) ship in the FIRST migration — residency-ready and
 * federation-ready from day one even though enforcement is deferred to the external-exposure hardening.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
// The type-enforced product seam. The generated module is committed
// PRODUCT-EMPTY on the platform main line (zero tables); a deployment/the throwaway commits a
// populated one. TENANT_SCOPED_TABLES composes core ⊕ product below so a generated+registered
// product table is reachable through the TenantDb chokepoint and an unregistered one throws.
import { PRODUCT_TENANT_SCOPED_TABLES } from './generated/product-schema.js';

// ---------------------------------------------------------------------------------------
// Identity cluster
// ---------------------------------------------------------------------------------------

/** orgs — the cascade ROOT. `id` IS the tenant_id every downstream table references. */
export const orgs = pgTable(
  'orgs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    // Residency is a STORED FACT (no routing logic yet); default single-region.
    region: text('region').notNull().default('eu'),
    retentionDays: integer('retention_days'),
    // WorkOS seam: reserved for enterprise federation; no SDK dependency yet.
    externalIdpId: text('external_idp_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Soft-delete tombstone; the purge executor is deferred.
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('orgs_slug_lower_idx').on(sql`lower(${t.slug})`)],
);

/**
 * users — the ONE tenant-agnostic entity (NO tenant_id). Email is NORMALIZED before write
 * (trim/NFKC/lowercase/cap-254 in auth-core) so the partial unique index below cannot be
 * bypassed by confusables/whitespace and the dummy-hash enumeration defense holds.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    // argon2id-encoded hash (params embedded); NULL until a password is set.
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Uniqueness on the NORMALIZED email, ignoring soft-deleted tombstones.
    uniqueIndex('users_email_lower_idx')
      .on(sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} is null`),
  ],
);

/** memberships — the Org↔User edge; authz resolves (user_id, org_id) → role HERE. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // role is a Zod enum at the edge (owner|admin|member); stored as text.
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    // WorkOS seam: set when a membership was SCIM-provisioned by an external IdP.
    scimProvisioned: boolean('scim_provisioned').notNull().default(false),
    invitedBy: uuid('invited_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('memberships_user_org_idx').on(t.userId, t.orgId),
    index('memberships_org_idx').on(t.orgId),
  ],
);

/**
 * sessions — opaque server sessions. `id` is server-minted (never client-proposed → no
 * fixation). Only the HASH of the opaque cookie secret is stored; JWT access tokens are
 * NEVER persisted. `family_id` binds a refresh family for reuse-detection + targeted revoke.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currentOrgId: uuid('current_org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /**
     * WHY a session was revoked (SJR-3). `'logout'` = a deliberate end-of-session; `'reuse'` = a
     * refresh-reuse/family-revoke (token theft). Refresh of a `'logout'`-revoked session is a
     * benign stale cookie → uniform 401 (NO reuse audit / NO per-source lock); only `'reuse'` (or
     * a rotated-then-replayed token) drives the reuse path. NULL on a live session.
     */
    revokedReason: text('revoked_reason'),
    ua: text('ua'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_idx').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_family_idx').on(t.familyId),
  ],
);

/**
 * api_keys — org-scoped + the M2M client-credentials seam. Plaintext is shown ONCE; only
 * the public `key_prefix` (indexed for O(1) lookup) + the HMAC-SHA256-with-pepper `key_hash`
 * are stored (Slice -1: HMAC, not argon2id — fast on the hot per-request auth path; sound
 * for ≥128-bit machine secrets). `m2m_client` reuses key_prefix as client_id + key_hash as
 * the client-secret hash.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('api_key'),
    keyPrefix: text('key_prefix').notNull(),
    keyHash: text('key_hash').notNull(),
    scopes: text('scopes').array().notNull().default([]),
    createdBy: uuid('created_by'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('api_keys_prefix_idx').on(t.keyPrefix),
    uniqueIndex('api_keys_hash_idx').on(t.keyHash),
    index('api_keys_org_idx').on(t.orgId),
  ],
);

/**
 * auth_audit — append-only security log. EXCLUDED from forTenant auto-scoping (reads are
 * gated per tenant in the request layer) and written in its OWN committed unit of work so a
 * 404/rollback never drops the event. Cross-tenant denials record the ACTOR's resolved
 * tenant + the attempted target as an opaque `target_hash` (never a target-org FK).
 * Hashes/metadata only. Wired on every auth event.
 */
export const authAudit = pgTable(
  'auth_audit',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorOrgId: uuid('actor_org_id'),
    actorUserId: uuid('actor_user_id'),
    event: text('event').notNull(),
    requestId: text('request_id'),
    targetHash: text('target_hash'),
    ipHash: text('ip_hash'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_audit_actor_org_idx').on(t.actorOrgId)],
);

/**
 * oidc_models — the node-oidc-provider model store (Client, Grant, AuthorizationCode,
 * AccessToken, RefreshToken, Session, Interaction, DeviceCode, ...). GLOBAL/predicate-exempt by
 * DESIGN: OAuth artifacts are isolated by token AUDIENCE + the owning
 * client's org-bound payload, NOT by a tenant_id column — so this table is reached via
 * db.unscoped() and is the single largest predicate-exempt surface (hence the explicit
 * cross-client isolation test + the full-surface OIDC matrix that cover it).
 *
 * Shape mirrors the canonical oidc-provider adapter: rows keyed by (model, id); `grant_id`,
 * `user_code`, `uid` are nullable INDEXED lookups; `consumed_at` marks one-time-use artifacts;
 * `expires_at` drives expiry. `payload` is the provider's opaque JSON (it embeds the client's
 * org/scope binding) — RaySpec never interprets it except to enforce isolation by client.
 */
export const oidcModels = pgTable(
  'oidc_models',
  {
    model: text('model').notNull(),
    id: text('id').notNull(),
    payload: jsonb('payload').notNull(),
    grantId: text('grant_id'),
    userCode: text('user_code'),
    uid: text('uid'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.model, t.id] }),
    index('oidc_grant_idx').on(t.grantId),
    index('oidc_user_code_idx').on(t.userCode),
    index('oidc_uid_idx').on(t.uid),
  ],
);

/**
 * idempotency_keys — tenant-scoped Idempotency-Key replay store.
 *
 * TENANT-SCOPED (registered in TENANT_SCOPED_TABLES below): the run-core lesson — the idempotency
 * lookup MUST carry the tenant predicate so one tenant's Idempotency-Key can never collide with
 * or replay another's. Same key+bodyHash → replay the stored `snapshot`; same key+different body
 * → 409. UNIQUE(tenant_id, scope, idem_key).
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** A logical scope so different endpoints can reuse the same client key (e.g. 'apikey:mint'). */
    scope: text('scope').notNull(),
    idemKey: text('idem_key').notNull(),
    bodyHash: text('body_hash').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('idem_tenant_scope_key_idx').on(t.tenantId, t.scope, t.idemKey)],
);

// ---------------------------------------------------------------------------------------
// Run journal (retrofit: tenant_id text → uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE)
// ---------------------------------------------------------------------------------------

/** Per-step run journal — the reliability primitive. */
export const journalSteps = pgTable(
  'journal_steps',
  {
    stepId: uuid('step_id').defaultRandom().primaryKey(),
    runId: text('run_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    backend: text('backend').notNull(),
    type: text('type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    inputHash: text('input_hash').notNull(),
    output: jsonb('output'),
    inputTokens: numeric('input_tokens').notNull().default('0'),
    outputTokens: numeric('output_tokens').notNull().default('0'),
    totalTokens: numeric('total_tokens').notNull().default('0'),
    /** The COMPUTED cost (USD) from the effective-dated pricing registry. */
    costUsd: numeric('cost_usd').notNull().default('0'),
    /**
     * Cost reconciliation + provenance.
     * provider_cost_usd: the SDK-reported cost (Anthropic total_cost_usd, Pi usage.cost.total); NULL
     * for OpenAI (no provider cost) — never fabricated. cost_drift: set when |computed - provider|
     * exceeds the documented threshold. billed_cost_usd: 0 for a subscription run (Decision #7),
     * else the computed cost. produced_by: the SDK+adapter version that wrote the step.
     * pricing_version: the effective-dated pricing entry that COMPUTED this step's cost
     * (`<model>@<effectiveFrom>`, or 'FALLBACK' when the model/date had no registry entry) — so a
     * fallback-priced step is DISTINGUISHABLE in the ledger (auditability is the point).
     */
    providerCostUsd: numeric('provider_cost_usd'),
    billedCostUsd: numeric('billed_cost_usd').notNull().default('0'),
    costDrift: boolean('cost_drift').notNull().default(false),
    producedBy: text('produced_by'),
    pricingVersion: text('pricing_version'),
    latencyMs: numeric('latency_ms').notNull().default('0'),
    status: text('status').notNull(),
    authMode: text('auth_mode').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('journal_run_idx').on(t.runId),
    index('journal_tenant_idx').on(t.tenantId),
    // Replay cache, STRUCTURALLY tenant-partitioned (RLS-ready): exactly one
    // cached step per (tenant, run, key). Replaces the old (run_id, idempotency_key) index.
    uniqueIndex('journal_idem_idx').on(t.tenantId, t.runId, t.idempotencyKey),
  ],
);

/**
 * Neutral conversation store — re-derived transcript (never an SDK file). RAW PII.
 *
 * A ConvTurn/ConvPart transcript. ONE ROW PER PART; a row carries its turn (`turnIndex` + `role`),
 * its part `kind`, the call/result correlation id (`toolCallId`), and the FULL neutral ConvPart as a
 * `jsonb` `payload`. The `payload` is ATTACKER-CONTROLLED data: it is Zod-validated ON READ
 * (validateConversation) — a row whose payload does not match the neutral ConvPart shape is
 * DROPPED, never trusted.
 *
 * The additive columns are NULLABLE and the legacy `content`/`name` columns are nullable
 * (DEPRECATED): a part row writes `payload`/`kind`/`turn_index` and leaves the legacy text columns
 * null; the old flat shape (should any legacy row exist) still reads back. Additive columns over a
 * table rebuild. Tenant predicate is unchanged (still registered in TENANT_SCOPED_TABLES).
 */
export const conversationItems = pgTable(
  'conversation_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: text('run_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Global part ordering within the run (monotonic across all turns). */
    seq: numeric('seq').notNull(),
    /** The turn this part belongs to (0-based). NULL only on legacy rows. */
    turnIndex: numeric('turn_index'),
    /** The turn role (system|user|assistant|tool) — TRUSTED column, never inferred from payload. */
    role: text('role').notNull(),
    /** The ConvPart kind (text|reasoning|tool_call|tool_result|output|error). NULL on legacy rows. */
    kind: text('kind'),
    /** Correlation id pairing a tool_call with its tool_result. NULL for non-tool parts. */
    toolCallId: text('tool_call_id'),
    /** The full neutral ConvPart as jsonb — ATTACKER-CONTROLLED; validated on READ. */
    payload: jsonb('payload'),
    /** DEPRECATED: legacy flat-item part name. */
    name: text('name'),
    /** DEPRECATED: legacy flat-item text content. Nullable (part data lives in payload). */
    content: text('content'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('conv_run_idx').on(t.runId), index('conv_tenant_idx').on(t.tenantId)],
);

/**
 * Durable per-run event log (REST+SSE) — the resumable streaming seam.
 *
 * Every neutral NeutralEvent the run emits is persisted here BEFORE it is flushed to a live SSE
 * client (persist-before-flush), so a frame the client has seen is already durable and an
 * SSE reconnect (`Last-Event-ID`) is a lossless `seq > lastEventId` replay from this table —
 * NOT a re-run. `seq` is the SINGLE per-run monotonic seq the run-core stampSeq authority
 * assigns (NeutralEvent v2). `data` is the already-NEUTRALIZED NeutralEvent payload (tool
 * results are the opaque `tool_data` dispatchTool produced — never a raw path).
 *
 * TENANT-SCOPED (registered in TENANT_SCOPED_TABLES below): every read/write carries the tenant
 * predicate via the TenantDb chokepoint, so a reconnecting client of tenant B can never replay
 * tenant A's run events. UNIQUE(tenant_id, run_id, seq) makes the persist idempotent on a
 * re-emit and structurally one row per (run, seq); the (run_id, seq) index serves the ordered
 * replay read.
 */
export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: text('run_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** The run's single monotonic per-run seq (NeutralEvent.seq), assigned by run-core stampSeq. */
    seq: numeric('seq').notNull(),
    /** The NeutralEvent discriminant (run_started|text_delta|tool_called|...|run_completed). */
    type: text('type').notNull(),
    /** The full neutral NeutralEvent as jsonb (already neutralized; opaque tool_data for tools). */
    data: jsonb('data').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ordered replay read path (GET /runs/{id}/events?lastEventId=).
    index('run_events_run_seq_idx').on(t.runId, t.seq),
    // Structural one-row-per-(tenant,run,seq); makes the persist idempotent (onConflictDoNothing).
    uniqueIndex('run_events_tenant_run_seq_idx').on(t.tenantId, t.runId, t.seq),
  ],
);

/** A run header — links journal + conversation under one run + tenant. final_text is RAW PII. */
export const runs = pgTable(
  'runs',
  {
    runId: text('run_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    backend: text('backend').notNull(),
    authMode: text('auth_mode').notNull(),
    agentName: text('agent_name').notNull(),
    model: text('model').notNull(),
    status: text('status').notNull(),
    finalText: text('final_text'),
    output: jsonb('output'),
    /** Aggregate COMPUTED cost (USD) rolled up from the run's journal steps. */
    costUsd: numeric('cost_usd').notNull().default('0'),
    /**
     * Run-level roll-up of the per-step cost reconciliation.
     * provider_cost_usd: sum of the steps' provider cost (NULL when NO step reported one — OpenAI).
     * billed_cost_usd: sum of billed cost (0 for a subscription run — Decision #7). cost_drift: true
     * iff ANY step drifted.
     */
    providerCostUsd: numeric('provider_cost_usd'),
    billedCostUsd: numeric('billed_cost_usd').notNull().default('0'),
    costDrift: boolean('cost_drift').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Index the run-header time dimension the operator analytics scans.
    // `runs_created_at_idx` serves the cross-tenant (all-tenant) window scan + the most-recent ordering;
    // `runs_tenant_created_at_idx` serves the optional single-tenant operator filter (and any
    // tenant-scoped time query). Additive, non-destructive — mirrored by migration 0006.
    index('runs_created_at_idx').on(t.createdAt),
    index('runs_tenant_created_at_idx').on(t.tenantId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------------------
// Declarative Workflow Runtime journal — the Tier A durable workflow execution record.
// ---------------------------------------------------------------------------------------

/**
 * workflow_runs — the durable header for one workflow run.
 *
 * The Tier A workflow runtime persists ONE row per workflow run here, tenant-scoped. The
 * `workflow_run_id` is the run's DURABLE id — a TENANT-NAMESPACED deterministic id derived from
 * `(tenant, workflow_id, idempotency_key)` (see workflow-durable's `durableWorkflowRunId`) so two
 * tenants that declare the SAME `(workflow_id, idempotency_key)` can NEVER collide on one run row
 * (the durable-run single-flight lesson applied by construction). The `UNIQUE(tenant_id, workflow_id, idempotency_key)`
 * index is the SINGLE-FLIGHT natural key (C10): concurrent/redelivered starts for the same
 * `(tenant, workflow, idempotency)` collide on it → exactly one run header. `resumable` marks a
 * paused/quarantined run a later worker can resume from the persisted node states. `input_event` is
 * the full neutral trigger event (DATA); `error` is the first workflow-level error state.
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    workflowRunId: text('workflow_run_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    triggerEvent: text('trigger_event').notNull(),
    /**
     * The full neutral trigger event that started the run. Opaque DATA: the read path (journal-store
     * `rowToRun`) CASTS it to `WorkflowInputEvent` — it is NOT schema-re-validated on read. A consumer
     * treats the payload as untrusted DATA (threaded to node handlers), never as instructions.
     */
    inputEvent: jsonb('input_event').notNull(),
    /** running | completed | retryable_failure | terminal_failure | paused | quarantined. */
    status: text('status').notNull(),
    /** True for a paused/quarantined run a later worker may resume from the node journal. */
    resumable: boolean('resumable').notNull().default(false),
    /** The first workflow-level error state (neutral { code, message, retryable }); NULL when none. */
    error: jsonb('error'),
    /** Total node attempts across the run (rolled up from the node journal). */
    attempts: numeric('attempts').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workflow_runs_tenant_idx').on(t.tenantId),
    // The single-flight natural key (C10): exactly one run per (tenant, workflow, idempotency-key).
    uniqueIndex('workflow_runs_tenant_wf_idem_idx').on(t.tenantId, t.workflowId, t.idempotencyKey),
  ],
);

/**
 * workflow_node_states — the per-node journal within a workflow run.
 *
 * ONE ROW PER (run, node), tenant-scoped. `UNIQUE(tenant_id, workflow_run_id, node_id)` is the
 * idempotent-upsert key (the journal-UNIQUE lesson — a completed node is memoized here and NEVER
 * re-executed on a resume/replay; the fakes in tests enforce this same constraint). `status` carries
 * the full failure-semantics vocabulary (pending | running | completed | retryable_failure |
 * terminal_failure | skipped | paused | capability_unavailable | dropped | quarantined). `attempts`
 * is the per-node attempt record array; `output` is the node's memoized result (the resume value);
 * `artifact_refs` are the typed artifacts the node produced (provenance). `position` is the
 * declaration-order index for a stable observability read.
 */
export const workflowNodeStates = pgTable(
  'workflow_node_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    workflowRunId: text('workflow_run_id').notNull(),
    nodeId: text('node_id').notNull(),
    /** Declaration-order index (stable ordering for the observability read). */
    position: numeric('position').notNull().default('0'),
    capability: text('capability').notNull(),
    operation: text('operation').notNull(),
    status: text('status').notNull(),
    /** The per-attempt record array (attempt#, started/completed, status, error). */
    attempts: jsonb('attempts').notNull().default(sql`'[]'::jsonb`),
    attemptCount: numeric('attempt_count').notNull().default('0'),
    /** The typed artifact refs the node produced (provenance/lineage). */
    artifactRefs: jsonb('artifact_refs').notNull().default(sql`'[]'::jsonb`),
    /** The node's memoized output (the value re-used when a completed node is replayed on resume). */
    output: jsonb('output'),
    /** The node's terminal error state (neutral { code, message, retryable }); NULL when none. */
    error: jsonb('error'),
    /** Why a node did not run (dependency_failure | workflow_already_stopped | quarantined_upstream). */
    skippedReason: text('skipped_reason'),
    /** Provenance tag of the runtime that produced the node result. */
    producedBy: text('produced_by'),
    costUsd: numeric('cost_usd').notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workflow_node_states_tenant_idx').on(t.tenantId),
    index('workflow_node_states_run_idx').on(t.workflowRunId),
    // One row per node per run — the idempotent-upsert key + the resume memoization boundary.
    uniqueIndex('workflow_node_states_run_node_idx').on(t.tenantId, t.workflowRunId, t.nodeId),
  ],
);

/**
 * workflow_artifacts — the tenant-scoped, content-addressed store a workflow's store_write /
 * store_read nodes persist through. Backs the Tier B
 * `@rayspec/grounding-runtime` `ArtifactStore` interface with a TenantDb implementation so an
 * artifact never leaves its tenant. The `artifact_id` is the content-addressed handle id
 * (`artifact:<namespace>:<scope>:<kind>:<hash>`); `UNIQUE(tenant_id, artifact_id)` makes a persist
 * IDEMPOTENT (a re-persist of identical content is a get-or-create no-op — the C10 SAVEPOINT-scoped
 * get-or-create is recoverable). `content` is the artifact body (DATA); `metadata` its envelope meta.
 */
export const workflowArtifacts = pgTable(
  'workflow_artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** The content-addressed handle id the store_read node resolves by (tenant-scoped). */
    artifactId: text('artifact_id').notNull(),
    /** The workflow run that produced the artifact (provenance); NULL for an externally-seeded one. */
    workflowRunId: text('workflow_run_id'),
    kind: text('kind').notNull(),
    namespace: text('namespace').notNull(),
    scope: text('scope').notNull(),
    contentHash: text('content_hash').notNull(),
    version: numeric('version').notNull().default('1'),
    /**
     * The artifact body. Opaque DATA: the read path (store `rowToStored`) CASTS it — it is NOT
     * schema-re-validated on read. A consumer treats it as untrusted DATA, never as instructions.
     */
    content: jsonb('content').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workflow_artifacts_tenant_idx').on(t.tenantId),
    // Content-addressed idempotency key: one row per (tenant, handle id) → persist is get-or-create.
    uniqueIndex('workflow_artifacts_tenant_artifact_idx').on(t.tenantId, t.artifactId),
  ],
);

/**
 * The set of tenant-scoped tables that the TenantDb chokepoint auto-scopes by tenant_id.
 * DENY-BY-DEFAULT: a tenant-scoped table NOT registered here throws on access (it must
 * never silently fall through to unscoped). Global/auth tables (orgs, users, sessions,
 * api_keys, memberships, auth_audit, the OIDC store) are reached via db.unscoped() and are
 * deliberately ABSENT from this list.
 */
export const CORE_TENANT_SCOPED_TABLES = [
  journalSteps,
  conversationItems,
  runs,
  runEvents,
  idempotencyKeys,
  workflowRuns,
  workflowNodeStates,
  workflowArtifacts,
] as const;

/**
 * The full tenant-scoped set = CORE ⊕ PRODUCT. The product half is the
 * type-enforced tuple from the committed generated module — EMPTY on the platform main line, a
 * populated tuple in a deployment / the throwaway. `as const` on BOTH halves keeps this a
 * literal-tuple type, so `TenantDb`'s `TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number]`
 * union and the deny-by-default `SCOPED` Set both compose: a registered product table type-checks +
 * is reachable through the chokepoint; an unregistered one is neither in the union nor the Set and
 * throws. The spread of two `as const` tuples preserves the literal member types (no widening).
 */
export const TENANT_SCOPED_TABLES = [
  ...CORE_TENANT_SCOPED_TABLES,
  ...PRODUCT_TENANT_SCOPED_TABLES,
] as const;
