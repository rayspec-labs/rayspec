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
  bigint,
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
 * are stored (HMAC, not argon2id — fast on the hot per-request auth path; sound
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

/**
 * invites — the out-of-band org-invite tokens. TENANT-SCOPED (registered in TENANT_SCOPED_TABLES
 * below): an invite grants membership in exactly one org (`tenant_id`), so the tenant predicate is
 * carried STRUCTURALLY on every issue/consume write through the TenantDb chokepoint — a consume can
 * never touch another tenant's invite row. The initial token→org RESOLUTION (redeem) is inherently
 * tenant-agnostic (the presented token is the ONLY thing the redeemer holds), so it is a
 * hash-equality lookup on `token_hash` via a whitelisted global-resolution store method — exactly the
 * api-key/session bearer-resolution pattern — after which every write is tenant-scoped.
 *
 * HASHES ONLY: only the HMAC `token_hash` of the opaque invite token is stored (plaintext shown ONCE
 * at issue, conveyed out-of-band by the owner). `email` is the NORMALIZED invited address, `role` the
 * role to grant, `expires_at` the hard expiry, `consumed_at` the single-use marker (NULL until
 * redeemed), `created_by` the issuing owner. The issue path NEVER looks up whether the email has an
 * account, so it reveals no account-existence signal (account existence is resolved only at redeem, by
 * the invitee). Reached via forTenant() for writes; org-delete cascades the whole tenant's invites.
 */
export const invites = pgTable(
  'invites',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** HMAC-SHA256 (with the server pepper) of the opaque invite token. UNIQUE — the redeem lookup key. */
    tokenHash: text('token_hash').notNull(),
    /** The NORMALIZED invited email (never used to branch the issue response on account existence). */
    email: text('email').notNull(),
    /** The role the invite grants (owner|admin|member) — validated at the edge, stored as text. */
    role: text('role').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Single-use marker: NULL until redeemed; stamped in one atomic UPDATE that gates single-use. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // O(1) redeem lookup + structurally at most one invite per token (the token is 256-bit random).
    uniqueIndex('invites_token_hash_idx').on(t.tokenHash),
    index('invites_tenant_idx').on(t.tenantId),
  ],
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
     * exceeds the documented threshold. billed_cost_usd: 0 for a subscription run,
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
    /**
     * The failing step's error classification + retry advice, promoted OUT of the `output` jsonb
     * (mirrored by migration 0010; the jsonb keys stay for compatibility — this is additive, not a move).
     *
     * error_class: NULL on a successful step. On a failing one it is the neutral `ErrorClass` the
     * adapter reported for an llm step, and `tool_error` for a tool step — a value the neutral enum
     * DELIBERATELY does not contain, because a failed tool dispatch is not an upstream model failure
     * and has no neutral class. The COLUMN vocabulary is therefore WIDER than the API-facing one: the
     * worst-classified case (a tool error, which carried no class at all) becomes filterable in the
     * journal without ever becoming reportable as an upstream class — the readers validate through
     * `isErrorClass`, so `tool_error` can never leave through a run's `errorClass`.
     *
     * retry_after_ms: the upstream's Retry-After when it sent one, NULL otherwise (advice is never
     * invented). MILLISECONDS — the journaled advice is in seconds, so the platform converts on write;
     * `numeric` is how this table already stores a millisecond quantity (latency_ms). Why a column at
     * all: answering "why did this run fail" no longer requires reading `output`, which holds raw
     * model I/O — a column grant cannot exempt a jsonb path, so the classification and the payload
     * could not be granted apart.
     */
    errorClass: text('error_class'),
    retryAfterMs: numeric('retry_after_ms'),
    authMode: text('auth_mode').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('journal_run_idx').on(t.runId),
    index('journal_tenant_idx').on(t.tenantId),
    // Index the step-journal time dimension so created-at range/day-bucket scans over the
    // journal are index-backed instead of sequential. Additive, non-destructive — mirrored
    // by migration 0009 (parallels `runs_created_at_idx` on the run header).
    index('journal_steps_created_at_idx').on(t.createdAt),
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

// ---------------------------------------------------------------------------------------
// Tenant event bus — the durable, per-tenant-sequenced product event stream.
// ---------------------------------------------------------------------------------------

/**
 * tenant_event_streams — ONE row per tenant: the stream's HEAD and its retention FLOOR.
 *
 * `last_seq` is the last sequence number ISSUED to this tenant. An emit bumps it and inserts its
 * rows in ONE statement, so the UPDATE's row lock (held until COMMIT, like any Postgres row lock)
 * makes ALLOCATION ORDER EQUAL COMMIT ORDER: a later transaction physically cannot obtain seq N+1
 * before the holder of N has committed or rolled back. That is exactly the property a `seq > cursor`
 * resume needs and exactly what a plain `bigserial` does NOT give — a sequence hands out values
 * before commit, so a reader that saw 101 would lose row 100 permanently when the slower writer
 * committed after it. A rolled-back emit RETURNS its number and the next emit reissues it, so the
 * visible sequence is GAP-FREE: a hole is a real signal (retention), never noise.
 *
 * `truncated_through` is the highest seq retention has removed. It is written in the SAME STATEMENT
 * as the DELETE (one transaction, one snapshot), so a reader can never observe a deletion the floor
 * has not accounted for — the "ok plus a hole" outcome a separate floor-check round trip produces.
 * It only ever moves FORWARD (a GREATEST on write).
 *
 * TENANT-SCOPED (registered in TENANT_SCOPED_TABLES below) and `tenant_id uuid NOT NULL REFERENCES
 * orgs(id) ON DELETE CASCADE`, so an org delete takes the counter with the events.
 */
export const tenantEventStreams = pgTable('tenant_event_streams', {
  /** The tenant this stream belongs to — the PK (exactly one counter row per tenant). */
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  /** The last seq ISSUED to this tenant (0 before the first emit). The allocation lock lives here. */
  lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
  /** The highest seq RETENTION has deleted (0 when nothing has aged out). Monotonic; never rewound. */
  truncatedThrough: bigint('truncated_through', { mode: 'number' }).notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * tenant_events — the durable per-tenant event stream a product emits into via `init.emit`.
 *
 * ONE ROW PER EVENT, keyed `(tenant_id, seq)` — that composite PK is both the uniqueness guarantee
 * and the ordered read path (a resume is `tenant_id = $t AND seq > $cursor ORDER BY seq`).
 *
 * `seq` IS THE SOLE ORDERING AUTHORITY. `at` is DISPLAY ONLY and is NOT monotone with `seq`: it is
 * transaction-START time while the seq is allocated at FLUSH time, so on concurrent traffic adjacent
 * rows routinely run backwards in `at` relative to `seq` (measured on real concurrent data: 45% of
 * adjacent pairs). Any query that orders or windows by `at` therefore REORDERS and DROPS events —
 * order by `seq`, and use `at` only to show a human when something happened.
 *
 * TENANT-SCOPED (registered in TENANT_SCOPED_TABLES below): every read/write carries the tenant
 * predicate through the TenantDb chokepoint, and the `tenant_id` FK cascades an org delete.
 */
export const tenantEvents = pgTable(
  'tenant_events',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** The per-tenant sequence number allocated by the counter row. ORDERING AUTHORITY. */
    seq: bigint('seq', { mode: 'number' }).notNull(),
    /** The author-chosen topic (DATA — a product's own vocabulary; the platform never interprets it). */
    topic: text('topic').notNull(),
    /** The event body as jsonb (DATA — the payload the handler emitted, stored verbatim). */
    payload: jsonb('payload').notNull(),
    /** When the emitting transaction STARTED. DISPLAY ONLY — never an ordering or windowing key. */
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The composite key IS the stream: unique per (tenant, seq) and the ordered resume read path.
    primaryKey({ columns: [t.tenantId, t.seq] }),
    // The retention sweep's age scan (`at < cutoff`), so it never sequentially scans the stream.
    index('tenant_events_at_idx').on(t.at),
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
     * billed_cost_usd: sum of billed cost (0 for a subscription run). cost_drift: true
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
 * index is the SINGLE-FLIGHT natural key: concurrent/redelivered starts for the same
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
    // The single-flight natural key: exactly one run per (tenant, workflow, idempotency-key).
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
 * IDEMPOTENT (a re-persist of identical content is a get-or-create no-op — the single-flight SAVEPOINT-scoped
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

// ---------------------------------------------------------------------------------------
// Workforce task engine — durable tasks, wake signals, approvals, budget ledger, control.
// ---------------------------------------------------------------------------------------

/**
 * workforce_tasks — the durable task record the task engine schedules and transitions.
 *
 * ONE ROW PER TASK, tenant-scoped. `task_id` is a text PK like `runs.run_id`: root tasks get a
 * random UUID, child tasks get a DETERMINISTIC v5-shaped UUID derived from
 * (parent task, turn, slot index) so a re-executed turn re-creating its children collides on the PK
 * instead of duplicating them (the `durableWorkflowRunId` lesson applied to fan-out).
 *
 * `status` is a CLOSED nine-value set and `applyTransition()` in `@rayspec/tasks` is its ONLY
 * writer — `version` is the compare-and-swap token every transition presents, so two schedulers
 * racing the same task serialize on one UPDATE and the loser gets a typed conflict, never a double
 * dispatch. `status_reason` is a closed typed set, never free text. The only way back into
 * execution is `queued`; nothing resumes "in place".
 *
 * `last_event_seq` is the per-task journal sequence HEAD (the `tenant_event_streams.last_seq`
 * pattern): the counter UPDATE's row lock makes allocation order equal commit order for the task's
 * `run_events` journal rows, and because every transition already updates this row, allocation and
 * status write share one lock.
 *
 * The `(tenant_id, status, priority, queued_at)` index is the scheduler's reserve scan — oldest
 * queued work first within a priority band, always under the tenant predicate.
 */
export const workforceTasks = pgTable(
  'workforce_tasks',
  {
    taskId: text('task_id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** The declared workforce this task belongs to; NULL for a bare platform task. */
    workforceId: text('workforce_id'),
    parentTaskId: text('parent_task_id'),
    /** The subtree anchor: the root task's own id for a root; budget + cancellation scope. */
    rootTaskId: text('root_task_id').notNull(),
    /** Materialized ancestor task ids, root-first. Immutable; serves depth and cycle checks. */
    ancestryPath: jsonb('ancestry_path').notNull().default(sql`'[]'::jsonb`),
    /**
     * NULLABLE ONLY SO ERASURE CAN SCRUB IT. Every write path requires it (`createTask`'s schema
     * refuses an absent or empty title), so a NULL here means exactly one thing: this tenant's
     * content was erased by `journalScrub` while its structural + ledger columns were retained.
     */
    title: text('title'),
    /** The instruction the owner receives. DATA, never instructions. Nullable for the same reason. */
    goal: text('goal'),
    description: text('description'),
    /** The owner handler/employee id, or 'user' for a human-owned task. */
    owner: text('owner').notNull(),
    requestedBy: text('requested_by').notNull(),
    /** Cost-attribution scope for the ledger's department ceilings; NULL when unattributed. */
    department: text('department'),
    status: text('status').notNull(),
    statusReason: text('status_reason'),
    priority: text('priority').notNull().default('normal'),
    /** Task ids that must reach `completed` before this task leaves `planned`. */
    dependencies: jsonb('dependencies').notNull().default(sql`'[]'::jsonb`),
    /** How this task's children fan back in; NULL until a fan-out declares one. */
    joinPolicy: jsonb('join_policy'),
    artifacts: jsonb('artifacts').notNull().default(sql`'[]'::jsonb`),
    /** The structured result the owner submitted. Opaque DATA; validated at intent time. */
    result: jsonb('result'),
    confidence: numeric('confidence'),
    /** Aggregate settled cost (USD) rolled up from the ledger settlements. */
    costUsd: numeric('cost_usd').notNull().default('0'),
    tokenUsage: jsonb('token_usage').notNull().default(sql`'{}'::jsonb`),
    turnsUsed: integer('turns_used').notNull().default(0),
    /** The last journal seq ISSUED for this task's event stream (allocation lock lives here). */
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    queuedAt: timestamp('queued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /**
     * THE CLAIM LEASE — the liveness backstop for a turn the durable engine still calls live.
     *
     * Set by `applyTransition` in the SAME compare-and-swap UPDATE that writes `working` (so it can
     * never disagree with the claim it describes) and cleared by every transition OUT of `working`
     * (so a stale expiry can never be read off a row that holds no claim). NULL means "no claim" —
     * on every status but `working`, and on a `working` row driven there outside a dispatch.
     *
     * The reaper's original oracle was a DBOS workflow-status query alone, which cannot see a
     * worker whose process is up and whose workflow is PENDING but whose BODY is wedged: it reaches
     * neither release path (`settleTurn` needs the turn to finish; the reaper thought it alive), so
     * it held its concurrency slot and its budget reservation forever — and the `task`/`root`
     * ledger scopes never roll over, so the stranded estimate was permanent. An expired lease is
     * reaped through the IDENTICAL path as a dead claim.
     */
    claimExpiresAt: timestamp('claim_expires_at', { withTimezone: true }),
    /** Optimistic-concurrency token; every applyTransition presents the expected value. */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    // The scheduler reserve scan: queued work per tenant, priority band, oldest first.
    index('workforce_tasks_tenant_status_priority_queued_idx').on(
      t.tenantId,
      t.status,
      t.priority,
      t.queuedAt,
    ),
    index('workforce_tasks_tenant_root_idx').on(t.tenantId, t.rootTaskId),
    index('workforce_tasks_tenant_parent_idx').on(t.tenantId, t.parentTaskId),
  ],
);

/**
 * workforce_task_transitions — the APPEND-ONLY transition log: from, to, reason, actor, turn.
 *
 * The audit spine of the task engine: `applyTransition()` writes exactly one row here in the same
 * transaction as the status UPDATE, so the log and the row can never disagree. Rows are never
 * updated or deleted (append-only by discipline, like `journal_steps`).
 *
 * `turn_number` is set ONLY on the row a turn's final intent application writes, and the partial
 * UNIQUE `(tenant_id, task_id, turn_number)` makes that row the turn's idempotency RECEIPT: a
 * recovered turn workflow whose final transaction already committed finds its receipt and no-ops
 * instead of applying its intents twice.
 */
export const workforceTaskTransitions = pgTable(
  'workforce_task_transitions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    statusReason: text('status_reason'),
    /** Who drove the transition: an owner id, 'user', 'scheduler', or 'system'. */
    actor: text('actor').notNull(),
    /** The dispatched turn's workflow id, when the transition belongs to a turn. */
    turnId: text('turn_id'),
    /** Set only on a turn's final (intent-applying) transition — the turn's receipt. */
    turnNumber: integer('turn_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workforce_transitions_tenant_task_created_idx').on(t.tenantId, t.taskId, t.createdAt),
    // One final application per (task, turn): the recovered-turn no-op detection key.
    uniqueIndex('workforce_transitions_turn_receipt_idx')
      .on(t.tenantId, t.taskId, t.turnNumber)
      .where(sql`${t.turnNumber} is not null`),
  ],
);

/**
 * workforce_task_signals — pending and consumed wake signals; resume is a ROW, not a process.
 *
 * A signal writes one row here and re-queues the target task; the scheduler picks it up like any
 * other queued task. `kind` is a CLOSED set (approval_decided | review_verdict | child_completed |
 * dependency_completed | escalated | user_reply | budget_raised | manual_unblock | cancel).
 * UNIQUE `(tenant_id, task_id, signal_key)` makes delivery IDEMPOTENT: a re-sent signal collides
 * and no-ops instead of waking the task twice. `consumed_at` marks the dispatch that absorbed it.
 */
export const workforceTaskSignals = pgTable(
  'workforce_task_signals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    kind: text('kind').notNull(),
    /** The caller-supplied idempotency key for this delivery (e.g. `approval:<id>`). */
    signalKey: text('signal_key').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Idempotent delivery: one row per (task, signal key), re-sends collide and no-op.
    uniqueIndex('workforce_signals_tenant_task_key_idx').on(t.tenantId, t.taskId, t.signalKey),
  ],
);

/**
 * workforce_delegations — one durable record per parent→child hand-off a fan-out opens.
 *
 * Written in the SAME transaction as the child `workforce_tasks` row and the parent's transition
 * to `blocked(awaiting_children)`, so the delegation record, the child, and the parent state can
 * never disagree. `depth` is the child's ancestry depth at acceptance (the ceiling check input).
 * UNIQUE `(tenant_id, child_task_id)` — a child has exactly one opening delegation, which also
 * makes a re-executed fan-out idempotent alongside the deterministic child ids.
 */
export const workforceDelegations = pgTable(
  'workforce_delegations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    workforceId: text('workforce_id'),
    parentTaskId: text('parent_task_id').notNull(),
    childTaskId: text('child_task_id').notNull(),
    delegatedBy: text('delegated_by').notNull(),
    delegatedTo: text('delegated_to').notNull(),
    resolvedOwner: text('resolved_owner').notNull(),
    /** NULLABLE ONLY SO ERASURE CAN SCRUB IT — the hand-off intent is subject content. */
    goal: text('goal'),
    expectedOutput: text('expected_output'),
    depth: integer('depth').notNull(),
    status: text('status').notNull(),
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    index('workforce_delegations_tenant_parent_idx').on(t.tenantId, t.parentTaskId),
    // A child is opened by exactly one delegation; re-executed fan-outs collide here and no-op.
    uniqueIndex('workforce_delegations_tenant_child_idx').on(t.tenantId, t.childTaskId),
  ],
);

/**
 * workforce_approvals — approval requests, decisions, and their ENFORCED timeout fates.
 *
 * `request_approval` writes a row here, parks the task in `waiting_for_user(approval_pending)`,
 * and ends the turn — NO process waits on a human. The decide route resolves the row, writes an
 * `approval_decided` signal, and the task re-queues. Every request declares `timeout_at` and an
 * `on_timeout` of `fail | escalate`, swept by the scheduler: a hung approval always has an
 * enforced fate, silent indefinite waiting is a defect. `escalate` re-issues the request to the
 * declared `escalate_to` approver (required at request time when `on_timeout` is `escalate` —
 * fail-closed, there is no implicit escalation target).
 */
export const workforceApprovals = pgTable(
  'workforce_approvals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    /**
     * The typed question the human decides. DATA on read, never instructions. NULLABLE ONLY SO
     * ERASURE CAN SCRUB IT — `request_approval` refuses an absent or empty question at plan time.
     */
    question: text('question'),
    options: jsonb('options').notNull().default(sql`'[]'::jsonb`),
    /** Who may decide: 'user' or a named approver id. */
    approver: text('approver').notNull(),
    /** pending | approved | rejected | timed_out | escalated. */
    status: text('status').notNull(),
    decision: text('decision'),
    decidedBy: text('decided_by'),
    reason: text('reason'),
    timeoutAt: timestamp('timeout_at', { withTimezone: true }),
    onTimeout: text('on_timeout').notNull(),
    escalateTo: text('escalate_to'),
    /**
     * The turn whose application opened this request — the DURABLE DEDUPE KEY beneath the receipt.
     * NULL for a request no turn opened: the timeout sweep's escalation re-issue, whose own dedupe
     * is the `status = 'pending'` compare-and-swap that claimed the row it escalates.
     */
    turnNumber: integer('turn_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('workforce_approvals_tenant_status_idx').on(t.tenantId, t.status),
    // The timeout sweep's due scan (`status = pending AND timeout_at < now()`).
    index('workforce_approvals_tenant_timeout_idx').on(t.tenantId, t.timeoutAt),
    // ONE approval per (task, turn) — the second layer beneath the transition receipt, keyed on the
    // same fact and with the same partial shape. See the review index below for why `round`-shaped
    // keys do not work and `turn_number` does.
    uniqueIndex('workforce_approvals_turn_receipt_idx')
      .on(t.tenantId, t.taskId, t.turnNumber)
      .where(sql`${t.turnNumber} is not null`),
  ],
);

/**
 * workforce_reviews — review requests, verdicts, and the per-task round counter the
 * `maxReviewRounds` ceiling is enforced against. A verdict is applied at the engine, never by
 * prose: `reject` re-queues the task for rework, round exhaustion parks it in `waiting_for_user`.
 */
export const workforceReviews = pgTable(
  'workforce_reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    reviewer: text('reviewer').notNull(),
    /** 1-based review round for this task; the maxReviewRounds ceiling input. */
    round: integer('round').notNull(),
    /** accept | reject; NULL while the review is pending. */
    verdict: text('verdict'),
    reasons: jsonb('reasons').notNull().default(sql`'[]'::jsonb`),
    requiredChanges: jsonb('required_changes').notNull().default(sql`'[]'::jsonb`),
    /**
     * The turn whose application opened this review — the DURABLE DEDUPE KEY beneath the receipt.
     * NULL for a row no turn opened (none today; the column stays open for one, exactly as
     * `workforce_task_transitions.turn_number` does).
     */
    turnNumber: integer('turn_number'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('workforce_reviews_tenant_task_idx').on(t.tenantId, t.taskId, t.round),
    /**
     * ONE review per (task, turn) — the second layer beneath the transition receipt.
     *
     * WHY `turn_number` AND NOT `round`. `round` is not an input to the turn: it is DERIVED from
     * the number of review rows that already exist (`reviewRoundsUsed = reviewRows.length`,
     * `round = reviewRoundsUsed + 1`). A second application of the SAME turn therefore computes a
     * DIFFERENT round, so a UNIQUE on `(tenant_id, task_id, round)` would admit exactly the
     * duplicate it was added to prevent — and, being retro-fitted onto a populated column, could
     * fail at migration time on a database that already holds two rows of one round.
     * `turn_number` is an INPUT (`ApplyTurnInput.turnNumber`), so it is stable across replay; and
     * because the column is NEW, every pre-existing row holds NULL — and NULLs are DISTINCT for
     * uniqueness — so this index constrains no existing row and cannot fail on a populated table.
     * That unfailability comes from the KEY (new + all-NULL), not from the partial predicate: a
     * total UNIQUE on the same column would create just as cleanly. The predicate is here to match
     * `workforce_transitions_turn_receipt_idx`'s shape and to keep the index off the turn-less rows
     * the approval sweep writes, which Postgres would admit under a total UNIQUE anyway.
     */
    uniqueIndex('workforce_reviews_turn_receipt_idx')
      .on(t.tenantId, t.taskId, t.turnNumber)
      .where(sql`${t.turnNumber} is not null`),
  ],
);

/**
 * workforce_messages — task-scoped messages between task owners. Messages are CONTEXT for a later
 * turn, never instructions to the platform; the body is untrusted DATA end to end.
 */
export const workforceMessages = pgTable(
  'workforce_messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    taskId: text('task_id').notNull(),
    sender: text('sender').notNull(),
    recipient: text('recipient').notNull(),
    /** NULLABLE ONLY SO ERASURE CAN SCRUB IT — the body is untrusted subject content end to end. */
    body: text('body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('workforce_messages_tenant_task_created_idx').on(t.tenantId, t.taskId, t.createdAt),
  ],
);

/**
 * workforce_budget_ledger — reservations and settlements per enforcement scope.
 *
 * ONE ROW PER `(tenant, scope_kind, scope_id, window_start)`: `task`, `root` (subtree),
 * `department` and `workforce` scopes; `window_start` is the window bucket for windowed workforce
 * ceilings and a fixed epoch sentinel for the un-windowed scopes so the UNIQUE key stays total.
 *
 * The authorize/settle protocol locks rows via `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
 * (a REAL update — `DO NOTHING` would not lock the existing row) in ONE canonical order
 * (task < root < department < workforce), checks ceilings on the locked values, and only then
 * reserves. Settlement may exceed the reservation ONCE (a turn is never aborted mid-flight);
 * the overrun counts against the next authorize. Denial mutates NOTHING.
 */
export const workforceBudgetLedger = pgTable(
  'workforce_budget_ledger',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** task | root | department | workforce. */
    scopeKind: text('scope_kind').notNull(),
    scopeId: text('scope_id').notNull(),
    /** Window bucket start for windowed ceilings; the epoch sentinel for un-windowed scopes. */
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    reservedUsd: numeric('reserved_usd').notNull().default('0'),
    settledUsd: numeric('settled_usd').notNull().default('0'),
    settledTurns: integer('settled_turns').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One ledger row per scope per window — the upsert conflict target and the lock identity.
    uniqueIndex('workforce_ledger_scope_idx').on(t.tenantId, t.scopeKind, t.scopeId, t.windowStart),
  ],
);

/**
 * workforce_runtime — ONE row per workforce: operator control state and declared ceilings.
 *
 * `paused` is deliberately a flag HERE and not a task status: a paused workforce's tasks stay
 * visibly `queued` (the scheduler just stops reserving them), so pausing at night and resuming in
 * the morning loses nothing and burns nothing. `budgets` is the strict-validated ceiling
 * declaration the ledger enforces (usd/turns per scope, per-department ceilings, delegation depth
 * and fan-out caps, worker concurrency, wall clock, review rounds, exhaustion policy).
 * `last_event_seq` is the seq HEAD for the workforce's own control-event journal stream.
 */
export const workforceRuntime = pgTable(
  'workforce_runtime',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    workforceId: text('workforce_id').notNull(),
    paused: boolean('paused').notNull().default(false),
    pausedAt: timestamp('paused_at', { withTimezone: true }),
    pausedBy: text('paused_by'),
    haltReason: text('halt_reason'),
    haltedAt: timestamp('halted_at', { withTimezone: true }),
    /** The declared ceiling configuration (strict-validated on write; closed keys). */
    budgets: jsonb('budgets').notNull().default(sql`'{}'::jsonb`),
    /** The last journal seq ISSUED for this workforce's control-event stream. */
    lastEventSeq: integer('last_event_seq').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workforce_runtime_tenant_workforce_idx').on(t.tenantId, t.workforceId)],
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
  invites,
  workflowRuns,
  workflowNodeStates,
  workflowArtifacts,
  tenantEvents,
  tenantEventStreams,
  workforceTasks,
  workforceTaskTransitions,
  workforceTaskSignals,
  workforceDelegations,
  workforceApprovals,
  workforceReviews,
  workforceMessages,
  workforceBudgetLedger,
  workforceRuntime,
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
