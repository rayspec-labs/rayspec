# Lead Qualifier — a backend-profile example with a live agent that runs

A small, real **backend-profile** document whose declared agent **actually runs**. Where a
validate-only backend showcase only proves the six-section grammar parses, this one **boots through
the shipped server entrypoint and runs its agent end-to-end**: you POST a lead, and a declared agent
qualifies it **off-request** on the durable worker, recording its verdict by calling a persist tool.

- `lead-qualifier.rayspec.yaml` — the authored backend document (stores + api + agents + tooling +
  handlers + `deployment.durableWorker`).
- `handlers/lead-handlers.mjs` — the two escape-hatch handlers: the ingress route (`ingest_lead`,
  which enqueues the durable qualify run) and the persist tool (`save_qualification`).
- `PRD.md` — the plain-language brief.
- `smoke.sh` — an optional end-to-end curl walkthrough.

## What it does

```
POST /leads   →  ingest_lead inserts the lead as `unqualified`, enqueues a durable `qualifier` run, → 201
                 (the agent runs OFF-REQUEST on the durable worker)
   worker      →  the `qualifier` agent classifies the lead and calls save_qualification exactly once
   tool        →  save_qualification updates the lead by id: tier / fit_score / owning_queue /
                  rationale, and flips `status` to `qualified`
GET /leads     →  list this tenant's leads         (declarative store route — no handler code)
GET /leads/{id}→  read one qualified lead           (declarative store route — no handler code)
```

The agent treats the lead — especially its free-text `message` — strictly as untrusted **data**, never
as instructions. Every store touch is tenant-scoped by the platform's structural predicate, so a run
can only ever read or write its own tenant's leads.

## Validate (no DB, no deploy)

```bash
rayspec doctor  examples/lead-qualifier/lead-qualifier.rayspec.yaml
rayspec plan    examples/lead-qualifier/lead-qualifier.rayspec.yaml
```

## Boot it directly on the shipped entrypoint (LOCAL, trusted posture)

This document boots through the **real** server entrypoint (`@rayspec/server`) with **no hand-written
wrapper** — the shipped `rayspec-serve` reads the spec, materializes the `leads` store, mounts the
routes, wires the durable worker, and builds the `openai` agent backend from `OPENAI_API_KEY` itself:

```bash
pnpm db:up   # Postgres on :5433

# Point DATABASE_URL at a FRESH, EMPTY database — rayspec-serve applies the migration chain but does
# NOT drop/create the DB. (examples/local-boot is the dev convenience that provisions a throwaway one.)
RAYSPEC_SPEC_PATH=$(pwd)/examples/lead-qualifier/lead-qualifier.rayspec.yaml \
RAYSPEC_HANDLER_ROOT=$(pwd)/examples/lead-qualifier \
DATABASE_URL="postgres://…:5433/<a-fresh-empty-db>" \
RAYSPEC_JWT_SIGNING_KEY="<an RS256 PEM>" \
RAYSPEC_API_KEY_PEPPER="<any string>" \
OPENAI_API_KEY="sk-…" \
  pnpm --filter @rayspec/server serve
```

`RAYSPEC_HANDLER_ROOT` defaults to the spec's directory, so it is optional here — shown for clarity.

## Drive it end-to-end (curl)

Once it is serving on `$BASE` (e.g. `http://localhost:8788`):

```bash
# 1. Register a user, create an org, and switch into it to get a scoped token.
ACCESS=$(curl -s -X POST "$BASE/v1/auth/register" -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-enough-password"}' | jq -r .accessToken)
ORG=$(curl -s -X POST "$BASE/v1/orgs" -H "authorization: Bearer $ACCESS" \
  -H 'content-type: application/json' -d '{"name":"Acme Sales"}' | jq -r .id)
TOKEN=$(curl -s -X POST "$BASE/v1/orgs/$ORG/switch" -H "authorization: Bearer $ACCESS" | jq -r .accessToken)

# 2. POST a lead → 201 with the created id + the enqueued run id. The agent runs off-request.
LEAD=$(curl -s -X POST "$BASE/leads" -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"company":"Globex Manufacturing","contact_email":"ap@globex.example",
       "message":"Rolling out to every regional plant next quarter.","headcount":4200}')
ID=$(echo "$LEAD" | jq -r .id)

# 3. Poll the lead until the durable qualify run flips it to `qualified` with the verdict.
curl -s "$BASE/leads/$ID" -H "authorization: Bearer $TOKEN" | jq '{status,tier,fit_score,owning_queue,rationale}'

# 4. List this tenant's leads.
curl -s "$BASE/leads" -H "authorization: Bearer $TOKEN" | jq '.[].company'
```

## The tests (the proof)

Two suites live in `@rayspec/server` and boot this exact document through `assembleServer`:

- `lead-qualifier-e2e.db.test.ts` — the **deterministic**, merge-gated acceptance. CI has no LLM
  creds, so it injects a fake `openai` backend that **derives** the verdict from the run input and
  dispatches `save_qualification` through the real tool chokepoint (fail-the-fix: a distinct lead
  yields a distinct persisted verdict; a wiring regression goes red). Run it locally:

  ```bash
  RAYSPEC_REQUIRE_DB_TESTS=true DATABASE_URL="postgres://…:5433/<db>" \
    pnpm --filter @rayspec/server exec vitest run src/lead-qualifier-e2e.db.test.ts
  ```

- `lead-qualifier-live.smoke.db.test.ts` — the **live** proof: no injected backend, so the real
  OpenAI adapter qualifies a real lead. Self-skips without `OPENAI_API_KEY`; runs locally with it.

## Posture

LOCAL / single-node / trusted-author. Handlers run in-process (they are trusted-author, not
sandboxed), so this document is **not** internet-facing without the separate external-exposure
hardening layer.
