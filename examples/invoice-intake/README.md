# Invoice Intake & GL Coder — a file-declaring product

A **file-declaring** document that composes, boots, and serves end-to-end on the composed stack —
a product running the whole file-ingest chain in one doc: bounded upload → `file_input.parse_text`
(text + PDF text-layer) → catalog `store_read` → extraction agent → `validation.check` →
`store_write` → GET views.

- `invoice-intake.product.yaml` — the authored document (validate with `rayspec doctor` / `plan`).
- `extraction/invoice_extractor.*` — the per-agent LIVE extraction config
  (`<specDir>/extraction/<agent_id>.extractor.json` + its prompt + output schema, incl. the
  `input_context` the GENERIC live branch consumes).
- `fixtures/sample-invoice.txt` + `fixtures/sample-invoice.pdf` — SELF-MADE committed sample invoices
  (no internet samples). The PDF was generated with the deterministic test-support builder:
  `buildPdf({ pages: [{ text: 'INVOICE INV-2026-048' }, { text: 'Vendor: Musterbau AG' }, { text:
  'Date: 2026-06-20' }, { text: 'Item: Scaffolding rental (June) | 120000 cents' }, { text: 'Total
  (EUR cents): 120000' }] })`.
- `PRD.md` — the plain-language brief the document was authored from.

## Validate (no DB, no deploy)

```bash
rayspec doctor examples/invoice-intake/invoice-intake.product.yaml
rayspec plan   examples/invoice-intake/invoice-intake.product.yaml
rayspec openapi examples/invoice-intake/invoice-intake.product.yaml   # the view OpenAPI
```

## Boot it on the composed stack (LOCAL, trusted posture)

This document boots through the REAL server entrypoint (`@rayspec/server`) — the same
`RAYSPEC_SPEC_PATH` composed-boot the platform uses. Because this product **declares
`file_input` and one agent**, the doc-driven boot demands `RAYSPEC_BLOB_ROOT` (the file bytes) and
`RAYSPEC_EXTRACTION_MODE` — and NO media-signing key, NO STT env (there is no audio here).

### Drive it end-to-end — deterministic (the CI-proven, actually-working path)

The extraction executor is `RAYSPEC_EXTRACTION_MODE=deterministic`. The platform is **product-free**:
it ships NO executor, so deterministic mode runs behind a thin wrapper that injects one via
`assembleServer(config, { productDeterministicAgents })`. The **merge-gated acceptance e2e is exactly
that wrapper** and proves the whole loop end-to-end — boot → `PUT /files/{file_id}` → submit →
`parse_text → store_read → agent → validation → store_write` → the `GET /invoices` views — plus the
byte-discipline arms (dedup/409/413/415/401/cross-tenant 403):

```bash
pnpm db:up   # Postgres :5433
RAYSPEC_REQUIRE_DB_TESTS=true DATABASE_URL="postgres://…:5433/<db>" \
  pnpm --filter @rayspec/server test invoice-intake-e2e
```

Its deterministic executor DERIVES the coded fields from the real parsed document + the real catalog
rows (see the test) — it is a data-flow proof, not a canned object.

### Live extraction (real LLM) — the generic branch, proven by the smoke

The agent declares no `closed_source_artifacts`, so its live extraction runs the **generic branch**
of the shared live node: the compiled `artifact_inputs` (the parsed document text + the vendor→GL
catalog — required-checked, fail-closed when absent) plus the `input_context.payload_fields` declared
in `extraction/invoice_extractor.extractor.json` (`original_filename`, `content_type`) are serialized
as UNTRUSTED, JSON-escaped data sections into the model input. The end-to-end LIVE proof is the
self-skipping smoke (runs locally with an OpenAI key; self-skips in CI, which has no LLM creds):

```bash
DATABASE_URL="postgres://…:5433/<db>" OPENAI_API_KEY="sk-…" \
  pnpm --filter @rayspec/server test invoice-intake-live.smoke
```

It boots THIS document with `RAYSPEC_EXTRACTION_MODE=live`, uploads `fixtures/sample-invoice.txt`,
and asserts the REAL gpt-5 output is grounded: the printed vendor, the exact total in cents, and a
GL code from the SEEDED catalog (never invented). One short document, one model call.

To serve it interactively with live extraction:

```bash
RAYSPEC_SPEC_PATH="$PWD/examples/invoice-intake/invoice-intake.product.yaml" \
RAYSPEC_PRODUCT_TENANT_ID="<an existing org uuid>" \
RAYSPEC_EXTRACTION_MODE=live  OPENAI_API_KEY="sk-…" \
RAYSPEC_BLOB_ROOT="/var/lib/rayspec/blobs" \
DATABASE_URL="postgres://…:5433/<db>" \
RAYSPEC_JWT_SIGNING_KEY="…" RAYSPEC_API_KEY_PEPPER="…" \
pnpm --filter @rayspec/server serve
```

Then register/switch to the tenant, seed `vendor_gl_catalog` rows (including the `unmatched`
suspense fallback), `PUT /files/{file_id}` an invoice document, `POST /files/{file_id}/submit`, and
read `GET /invoices/{invoice_ref}` + `GET /invoices`.

> **LOCAL / trusted posture / NOT internet-facing** — the separate hardening layer (per-tenant
> sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure. Never put this behind a
> public address.

## Honest scope

- **Deterministic extraction** is proven end-to-end by the merge-gated e2e
  (`packages/app/server/src/invoice-intake-e2e.db.test.ts`) — CI-green with NO LLM creds.
- **Live extraction** is REAL but its proof is the self-skipping smoke
  (`packages/app/server/src/invoice-intake-live.smoke.db.test.ts`) — it needs `OPENAI_API_KEY` and runs
  locally, not in CI. Do not expect the live path to work without the key.
- **Text + PDF text-layer only** — a scanned PDF (no text layer) fails the run with the typed
  `scanned_pdf_no_text_layer` error in the durable journal; there is NO OCR in v1.
- **No original-document download** — views serve extracted fields + upload metadata only (a
  named v1 cut).
- The coded fields land as ONE `coded` jsonb column: the grammar has no transform/project node to
  decompose an artifact into scalar columns (the same posture the support-ticket-triage example
  uses); scalar columns come from the event's server-derived byte metadata.
- **The client filename is NOT persisted.** The `x-file-name` header is OPTIONAL and
  attacker-influenced DATA (stored only as escaped data in the upload pointer row, never in a
  key), and the `{event:}` store-value resolver is fail-closed on a null payload value — so v1 keeps
  it out of the `coded_invoices` row and the views entirely; `file_id` + `sha256` identify the file.
  A filename-less upload completes end-to-end.
- **The catalog read is bounded at `limit: 50`** (vendor-ascending): a catalog with more than 50
  vendors exposes only the FIRST 50 rows to the agent — vendors past the window code to the
  `unmatched` suspense account. A v1 scope limit (author-tunable in the YAML).
- **The `invoice_ref` conflict key derives a deployment-GLOBAL unique index**: a foreign-tenant key
  collision fails LOUD (a typed `store_write_conflict` terminal failure, never a silent success) and
  is not reachable in the single-deployment-tenant beta.
- The catalog `store_read` is bounded but UNFILTERED: store_read filters are equality-over-EVENT
  fields only and a file event carries no business fields — the vendor→GL matching is the agent's
  job against the provided catalog rows.
- Reads are GET views; there is no product write/admin surface (`assertProductScope` enforces it).
