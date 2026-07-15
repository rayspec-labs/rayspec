/**
 * The neutral store schema this Tier B capability owns (the record/file `stores.ts` pattern).
 * Product-neutral names + only standard column types (text/integer), so it rides the UNCHANGED
 * migration/chokepoint path exactly as an inline product store would. The tenancy/GDPR columns
 * (id, tenant_id, created_at, deleted_at, retention_days, region) are INJECTED by the generator,
 * never declared here — which is also why `eraseTenant` covers BOTH stores like every other
 * tenant-scoped table (the turn ledger is RAW PII; the retention pin).
 *
 * ── KEYING (the audio/record/file pattern, mirrored on purpose) ───────────────────────────────
 * The platform's generated single-column UNIQUE is GLOBAL, so every unique ref embeds the
 * SERVER-DERIVED tenant id (keys.ts). That makes both stores PER-TENANT-KEYED BY CONSTRUCTION —
 * not the declared-store deployment-global-key caveat class.
 *
 * ── THE LEDGER'S TWO UNIQUES (the C10 turn state machine's authorities) ───────────────────────
 * `turn_ref`  (`${tenantId}:${conversationId}:${messageId}`) — the DEDUP authority: a re-POST of
 *             one message converges on one row/one event/one durable run.
 * `seq_ref`   (`${tenantId}:${conversationId}:${turnSeq}`)   — the ORDERING authority: two turns
 *             racing one conversation collide here and resolve LOUD (typed 409), never by silent
 *             overwrite (the anti-quadratic ledger is INSERT-only — no upsert can eat a race).
 *
 * ── THE ANTI-QUADRATIC LAW (design-binding) ──────────────────────────────────────
 * A ledger row stores ONLY its own message (the new user message now; the assistant reply
 * later) — NEVER serialized history. The model input is composed transiently from a bounded
 * read window over these rows.
 */
import type { StoreSpec } from '@rayspec/spec';

/** The capability id (the Product-YAML `capabilities[].id` this runtime serves). */
export const CONVERSATION_INPUT_CAPABILITY_ID = 'conversation_input';

/** The declared neutral store name of the conversation HEAD rows. */
export const CONVERSATIONS_STORE = 'conversations';

/** The declared neutral store name of the turn LEDGER rows. */
export const CONVERSATION_TURNS_STORE = 'conversation_turns';

/**
 * The capability's store names as a set — the single source for store-derivation callers (the
 * server boot + the CLI pass it to `deriveProductStores`, unioned with the audio/record/file
 * names, to tell capability-owned stores apart from a product's declared stores — the shared
 * store-name-derivation pattern).
 */
export const CONVERSATION_STORE_NAMES: ReadonlySet<string> = new Set([
  CONVERSATIONS_STORE,
  CONVERSATION_TURNS_STORE,
]);

/**
 * The capability's store definitions. A deployment mounting the capability merges these into the
 * composed `stores[]`; the deploy path materializes them via the SAME generator every store uses.
 */
export function conversationCapabilityStores(): StoreSpec[] {
  return [
    {
      name: CONVERSATIONS_STORE,
      columns: [
        // The client-chosen conversation id (DATA; the handlers filter by ref, never by this alone).
        { name: 'conversation_id', type: 'text', nullable: false, unique: false },
        // Tenant-namespaced single-column UNIQUE (= `${tenantId}:${conversation_id}`) — the
        // idempotent-create authority. The tenant is server-derived (see the module header).
        { name: 'conversation_ref', type: 'text', nullable: false, unique: true },
        // THE OWNER SEAM: the end-user identity column, NULL in v1 (auth is org-member
        // bearer on every surface). Ships day-one so the external-exposure end-user story is a value
        // change, not a migration. Never a trust signal.
        { name: 'owner', type: 'text', nullable: true, unique: false },
        // The optional client display title — escaped DATA ONLY: shape-bounded at
        // intake, NEVER part of any key, path, or id.
        { name: 'title', type: 'text', nullable: true, unique: false },
        // The head lifecycle state ('open' — the only value today; closing is a later fork).
        { name: 'state', type: 'text', nullable: false, unique: false },
        // The create timestamp (ISO-8601 text — the capability sets it; created_at is injected).
        { name: 'opened_at', type: 'text', nullable: false, unique: false },
      ],
      foreignKeys: [],
    },
    {
      name: CONVERSATION_TURNS_STORE,
      columns: [
        // The parent conversation (DATA id + the tenant-prefixed head ref the reads filter by).
        { name: 'conversation_id', type: 'text', nullable: false, unique: false },
        { name: 'conversation_ref', type: 'text', nullable: false, unique: false },
        // The client-supplied per-turn message id (DATA; dedup keys off turn_ref, never this alone).
        { name: 'message_id', type: 'text', nullable: false, unique: false },
        // The DEDUP authority (= `${tenantId}:${conversation_id}:${message_id}`) — module header.
        { name: 'turn_ref', type: 'text', nullable: false, unique: true },
        // The 1-based position within the conversation.
        { name: 'turn_seq', type: 'integer', nullable: false, unique: false },
        // The ORDERING authority (= `${tenantId}:${conversation_id}:${turn_seq}`) — module header.
        { name: 'seq_ref', type: 'text', nullable: false, unique: true },
        // 'user' | 'assistant' (the reply row).
        { name: 'role', type: 'text', nullable: false, unique: false },
        // The message TEXT — RAW PII DATA stored verbatim (types.ts trust boundary): escaped DATA,
        // never rendered as instructions; NEVER serialized history (the anti-quadratic law).
        { name: 'message', type: 'text', nullable: false, unique: false },
        // THE RUN SEAM: the durable run that produced/answers this turn (NULL until a reply runs).
        { name: 'run_id', type: 'text', nullable: true, unique: false },
        // The turn lifecycle state ('submitted' at intake; the reply-side states are added on reply).
        { name: 'state', type: 'text', nullable: false, unique: false },
        // The submit timestamp (ISO-8601 text — the capability sets it; created_at is injected).
        { name: 'submitted_at', type: 'text', nullable: false, unique: false },
      ],
      foreignKeys: [],
    },
  ];
}
