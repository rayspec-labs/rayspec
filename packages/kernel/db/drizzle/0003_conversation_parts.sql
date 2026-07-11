-- conversation_items: flat item -> ConvTurn/ConvPart transcript (additive).
--
-- REVIEWED, hand-authored (never blind autogenerate). drizzle-kit's autogen produced a
-- CONTAMINATED diff here (it re-created idempotency_keys / oidc_models / sessions.revoked_reason
-- because the 0001/0002 hand-authored migrations were intentionally journal-only with no captured
-- snapshot, so the generator diffed against the stale 0000 snapshot). The autogen output was
-- discarded and this migration hand-written to contain ONLY the conversation_items evolution —
-- exactly the "generate, read the SQL diff, correct" discipline mandated.
--
-- Purely ADDITIVE: four new NULLABLE columns + relaxing the legacy `content` NOT NULL so a
-- part row can write `payload`/`kind`/`turn_index` and leave the legacy text columns null.
-- A part row stores ONE neutral ConvPart as the `payload` jsonb (ATTACKER-CONTROLLED — validated
-- ON READ via validateConversation); `role` is the TRUSTED turn role column, never inferred
-- from payload. The tenant predicate is unchanged (conversation_items stays in TENANT_SCOPED_TABLES).
--
-- DESTRUCTIVE-SCAN: `ALTER COLUMN ... DROP NOT NULL` is a constraint RELAXATION (it never rewrites
-- or drops data), so the home-grown destructive scan has no findings — no allowlist entry needed.

ALTER TABLE "conversation_items" ALTER COLUMN "content" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "turn_index" numeric;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "conversation_items" ADD COLUMN "payload" jsonb;
