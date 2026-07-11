# Expense Claim Auto-Coder — a non-audio product

A **non-audio** document composing, booting, and serving end-to-end on the composed stack. It is
the product-declared counterpart of the backend showcase in `../expense-claim-coder/`.

- `expense-claim.product.yaml` — the authored document (validate with `rayspec doctor` / `plan`).
- `extraction/expense_coder.*` — the per-agent LIVE extraction config (`<specDir>/extraction/<agent_id>.extractor.json` + its prompt + output schema).
- `PRD.md` — the plain-language brief the skill authored the document from.

## Validate (no DB, no deploy)

```bash
rayspec doctor examples/expense-claim/expense-claim.product.yaml
rayspec plan   examples/expense-claim/expense-claim.product.yaml
rayspec openapi examples/expense-claim/expense-claim.product.yaml   # the view OpenAPI
```

## Boot it on the composed stack (LOCAL, trusted posture)

This document boots through the REAL server entrypoint (`@rayspec/server`) — the SAME
`RAYSPEC_SPEC_PATH` composed-boot a hosted product uses. Because this product is **non-audio and
has one agent**, the doc-driven boot demands ONLY the extraction env — NO blob/media/STT env.

### Drive it end-to-end — deterministic (the CI-proven, actually-working path)

The extraction executor is `RAYSPEC_EXTRACTION_MODE=deterministic`. The platform is **product-free**:
it ships NO executor, so deterministic mode runs behind a thin WRAPPER that injects one via
`assembleServer(config, { productDeterministicAgents })`. The **merge-gated acceptance e2e is exactly
that wrapper** and proves the whole loop end-to-end — boot →
`POST /records/{id}/submit` → `store_read → agent → validation → store_write` → the `GET /claims` views:

```bash
pnpm db:up   # Postgres :5433
RAYSPEC_REQUIRE_DB_TESTS=true DATABASE_URL="postgres://…:5433/<db>" \
  pnpm --filter @rayspec/server test expense-claim-e2e
```

To boot it interactively, write a thin wrapper: import `assembleServer`, register a
deterministic executor for `agent.expense_coder`, and serve with the env above (minus the LLM key).
Then register/switch to the tenant, seed a few `expense_policies` rows, `POST /records/{record_id}/submit`
a claim, and read `GET /claims/{claim_ref}` + `GET /claims`.

### Live extraction (real LLM) — the GENERIC (non-transcript) branch

```bash
RAYSPEC_SPEC_PATH="$PWD/examples/expense-claim/expense-claim.product.yaml" \
RAYSPEC_PRODUCT_TENANT_ID="<an existing org uuid>" \
RAYSPEC_EXTRACTION_MODE=live  OPENAI_API_KEY="sk-…" \
DATABASE_URL="postgres://…:5433/<db>" \
RAYSPEC_JWT_SIGNING_KEY="…" RAYSPEC_API_KEY_PEPPER="…" \
pnpm --filter @rayspec/server serve
```

The agent declares no `closed_source_artifacts`, so its live extraction runs the **generic branch**
of the shared node (`packages/compose/product-yaml/src/live-agent-node.ts`): the compiled
`artifact_inputs` (the policy catalog — required-checked, fail-closed when absent) plus the
`input_context.payload_fields` declared in `extraction/expense_coder.extractor.json` (the submitted
claim's `merchant`/`amount_cents`/`description`/`incurred_on`) are serialized as UNTRUSTED,
JSON-escaped data sections into the model input — an undeclared payload field never reaches the
model. Transcript-shaped products are untouched by this branch.

> **LOCAL / trusted posture / NOT internet-facing** — the separate hardening layer (per-tenant
> sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure. Never put this behind a
> public address.

## Honest scope

- **Deterministic extraction** (`RAYSPEC_EXTRACTION_MODE=deterministic` + an injected executor) is
  proven end-to-end by the merge-gated e2e (`packages/app/server/src/expense-claim-e2e.db.test.ts`) —
  the working path above.
- **Live extraction** (`RAYSPEC_EXTRACTION_MODE=live`, real LLM) uses `extraction/expense_coder.*`
  through the generic branch. The assembled model input + the boot-side `input_context` resolution
  are **unit-proven** (`live-agent-node.test.ts` generic pins; `product-boot.unit.test.ts`); an
  end-to-end LIVE run of a non-audio product on the composed stack is a merge-gated acceptance
  product's proof, not claimed here.
- Reads are GET views; there is no product write/admin surface (`assertProductScope` enforces it).
