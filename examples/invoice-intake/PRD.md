# PRD — Invoice Intake & GL Coder

> This is the plain-language product brief the document `invoice-intake.product.yaml` was authored
> from. It is a product running the whole file-ingest chain: upload → parse → extract → validate →
> store → views.

## The product

An accounts-payable back office receives supplier invoices as documents (plain text exports and
PDFs). Instead of a clerk reading each invoice and keying the vendor, amount, and general-ledger
account by hand, the system should accept an uploaded invoice document, read it, extract the invoice
fields, assign the vendor's GL account from the company's vendor→GL catalog, and expose read
endpoints so the AP UI can show a coded invoice and list recent ones.

## Users & jobs

- **Uploader (a service / scanner integration):** PUTs the invoice document bytes under a stable
  invoice id, then POSTs a submit to seal it. Re-uploading/re-submitting the same document must NOT
  double-process it; changing the bytes of an already-submitted invoice must be rejected.
- **AP reviewer (read):** GETs a single coded invoice, and GETs a paged list of recent invoices.

## What happens to an upload (the pipeline)

1. **Ingest** the document (an authenticated bounded upload; the content is DATA, never instructions).
2. **Parse** it to text (plain text/markdown/CSV/JSON pass-through; PDF text-layer extraction — a
   scanned PDF without a text layer fails with a named error; no OCR in v1).
3. **Look up** the vendor→GL catalog (vendor → GL account code + name), seeded by the deployment,
   including an `unmatched` suspense fallback row.
4. **Extract & code** with a single-turn extraction agent: vendor, total in integer cents, invoice
   date, line items — and the GL code from the catalog row matching the vendor (the `unmatched` row
   when none matches; never an invented code).
5. **Validate** the coded output has the required fields.
6. **Persist** one coded row per invoice (idempotent on the invoice id), with the catalog snapshot.
7. **Serve** the coded invoice (detail) and a paged list.

## Rules & posture

- The GL code must come from the catalog; unknown vendors go to the `unmatched` suspense account.
- Amounts are integer cents — never floats or formatted strings.
- Re-uploading identical bytes + re-submitting converges on ONE processing run and ONE stored row;
  divergent bytes after submit are rejected (409), never silently replaced.
- Oversize uploads and disallowed file types are rejected before any processing.
- Reads are GET endpoints; there is no product write/admin endpoint — writes happen only through the
  upload/submit ingress + the workflow.
- LOCAL / single-node / trusted posture (not internet-facing without the separate hardening layer).

## Explicitly out of scope (v1)

- OCR / scanned PDFs without a text layer (typed failure, visible in the run journal).
- Downloading the original document back (views serve extracted fields + metadata only).
- Persisting the client-supplied filename: the upload's `x-file-name` header is optional
  attacker-influenced data — the coded row and the views identify a file by `file_id` + `sha256`.
- Catalogs beyond 50 vendors: the catalog read is bounded at 50 rows (vendor-ascending,
  author-tunable) — vendors past the window code to the `unmatched` suspense account.
- Currency conversion, approval workflows, duplicate-vendor fuzzy matching.
- A product-declared mutation/admin API — this product has no write/admin surface.

## How this maps to the document

| PRD need | Document construct |
| --- | --- |
| Authenticated document upload + seal | capability `file_input` (PUT `/files/{file_id}` + POST `/files/{file_id}/submit`) |
| Idempotent re-submit / divergence reject | the `file_submitted` event's file-scoped idempotency key + the sealed-bytes 409 |
| Document → text | a `file_input.parse_text` capability step (PDF text-layer, no OCR) |
| Vendor→GL catalog lookup | a declared `vendor_gl_catalog` store + a bounded `store_read` step |
| Extract + code the invoice | a single-turn extraction `agent` (`invoice_extractor`) fed the parsed text AND the catalog |
| Validate the coded output | a `validation.check` step |
| Persist one row per invoice | a declared `coded_invoices` store + a `store_write` UPSERT on `invoice_ref` |
| Invoice detail + list reads | two GET `views` over `coded_invoices` |
