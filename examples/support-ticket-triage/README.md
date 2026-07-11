# Support Ticket Intake & Triage — the fully-live, no-agent reference

This is the counterpart that exercises the platform's **data-plane** with **NO extraction agent**,
so — unlike the
`expense-claim-coder` acceptance product — it has **no deterministic-only caveat**: it boots and
runs end-to-end on real data with no LLM in the path.

## What it proves (the components, in one bootable doc)

- the `record_submitted` trigger event (a record-scoped single-flight idempotency key).
- declared typed stores + `store_read` (a bounded catalog read **filtered by the submitted
  `product_area`**) + `store_write` (UPSERT on the declared conflict key `ticket_ref`).
- the generic Tier-B ingress capability `record_input` → `POST /records/{record_id}/submit`.
- conditional composition: NO audio **and** NO agent, so the boot demands **no** blob/media/STT
  env **and no** `RAYSPEC_EXTRACTION_MODE` — the leanest possible non-audio boot.

## Boot it (the CI-proven path)

Because there is no agent, this product needs **no injected executor at all** — it boots through the
real composed `@rayspec/server` stack directly. The merge-gated e2e
(`packages/app/server/src/support-ticket-triage-e2e.db.test.ts`) IS that boot and proves the whole loop
end-to-end (boot → submit → `store_read`(filtered) → `store_write` → the views → dedup → 401):

```bash
pnpm db:up   # Postgres :5433
RAYSPEC_REQUIRE_DB_TESTS=true DATABASE_URL="postgres://…:5433/<db>" \
  pnpm --filter @rayspec/server test support-ticket-triage-e2e
```

**LOCAL / single-node / trusted posture / NOT internet-facing** — the separate hardening layer
(per-tenant sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure.

## Run it interactively + the demo UI

Two throwaway helpers in this dir turn the backend into a clickable ticket system — a demo UI that runs
on a **YAML-only backend, with no product code**:

- **`dev-boot.mjs`** — a thin LOCAL boot wrapper. This product can't boot through the bare
  `@rayspec/server` entrypoint (`deploy()`'s tenant-scoping chokepoint fail-closes on an unregistered
  product table — deny-by-default); this wrapper supplies the registration at runtime (the documented
  LOCAL stand-in). No agent + no audio ⇒ no extraction/blob/media/STT env needed.
- **`demo-ui.py`** — a single-page ticket UI (stdlib only) that also proxies its `/api/*` calls to the
  backend with a bearer token it mints itself (login + org-switch, refreshed on 401), so the browser is
  same-origin (no CORS) and the token never touches the page.

```bash
# 1. a throwaway DB + boot the backend on :8791 (Terminal 1 — leave it running)
createdb -h localhost -p 5433 -U rayspec play_ticket
node examples/support-ticket-triage/dev-boot.mjs

# 2. seed the deployment tenant + the routing catalog + a user (Terminal 2, once)
#    (a reference catalog is deployment-seeded by design — there is no product write/admin API)
PLAY="postgres://rayspec:rayspec@localhost:5433/play_ticket"
TEN="00000000-0000-4000-8000-000000000042"
psql "$PLAY" \
  -c "INSERT INTO orgs (id,name,slug) VALUES ('$TEN','Support Co','support-co') ON CONFLICT DO NOTHING" \
  -c "INSERT INTO routing_policies (tenant_id,product_area,owning_team,default_priority) VALUES ('$TEN','billing','billing-ops','high'),('$TEN','auth','identity-team','urgent') ON CONFLICT DO NOTHING"
curl -s -X POST http://127.0.0.1:8791/v1/auth/register -H 'content-type: application/json' \
  -d '{"email":"me@play.local","password":"a-long-enough-password"}' >/dev/null
USERID=$(psql "$PLAY" -tAc "SELECT id FROM users WHERE email='me@play.local'")
psql "$PLAY" -c "INSERT INTO memberships (org_id,user_id,role,status) VALUES ('$TEN','$USERID','owner','active') ON CONFLICT DO NOTHING"

# 3. the demo UI (Terminal 2) → open http://127.0.0.1:8080
python3 examples/support-ticket-triage/demo-ui.py
```

Submit a ticket in the UI, watch it appear in the list `triaged` with the routing team it was matched to
(`billing → billing-ops`, `auth → identity-team`). Cleanup: `Ctrl-C` both, then
`dropdb -h localhost -p 5433 -U rayspec play_ticket` (+ `play_ticket_dbos_sys`). These helpers are
LOCAL-dev only, never internet-facing.

## Validate / preview (the CLI)

```bash
node packages/app/cli/dist/index.js doctor  examples/support-ticket-triage/support-ticket-triage.product.yaml
node packages/app/cli/dist/index.js plan    examples/support-ticket-triage/support-ticket-triage.product.yaml
node packages/app/cli/dist/index.js openapi examples/support-ticket-triage/support-ticket-triage.product.yaml
```

## Notes & gotchas

Three real gotchas worth knowing when declaring a data-plane product like this — all handled in this
config, none a platform bug:
1. **A `store_read` snapshot column is an ARRAY.** The routing snapshot lands in a `jsonb` column that
   holds the read's *rows* (an array). The view field must be `type: array`, not `type: object` — the
   acceptance example only demonstrates an object-valued jsonb column (`coded`), so an array-valued one
   is easy to mis-map (the view returns `null` on the type mismatch). Fixed by declaring `type: array`.
2. **A divergent re-submit is a 409, not a dedup.** The ingress keys idempotency on the canonical-JSON
   hash of the payload, so a re-submit of the same `record_id` with a *changed/dropped field* is
   correctly rejected `409 record_conflict`. The dedup (`deduped: true`) requires a **byte-identical**
   (reordering-tolerant) re-submit.
3. **The lookup result cannot be decomposed into scalar columns** (no transform node in the grammar) —
   it is snapshotted whole as jsonb. Fine for this product; a genuine scope boundary to know up front.
