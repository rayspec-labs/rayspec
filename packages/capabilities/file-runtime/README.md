# @rayspec/file-runtime

The generic Tier-B **file-ingest** capability (`file_input`): one
bounded raw-byte `PUT /files/{file_id}` upload (a `{kind:'stream', mode:'ingest'}` route) plus one
`POST /files/{file_id}/submit` that seals the bytes and emits the `file_input.file_submitted`
workflow trigger event. Product-neutral by law — the file content is arbitrary product DATA (never
instructions — the trust boundary); this package carries zero product vocabulary.

A record×audio HYBRID by design: `@rayspec/record-runtime` donates the manifest/event/submit
template (JSON side); `@rayspec/audio-runtime` donates the stream-route byte transport — but the
upload core is **designed, not mirrored**: never the audio donor's unbounded `arrayBuffer()`.

## The byte bound

- **Content-Length pre-check** — absent / non-numeric / chunked / over-cap declared lengths are a
  413 BEFORE any body byte is read (the api-auth OIDC-cap pattern).
- **Drain-time enforcement** — the body is read chunk-wise with a running count; crossing the cap
  cancels the read (a lying Content-Length buys at most cap + one chunk of memory). sha256 is
  computed in the same pass.
- Default cap 25 MiB (`DEFAULT_MAX_FILE_BYTES`); v1 content-type allowlist
  text/plain · text/markdown · text/csv · application/json · application/pdf — both
  deployment-overridable (`FileCapabilityConfig`), construction-validated fail-closed.

## The state machine (upload → submit)

PUT bytes → pointer row (`uploaded`) → submit seals (`submitted`) + emits the event. Idempotency
is sha256 over the raw bytes: identical re-upload/re-submit → deduped (ONE durable run — idempotency via
the `file_id:<id>` enqueue key); divergent re-upload pre-seal → last-write-wins; divergent
anything post-seal → loud 409 with the stored-event heal (best-effort; the cross-tenant
`FileEventRejectedError` family stays fail-closed → 403). Blob keys are content-addressed
(`files/<file_id>/<sha256>`, server-derived only — the client filename is a DATA column, NEVER a
key/path component).

## Composition

`mountFileCapability({ fileSubmittedSink })` returns the `{stores, api, handlers}` fragments a
deployment merges (ADDITIVE only — no platform file changes). The workflow seam is
`@rayspec/file-workflow-bridge`, wired into compose/product-boot behind the neutrality gate; the
durable `file_input.parse_text` node extracts text.
