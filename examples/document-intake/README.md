# Document intake — a durable workflow over uploaded files

A reference application in the product profile: a user uploads a document — plain text or a PDF
with a text layer — and a durable workflow parses it, extracts a structured record, validates it
and persists one row per document, which two read views serve.

```
PUT  /files/{file_id}          upload the bytes (Content-Type: text/plain or application/pdf)
POST /files/{file_id}/submit   start the workflow: parse → extract → validate → persist
GET  /records/{document_ref}   one record (document_ref is the file id)
GET  /records?limit=&offset=   the records, newest first
```

It runs on the **deterministic extraction provider**, so it needs no model credential: the
extractor's config ([`extraction/record_extractor.extractor.json`](./extraction/record_extractor.extractor.json))
selects `"backend": "deterministic"`, and the deployment runs with
`RAYSPEC_EXTRACTION_MODE=deterministic`. That provider reads labelled lines (`Title: …`,
`Quantity: …`) into the fields of the output schema and **is not for production extraction**: it
does not read a document the way a model does, and it is refused under the managed hosting posture.
See [the deterministic extraction provider](../../docs/spec-reference.md#the-deterministic-extraction-provider).
This application makes no claim about the correctness of any extraction beyond that rule.

- `document-intake.product.yaml` — the product document.
- `extraction/` — the deterministic config and the output JSON Schema.
- `live-extraction/` — the config and prompt for a real model (`openai`, `gpt-5`), sharing the
  same schema.
- `seed/` — 50 documents (40 plain-text, 10 text-layer PDF), their hashes and the records they give.
- `fixtures/` — a document missing a required field, and one carrying markup and instruction-like
  text.

## Limits

The file capability's limits apply: at most 25 MiB per file (a larger declared `Content-Length`
is refused with `413` before a byte of the body is read) and a content-type allowlist of
`text/plain`, `text/markdown`, `text/csv`, `application/json` and `application/pdf` (anything else
is `415`). The parser sniffs the bytes and does not trust the declared type. There is no OCR: only
a PDF's text layer is read. A file id is 1–128 characters of `A-Z a-z 0-9 _ . -`.
The client file name (the optional `x-file-name` header) is not persisted.

## Build, pack, deploy

There is nothing to build. Pack the document and check the bundle:

```bash
rayspec pack --spec examples/document-intake/document-intake.product.yaml \
  --output document-intake-1.0.0.ray
rayspec bundle inspect document-intake-1.0.0.ray
rayspec bundle verify  document-intake-1.0.0.ray
```

The bundle carries the document, the deterministic config and the schema, and declares no binding
and no egress host.

Nothing in the bundle or in the `inspect` output says that the application runs on the
deterministic provider: its `requires` lists `declarative-stores`, `durable-workflow` and
`file_input`, and not the provider's capability, `extraction-deterministic`. Read the
extraction config in `extraction/` to see it. A deployment under
`RAYSPEC_HOSTING_POSTURE=managed` refuses the provider when it boots.

A product deployment binds to one organization, which exists before the deploy. With the
[environment a bundle deploy reads](../../docs/self-hosted-deployment.md#what-you-need):

```bash
rayspec tenant ensure --org-id <uuid> --name Intake \
  --owner-email owner@example.test --owner-invite-out owner.token

export RAYSPEC_PRODUCT_TENANT_ID=<uuid>
export RAYSPEC_BLOB_ROOT=/var/lib/rayspec/blobs      # where the uploaded bytes are kept
export RAYSPEC_EXTRACTION_MODE=deterministic
rayspec deploy document-intake-1.0.0.ray --dry-run
rayspec deploy document-intake-1.0.0.ray --plan-digest <planDigest from the dry-run>
```

The boot prints a banner saying a non-real provider is selected. The owner redeems the invite —
`POST /v1/invites/accept` with `{"token": "<contents of owner.token>", "password": "…"}` — and the
answer carries an access token scoped to the organization.

## Upload, submit, read

```bash
curl -s -X PUT $BASE/files/doc-001 -H "authorization: Bearer $TOKEN" \
  -H 'content-type: text/plain' --data-binary @examples/document-intake/seed/documents/doc-001.txt
curl -s -X POST $BASE/files/doc-001/submit -H "authorization: Bearer $TOKEN"
curl -s $BASE/records/doc-001 -H "authorization: Bearer $TOKEN"
```

Until the workflow has persisted the record, the detail view answers `200` with `record: null`.
Uploading the same bytes again answers `deduped: true`, different bytes under a submitted file id
answer `409`, and submitting again answers `deduped: true` without a second workflow run. A
document whose record misses a required field (`reference`, `title`, `quantity`, `lines`) fails at
the extractor's declared output shape and persists nothing. Bytes that decode as UTF-8 but hold a
NUL character — an executable or an archive under a text or PDF type, for one — fail at the parse
(`file_text_contains_nul`) and persist nothing. Markup and instruction-like text in a
document are stored as JSON string data and never interpreted.

## The seed

`seed/manifest.json` names each document's file id, file, content type, size, SHA-256 and the
record the application persists for it (`expected`), and the inventory the 50 add up to: counts of
text and PDF documents, the total quantity and line count, and how many have no category or no
received date. `seed/build-seed.mjs` regenerates the documents and the manifest byte for byte; the
PDFs are built by it, one text-layer page per line.

## A real model

For a run against a real model, select the live config through the single-file override on a spec
deploy, with the provider key in the environment (and `RAYSPEC_PRODUCT_TENANT_ID` and
`RAYSPEC_BLOB_ROOT` as above):

```bash
RAYSPEC_EXTRACTION_MODE=live \
RAYSPEC_EXTRACTION_CONFIG=$PWD/examples/document-intake/live-extraction/record_extractor.extractor.json \
OPENAI_API_KEY=… \
rayspec deploy examples/document-intake/document-intake.product.yaml
```

The deterministic config is refused in live mode, and the live config is refused in deterministic
mode: neither provider ever stands in for the other.

## Interruptions, cancellation and moving it

Each document is one durable workflow run. A process that stops in the middle of one — before the
record is written, or after it is written but before the run is closed — resumes it at its next
start, and the run ends with exactly one record; a step that completed is not executed again.

A running document workflow cannot be cancelled: the run cancel route
([`POST /v1/runs/{id}/cancel`](../../docs/spec-reference.md#cancelling-a-run)) ends agent runs,
and answers `404` for a workflow run's id.

The deployment moves with [`rayspec export`](../../docs/export.md) and
[`rayspec import`](../../docs/import.md): every record and every stored file — at its key, with its
bytes and both digests — arrives in the target, the workflow system database with it, and the
target processes new documents.

## Where it is tested

- `packages/workflow/nodes/agent-runtime/src/deterministic-extraction.test.ts` — the provider's
  rules.
- `packages/app/server/src/deterministic-extraction-boot.test.ts` — the provider at boot: selected
  only by the config, refused in live mode, under the managed posture and for a real backend; the
  seed's text documents give their expected records; the live config resolves.
- `packages/app/cli/src/reference-apps.test.ts` — the seed's hashes, inventory and byte-for-byte
  rebuild; pack, inspect and verify.
- `packages/app/cli/src/reference-apps-document-intake.db.test.ts` — the deployment from the
  bundle with the real built CLI and a database: all 50 seed documents processed into their
  expected records and inventory, retried uploads and submits, validation failure, hostile text,
  `415`, `413`, `401` and another organization's reads.
- `packages/compose/product-yaml/src/file-parse-node.test.ts` — the parse refusals, NUL included.
- `packages/app/server/src/document-intake-live.smoke.db.test.ts` — one seed document through a real
  model with the live config, bounded to one extraction call. It runs only with `DATABASE_URL` and
  `OPENAI_API_KEY` set (like the other intake smokes; `RAYSPEC_REQUIRE_LIVE_TESTS=true` turns their
  absence into a failure), never in the deterministic or database lanes of CI.
- `scripts/journeys/document-intake.mjs` — the whole life of the application with the CLI installed
  from the packed release: the seed, retries, an unsupported type, a disguised executable, hostile
  markup, a crash before and one after persistence each recovered by a restart, an additive and a
  refused destructive release, export, and two imports whose records and stored files are compared
  with the source's. Run with `pnpm test:journeys --app document-intake`.
