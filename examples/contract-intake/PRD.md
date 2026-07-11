# Contract Metadata Intake — PRD (a FILE product)

A back-office legal-ops tool. A user uploads a contract document (plain text or a **text-layer PDF** —
no scanned/OCR). The system:

1. **Parses** the document to text.
2. **Extracts** structured metadata: `counterparty_name`, `contract_type` (one of `nda`/`msa`/`sow`/
   `dpa`/`other`), `effective_date`, `term_months` (int), `auto_renews` (bool), `notice_period_days`
   (int), `governing_law`, `total_value_cents` (int, nullable).
3. **Classifies** the contract type against a small **seeded retention-policy catalog**
   (`contract_type` → default `retention_years` + `review_owner`).
4. **Validates** that the load-bearing fields are present (`counterparty_name`, `contract_type`,
   `effective_date`) — plus the assigned `retention_years` + `review_owner`.
5. **Persists** one coded record per contract.
6. Exposes **GET views**: a per-contract detail view + a paged list view.

Single tenant / single scope. **No** download of the original file. **No** admin/edit surface.
Idempotent re-upload.

## Honest v1 scope (the file-product limits — same as the invoice acceptance)

- The `store_read` catalog filter **cannot** be sourced from an extracted value (equality over
  `{event|const}` only, and a file event carries no business fields) → the `contract_type` → retention
  match is the **agent's job** over a **bounded unfiltered** catalog read; the seeded `other` row is the
  suspense fallback.
- The optional client filename is **not persisted** (`{event:}` fail-closes on a null value);
  `file_id` + `sha256` identify the file.
- Nested/array output lands as **one `jsonb` column** (`coded`); scalar columns come from the event's
  server-derived byte metadata.
- **NO OCR** (a scanned/image PDF fails `scanned_pdf_no_text_layer`); **no** original-file download.
- The **deterministic** extraction path is the CI-proven merge gate; the **live** path (real gpt through
  the generic branch, via `extraction/`) is real but **smoke-proven only** (self-skips without
  `OPENAI_API_KEY`).

## Deploy target

Local composed stack, `RAYSPEC_BLOB_ROOT` set to a throwaway dir, trusted posture / single-node / NOT
internet-facing.
