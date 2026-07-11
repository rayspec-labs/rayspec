-- Record WHY a session was revoked.
--
-- REVIEWED, hand-authored (never blind autogenerate). Purely ADDITIVE — one nullable column
-- on `sessions`; nothing destructive, so the home-grown destructive-scan has no findings.
--
-- A benign post-logout refresh of a stale cookie must NOT be misclassified as token-reuse: logout
-- revokes a session with reason 'logout', refresh-reuse/family-revoke uses 'reuse'. The refresh
-- path returns a uniform 401 for a 'logout'-revoked session (no reuse audit / no per-source lock)
-- and only drives the family-revoke + audit + lock for 'reuse'. NULL on a live session.

ALTER TABLE "sessions" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
