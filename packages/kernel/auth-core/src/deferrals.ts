/**
 * The before-external-exposure deferral line — EXPLICIT, in code, so the boundary is auditable.
 *
 * The following are NOT shipped yet (they are gated to BEFORE external/SaaS exposure). The
 * platform deliberately ships the forward-compatible HOOKS for each so enabling them is a
 * config/policy change, not a re-architecture:
 *
 *   - KMS per-tenant DEK + crypto-shred         → hook: orgs.region + ON DELETE CASCADE purge of
 *                                                  the at-rest raw-PII columns: the jsonb
 *                                                  payloads conversation_items.payload, runs.output,
 *                                                  journal_steps.output, run_events.data + the text
 *                                                  runs.final_text. (NOT conversation_items.content
 *                                                  — deprecated legacy column, part data now lives in
 *                                                  payload; see schema.ts.)
 *   - Postgres Row-Level Security (RLS)          → hook: the TenantDb.transaction() set_config
 *                                                  app.current_tenant GUC seam (TENANT_GUC) — RLS
 *                                                  policies bind to an already-populated GUC with
 *                                                  zero call-site churn.
 *   - DPoP-bound access tokens                   → hook: the jose access-token module (add a cnf
 *                                                  claim + DPoP proof verification).
 *   - Per-tenant tool/handler sandbox            → hook: the neutral Backend boundary + per-tenant
 *                                                  CLAUDE_CONFIG_DIR isolation already in the
 *                                                  Anthropic adapter.
 *   - jti denylist (immediate token revocation)  → hook: the jti claim is minted on every token;
 *                                                  the opaque session is the revocation point
 *                                                  (the ~8-min TTL bounds stateless-read staleness).
 *
 * This constant is exported so a grep for `SECURITY_DEFERRALS_10B` finds the single source of the
 * deferral record; it is referenced by the docs and intentionally never used as runtime logic.
 */
export const SECURITY_DEFERRALS_10B = [
  'kms-per-tenant-dek-crypto-shred',
  'postgres-row-level-security',
  'dpop-bound-tokens',
  'per-tenant-tool-sandbox',
  'jti-denylist',
] as const;

export type SecurityDeferral10B = (typeof SECURITY_DEFERRALS_10B)[number];
