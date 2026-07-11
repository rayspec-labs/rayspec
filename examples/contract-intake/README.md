# Contract Metadata Intake

A file-declaring product — a *different* file product from the `invoice-intake` acceptance product.
It is a reference example that exercises the file-ingest capability end-to-end, declared from its
`PRD.md` brief.

**Pipeline:** upload a contract (text or text-layer PDF) → `file_input.parse_text` → `store_read` the
seeded contract-type retention catalog → extract metadata + assign the retention policy (agent-side
`contract_type`→retention match; the `other` row is the fallback) → `validation.check` → `store_write`
UPSERT → GET views (detail + paged list).

## Honest scope (v1) — the file-product limits

- **Deterministic** extraction is the merge-gated proof; the **live** path (real gpt through the
  generic branch, via `extraction/contract_extractor.extractor.json`) is real but proven by a
  **self-skipping smoke** (needs `OPENAI_API_KEY`; self-skips in CI). Do not treat live as merge-gated.
- The `store_read` catalog is a **bounded unfiltered** read (`limit: 20`) — `store_read` filters are
  equality over `{event|const}` only, and a file event carries no business fields, so the
  `contract_type`→retention match is the **agent's job** against the provided catalog; the seeded
  `other` suspense row is the fallback. A catalog with more than 20 contract types would leave the
  overflow types invisible to the agent (this product has 5 — a non-issue here, stated for honesty).
- The **client filename is NOT persisted** — `x-file-name` is optional + attacker-influenced, and the
  `{event:}` value resolver fail-closes on a null value. `file_id` + `sha256` identify the file. A
  filename-less upload completes end-to-end.
- The coded metadata lands as **one `jsonb` column** (`coded`) — the grammar has no artifact→scalar
  projection; the scalar store columns come from the event's server-derived byte metadata.
- **NO OCR** (a scanned/image PDF fails `scanned_pdf_no_text_layer`); **no** original-file download
  (views serve the extracted fields + upload metadata, never the raw bytes).
- **LOCAL / single-node / trusted posture / NOT internet-facing.**

## Run it

Merge-gated deterministic e2e (CI-green without LLM creds — the whole chain over the real composed
stack + DBOS + Postgres):

```bash
pnpm db:up   # Postgres :5433
RAYSPEC_REQUIRE_DB_TESTS=true DATABASE_URL="postgres://rayspec:rayspec@localhost:5433/postgres" \
  pnpm --filter @rayspec/server test contract-intake-e2e
```

Live smoke (real gpt through the generic branch — needs `OPENAI_API_KEY`; self-skips in CI):

```bash
DATABASE_URL="postgres://rayspec:rayspec@localhost:5433/postgres" OPENAI_API_KEY="sk-…" \
  pnpm --filter @rayspec/server test contract-intake-live.smoke
```

Interactive dev-boot (a throwaway play DB; a FILE product also needs `RAYSPEC_BLOB_ROOT`):

```bash
node examples/contract-intake/dev-boot.mjs   # auto-creates play_contract, serves on :8793
```
