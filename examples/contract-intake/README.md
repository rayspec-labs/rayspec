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

This runs in the foreground — give the steps below a second shell.

The dev-boot seeds the ORG `00000000-0000-4000-8000-000000000042` and no user, so nothing is callable
yet — `PUT /files/{file_id}`, `POST /files/{file_id}/submit` and `GET /contracts` all answer `401` —
and you cannot register your way into it: a `POST /v1/auth/register` carrying an `orgName` creates a
DIFFERENT org (its `activeOrgId` is that new id), and
`POST /v1/orgs/00000000-0000-4000-8000-000000000042/switch` answers `404` because the caller is no
member of it. That caller is served their OWN, empty tenant: `GET /contracts` answers `200`
(`{"contracts":[]}`) and even `PUT /files/{file_id}` answers `200`, but the submit is refused
`403 file_event_rejected` — the file-submit sink is constructed with the deployment's bound tenant and
asserts every event's tenant before forwarding, so a foreign submit is rejected fail-closed
(`cross_tenant`) with no workflow enqueued. The five `contract_type_catalog` rows are seeded under the
seeded tenant alone, so none of the demo's catalog is reachable that way either. Mint an owner invite
for the seeded org instead:

```bash
DATABASE_URL="postgres://rayspec:rayspec@localhost:5433/play_contract" \
  rayspec tenant ensure --org-id 00000000-0000-4000-8000-000000000042 \
    --name 'Contract Co' --owner-email you@local --owner-invite-out ./owner-invite.txt
```

Run that from the repo root. The CLI looks for a `.env` in exactly two places — `$PWD` and the
directory its own install sits in — and searches nowhere above either, so a globally installed
`rayspec` run from any other directory finds no `RAYSPEC_API_KEY_PEPPER` and refuses with
`SECRETS_MISSING` before it touches the database.

`DATABASE_URL` is doing real work there. `tenant ensure` applies the committed migration chain to —
and creates the org in — whatever database it names, and the dev-boot serves the throwaway
`play_contract` while deliberately ignoring `.env`'s `DATABASE_URL`; the CLI does read that file for
anything the shell leaves unset, so without the override the org lands in your main dev database and
the invite is nowhere the demo can see it. `RAYSPEC_API_KEY_PEPPER` comes from that same repo-root
`.env` — the file the dev-boot took it from — and it has to be the value the demo booted with, because
the invite token is hashed under it; minted under a different pepper the token is refused at accept.
The command creates no user and never prints the token (it writes it to a mode-600 file); the
[CLI reference](../../docs/cli-reference.md#tenant-ensure) has the output shape.

Redeeming that token is what creates the account:

```bash
curl -s -X POST http://127.0.0.1:8793/v1/invites/accept -H 'content-type: application/json' \
  -d '{"token":"<the contents of ./owner-invite.txt>","password":"<a password you choose>"}'
```

The `201` hands back an access token already scoped to the seeded org — no login and no switch follow.
Then delete `./owner-invite.txt`: until it is redeemed it is a tenant-takeover credential. Re-running
the command mints nothing once the org is claimed — it reports `already_owned` — and reports `pending`
(writing no file at all) while an invite is still outstanding, so if you lose the token before
redeeming it, add `--reissue-owner-invite`, which revokes the outstanding invite (the old token is
then refused at accept) and mints a replacement; give that run a path that does not exist yet, because
a minting run refuses an existing `--owner-invite-out` rather than overwriting it.

With that token, `PUT /files/{file_id}` a contract (text or a text-layer PDF —
`fixtures/sample-contract.txt` is one), `POST /files/{file_id}/submit`, then read
`GET /contracts/{contract_ref}` + `GET /contracts`. The `contract_ref` IS the `file_id` you uploaded
under: the `store_write` takes it from the file event.

Stop it with `Ctrl-C`: the wrapper closes the HTTP server, drains the durable worker and ends the DB
pool, then exits.
