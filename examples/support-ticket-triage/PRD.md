# PRD — Support Ticket Intake & Triage

A back-office **document/event pipeline** — a **different** product than the `expense-claim-coder`
acceptance example, and deliberately the **fully-working live path** (NO extraction agent).

## What it does

- An authenticated client **submits a support ticket** as JSON — fields: `requester_email`, `subject`,
  `body`, `product_area`. This is an authenticated **ingress submit** (`record_input`), not audio.
- On submit, a durable workflow runs:
  1. **reads a routing-policy catalog** (`product_area → owning_team + default_priority`) from a
     declared store, **filtered by the submitted `product_area`**;
  2. **records the triaged ticket** into a declared `triaged_tickets` store, idempotent by the ticket
     reference (the record id), stamping `status: triaged` and snapshotting the matched routing row.
- Two **read views**: `GET /tickets/{ticket_ref}` (a single triaged ticket) and `GET /tickets` (the
  paged list).

## Non-goals (honest scope)

- **Non-audio** — no recording, no playback, no STT.
- **No extraction agent** — routing is a pure catalog lookup + persist, so the pipeline runs end-to-end
  with a **real LLM-free** path (no deterministic-only caveat; the non-audio *live-extraction*
  generalization is a separate named follow-on that this product does not need).
- **No product write/admin API** — reads are GET views; writes flow through the ingress + workflow only
  (`assertProductScope` enforces this). Single persistence scope (`record`).
- The routing lookup lands as a **whole jsonb snapshot** on the ticket row — the grammar has no
  transform/project node to decompose it into scalar columns.
