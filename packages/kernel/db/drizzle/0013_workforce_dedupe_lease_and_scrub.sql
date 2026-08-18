-- workforce_dedupe_lease_and_scrub: the ONE coordinated persisted-shape change of the M1 freeze.
-- Three items, one migration, because release engineering reviews one migration for the freeze and
-- a self-hoster reasons about one upgrade step.
--
-- REVIEWED: generated with `drizzle-kit generate` against the 0012 snapshot and read
-- statement-by-statement before committing (the mandated generate → read the SQL diff → correct
-- discipline). The generated diff was CLEAN — exactly the six nullability relaxations, the three
-- new nullable columns and the two partial UNIQUEs below, nothing else — so it is committed as
-- generated, with this header added and the journal tag renamed to a descriptive one.
--
-- SAFE ON A POPULATED DATABASE, WITH NO BACKFILL. Every added column is NULLABLE, so no existing
-- row can violate it and no default has to be written; `DROP NOT NULL` never fails on data; and
-- because `turn_number` is a NEW column, every pre-existing review/approval row holds NULL — and
-- NULLs are DISTINCT for uniqueness — so the two UNIQUE indexes constrain ZERO existing rows and
-- CANNOT fail at migration time on a database that already holds duplicate review rounds. That
-- unfailability is a property of the KEY CHOICE (new + all-NULL), not of the partial predicate: a
-- total UNIQUE on the same new column would create just as cleanly. What the choice is measured
-- against is `round`, which is `integer NOT NULL` and already populated — a UNIQUE on
-- `(tenant_id, task_id, round)` genuinely CAN fail on an existing database, which is the second
-- reason it is the wrong key (see below for the first).
-- DESTRUCTIVE-SCAN: only ALTER COLUMN ... DROP NOT NULL / ADD COLUMN (nullable) / CREATE UNIQUE
-- INDEX — no destructive statement, so the scan has no findings and needs no allowlist entry.
-- Forward-only (D-013): rolling the binary back is safe — older releases never read the new columns,
-- and a relaxed NOT NULL is a superset of what they wrote.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 1. THE DURABLE DEDUPE KEY beneath the turn receipt (B-013a).
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- Children already had two layers against a re-applied turn: a deterministic primary key AND
-- `workforce_delegations_tenant_child_idx` UNIQUE, both beneath the transition receipt. Reviews and
-- approvals had NEITHER — `workforce_reviews` carried only a NON-unique (tenant_id, task_id, round)
-- index and `workforce_approvals` carried no uniqueness at all — so the receipt read at the top of
-- `applyTurnOutcome` was the only thing between a replayed turn and a second row.
--
-- The key is `turn_number`, NOT `round`. `round` is not an input to the turn: it is DERIVED from the
-- number of review rows that already exist (`reviewRoundsUsed = reviewRows.length`, then
-- `round = reviewRoundsUsed + 1`), so a second application of the SAME turn computes a DIFFERENT
-- round and a UNIQUE on (tenant_id, task_id, round) would admit exactly the duplicate it was added
-- to prevent. `turn_number` is an INPUT (`ApplyTurnInput.turnNumber`) and is therefore stable across
-- replay — the same fact, and the same partial-UNIQUE shape, as
-- `workforce_transitions_turn_receipt_idx` in 0012.
--
-- Some rows carry NO turn at all: the approval-timeout sweep re-issues an escalated request outside
-- any turn, writes `turn_number = NULL`, and is deduped by the `status = 'pending'` compare-and-swap
-- that claimed the row it escalates rather than by this index. The index is PARTIAL to say that
-- explicitly, to match `workforce_transitions_turn_receipt_idx`'s shape, and to keep the index off
-- rows it can never constrain — NOT because a total UNIQUE would have refused them. It would not:
-- Postgres treats NULLs as DISTINCT for uniqueness, so a total UNIQUE admits unlimited turn-less
-- rows AND still refuses a duplicate `(task, turn)`. Partial and total are behaviourally identical
-- for every row shape this schema can produce; partial is the honest declaration of intent, not a
-- correctness requirement.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 2. THE CLAIM LEASE — a liveness backstop for a turn the engine still calls live (B-013b).
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `workforce_tasks.claim_expires_at` is stamped by `applyTransition` in the SAME compare-and-swap
-- UPDATE that writes `working` (so it cannot disagree with the claim it describes) and cleared by
-- every transition out of `working` (so a stale expiry is never readable on an unclaimed row).
-- Before it, the reaper's only liveness oracle was a DBOS workflow-status query, which cannot see a
-- worker whose process is up and whose workflow is PENDING but whose BODY is wedged: such a turn
-- reached neither release path — not `settleTurn` (the turn never finishes) and not the reaper (the
-- engine said PENDING) — so it held its concurrency slot and its budget reservation FOREVER, and the
-- `task`/`root` ledger scopes never roll over, which made the stranded estimate permanent. An
-- expired lease is now reaped through the IDENTICAL path as a dead claim: same requeue, same
-- release of what the claim actually reserved, in the window it reserved it in.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- 3. SIX NULLABILITY RELAXATIONS so `journalScrub` stops destroying the ledger (B-018c / D-030 i).
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- `journalScrub: true` is the softer erasure posture: it NULLs raw subject content while KEEPING
-- every structural, idempotency and cost column, so billing reconciliation survives. The workforce
-- tables were not in the scrub set, so scrub mode hard-deleted all nine — `workforce_budget_ledger`
-- included, which is the workforce analogue of exactly the cost columns scrub exists to retain. The
-- mode inverted its own purpose. Scrubbing the CONTENT instead requires these six `text NOT NULL`
-- columns to accept NULL; they are the COMPLETE set of `text NOT NULL` content columns across the
-- nine tables. Everything else the scrub erases needed no schema change (`description`, `result` and
-- `reason` are already nullable; the jsonb list columns are emptied to their own declared `'[]'` /
-- `'{}'` rather than gratuitously made nullable on a released schema).
--
-- NULLABLE HERE MEANS "ERASED", NOT "OPTIONAL". Every write path still requires all six — the task
-- creation schema refuses an absent or empty title/goal, `request_approval` refuses an empty
-- question, a hand-off refuses an empty goal/expected output. A NULL in one of these columns has
-- exactly one meaning: this tenant's content was scrubbed while its ledger and structure were kept.
ALTER TABLE "workforce_approvals" ALTER COLUMN "question" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workforce_delegations" ALTER COLUMN "goal" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workforce_delegations" ALTER COLUMN "expected_output" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workforce_messages" ALTER COLUMN "body" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workforce_tasks" ALTER COLUMN "title" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workforce_tasks" ALTER COLUMN "goal" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workforce_approvals" ADD COLUMN "turn_number" integer;--> statement-breakpoint
ALTER TABLE "workforce_reviews" ADD COLUMN "turn_number" integer;--> statement-breakpoint
ALTER TABLE "workforce_tasks" ADD COLUMN "claim_expires_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_approvals_turn_receipt_idx" ON "workforce_approvals" USING btree ("tenant_id","task_id","turn_number") WHERE "workforce_approvals"."turn_number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workforce_reviews_turn_receipt_idx" ON "workforce_reviews" USING btree ("tenant_id","task_id","turn_number") WHERE "workforce_reviews"."turn_number" is not null;