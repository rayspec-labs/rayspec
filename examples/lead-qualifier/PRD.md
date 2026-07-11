# PRD — Lead Qualifier

> The plain-language product brief for `lead-qualifier.rayspec.yaml`. It is a backend-profile document
> whose declared agent actually runs: an inbound lead is qualified off-request by a live agent.

## The product

A sales team wants inbound leads triaged the moment they arrive, without a human doing first-pass
qualification. When a lead comes in, the system should classify it — a **tier** (enterprise,
mid-market, or SMB), a **fit score**, the **owning queue** it should route to, and a one-line
**rationale** — and record that verdict on the lead so the CRM/UI can show it.

## Users & jobs

- **Submitter (a website form / integration):** POSTs a lead
  `{ company, contact_email, message, headcount }` to the ingress endpoint and gets back the created
  lead id immediately. Qualification happens in the background.
- **Sales reviewer (read):** GETs a single qualified lead, and GETs the list of this team's leads.

## What happens to a lead (the flow)

1. **Ingest** the lead (an authenticated POST; the payload — especially the free-text `message` — is
   DATA, never instructions). Store it as `unqualified`.
2. **Enqueue** a durable qualify run for the lead — the agent runs OFF the request, so the POST
   returns right away.
3. **Qualify** with a single agent: assign a tier, a fit score, an owning queue, and a short
   rationale, grounded in the submitted fields.
4. **Record** the verdict by calling one persist tool that updates the lead and flips it to
   `qualified` (idempotent — update by id converges).
5. **Serve** the lead (detail) and the list.

## Rules & posture

- One tier + one owning queue per lead, both from a fixed set of values (the tool's schema enforces
  the enums — the model cannot invent a tier or queue).
- The qualify run is off-request (durable worker), so a slow model call never blocks the ingress.
- Reads are GET endpoints served directly from the store; there is no product edit/delete endpoint —
  the only writes are the ingress insert and the qualify tool.
- LOCAL / single-node / trusted-author posture (not internet-facing without the separate hardening
  layer — handlers run in-process).

## Explicitly out of scope (v1)

- Enrichment from third-party data sources, lead deduplication, or assignment to a specific rep.
- A product-declared mutation/admin API (edit or reassign a lead by hand).
- Multi-step routing/approval workflows beyond the single qualify run.

## How this maps to the document

| PRD need | Document construct |
| --- | --- |
| Authenticated submit ingress | a `{ kind: handler }` route (`POST /leads` → `ingest_lead`) |
| Run the agent off-request | `deployment.durableWorker: true` + `init.enqueue` in the ingress handler |
| Classify the lead | a declared `agent` (`qualifier`, `backend: openai`) |
| Enforce the verdict shape | the `save_qualification` tool's `parameters` (tier/queue enums, required) |
| Record the verdict | the `save_qualification` tool handler (`db.update` by lead id) |
| Lead detail + list reads | two declarative `{ kind: store }` routes over `leads` |
