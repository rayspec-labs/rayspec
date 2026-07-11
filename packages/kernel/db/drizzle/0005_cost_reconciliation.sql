-- Cost reconciliation + provenance.
--
-- REVIEWED, hand-authored (never blind autogenerate). Purely ADDITIVE — only ADD COLUMN with
-- safe defaults on two existing tables (journal_steps + the runs roll-up). No table rebuild, no data
-- migration, no destructive statement (the home-grown destructive scan therefore has NO findings and
-- needs no allowlist entry — the lowest-risk evolution).
--
-- journal_steps (the per-step ledger — the single source of truth):
--   provider_cost_usd  numeric  NULLABLE  — the SDK-reported cost (Anthropic total_cost_usd,
--                                           Pi usage.cost.total); NULL for OpenAI (no provider cost).
--                                           Never fabricated — NULL means "the backend reported none".
--   billed_cost_usd    numeric  NOT NULL default '0' — 0 for a subscription run
--                                           (auth_mode='subscription-oauth-official-harness'), else the
--                                           computed cost. The attributed (computed/provider) cost is
--                                           still recorded as a value metric in cost_usd/provider_cost_usd.
--   cost_drift         boolean  NOT NULL default false — set when |computed - provider| exceeds the
--                                           documented drift threshold (a real reconciliation divergence).
--   produced_by        text     NULLABLE  — provenance: the SDK + adapter version that wrote the step.
--   pricing_version    text     NULLABLE  — provenance: the effective-dated pricing entry that COMPUTED
--                                           this step's cost (`<model>@<effectiveFrom>`, or 'FALLBACK'
--                                           when the model/date had no registry entry) — so a
--                                           fallback-priced step is DISTINGUISHABLE in the ledger.
--
-- runs (the run header roll-up):
--   provider_cost_usd  numeric  NULLABLE  — sum of the steps' provider cost (NULL when NO step reported).
--   billed_cost_usd    numeric  NOT NULL default '0' — sum of billed cost (0 for a subscription run).
--   cost_drift         boolean  NOT NULL default false — true iff ANY step drifted.
--
-- A NOT NULL ADD COLUMN with a constant DEFAULT is a metadata-only operation on PG11+ (no full table
-- rewrite), so this is cheap even on a populated table. The new columns are tenant-scoped by virtue of
-- living on already-tenant-scoped tables (journal_steps + runs are in TENANT_SCOPED_TABLES) — no new
-- tenant predicate surface is introduced.

ALTER TABLE "journal_steps" ADD COLUMN "provider_cost_usd" numeric;--> statement-breakpoint
ALTER TABLE "journal_steps" ADD COLUMN "billed_cost_usd" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_steps" ADD COLUMN "cost_drift" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_steps" ADD COLUMN "produced_by" text;--> statement-breakpoint
ALTER TABLE "journal_steps" ADD COLUMN "pricing_version" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "provider_cost_usd" numeric;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "billed_cost_usd" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_drift" boolean DEFAULT false NOT NULL;
