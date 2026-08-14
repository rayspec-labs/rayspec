# Support Intake Chat — a conversational product

A **conversation-declaring** product that composes, boots, and serves end-to-end on the composed
stack — a product running the whole conversational chain in one doc: multi-turn chat → a grounded
(catalog `store_context`) reply that can stream (SSE) → an async workflow that reads the catalog,
classifies the turn into a routed ticket (`agent`), validates it (`validation.check`), UPSERTs the
conversation ticket (`store_write`), and serves it via GET views.

- `support-intake-chat.product.yaml` — the authored document (validate with `rayspec doctor` / `plan`).
- `conversation/support_responder.responder.json` — the per-responder config
  (`<specDir>/conversation/<agent_id>.responder.json`): instructions, model, backend, the bounded history
  window, and the bounded `store_context` read of `support_catalog` the reply is grounded in.
- `extraction/support_extractor.*` — the per-agent LIVE extraction config
  (`<specDir>/extraction/<agent_id>.extractor.json` + its prompt + output schema, incl. the `input_context`
  the generic live branch consumes: `payload_fields: ["message"]` — the turn text rides the trigger
  payload — plus the catalog `artifact_inputs`).
- `dev-boot.mjs` — a LOCAL dev-boot wrapper (live mode; auto-creates a throwaway DB + seeds the catalog).
- `PRD.md` — the plain-language brief the document was authored from.

## Validate (no DB, no deploy)

```bash
rayspec doctor examples/support-intake-chat/support-intake-chat.product.yaml
rayspec plan   examples/support-intake-chat/support-intake-chat.product.yaml
```

## Boot it on the composed stack (LOCAL, trusted-posture)

This document boots through the REAL server entrypoint (`@rayspec/server`) — the same
`RAYSPEC_SPEC_PATH` composed-boot the platform uses. Because this product **declares
`conversation_input` and one workflow agent**, the doc-driven boot demands `RAYSPEC_RESPONDER_MODE`
(the reply executor) and `RAYSPEC_EXTRACTION_MODE` (the extraction executor) — and NO blob root, NO
media-signing key, NO STT env (a chat turn moves no bytes and runs no transcription).

### Drive it end-to-end — deterministic (the CI-proven, actually-working path)

The platform is **product-free**: it ships NO reply/extraction executor, so deterministic mode runs
behind thin wrappers that inject them via
`assembleServer(config, { productDeterministicResponderBackend, productDeterministicAgents })`. The
**merge-gated acceptance e2e is exactly those wrappers** and proves the whole loop end-to-end — boot →
create → turn → a grounded reply (JSON + SSE) → the async `read_catalog → agent → validation → store_write`
→ the `GET /tickets` views — plus the discipline arms (multi-turn history, dedup, concurrent-turn
409, bounds 413, cross-tenant 403, tenant erasure):

```bash
pnpm db:up   # Postgres :5433
RAYSPEC_REQUIRE_DB_TESTS=true DATABASE_URL="postgres://…:5433/<db>" \
  pnpm --filter @rayspec/server test support-intake-chat-e2e
```

Both deterministic executors **DERIVE** from the real inputs (see the test): the responder's reply
attests it saw the history window + the catalog context; the extractor derives the ticket from the real
turn text + the real catalog rows — a data-flow proof, not a canned object (turn-1 codes
`authentication`, turn-2 codes `billing`; a canned category could not).

### Live (real gpt-5) — the responder + the generic extraction branch, proven by the smoke

The end-to-end LIVE proof is the self-skipping smoke (runs locally with an OpenAI key; self-skips in CI,
which has no LLM creds):

```bash
DATABASE_URL="postgres://…:5433/<db>" OPENAI_API_KEY="sk-…" \
  pnpm --filter @rayspec/server test support-intake-chat-live.smoke
```

It boots THIS document with both executor modes `live`, runs a real two-turn conversation, and asserts
the replies are non-empty and the extracted tickets are grounded in the SEEDED catalog (turn-1 →
`authentication`/`identity-team`, turn-2 UPSERTs → `billing`/`billing-ops` — never invented).

To serve it interactively with live executors, use the dev-boot wrapper (auto-creates a throwaway DB and
seeds the catalog):

```bash
node examples/support-intake-chat/dev-boot.mjs        # serves on :8794, live mode
```

Stop it with `Ctrl-C`: the wrapper closes the HTTP server, drains the durable worker and ends the DB
pool, then exits.

The dev-boot seeds the ORG `00000000-0000-4000-8000-000000000043` and no user, so you cannot register
your way into it: `POST /v1/auth/register` creates a DIFFERENT org (its `activeOrgId` is that new id),
and `POST /v1/orgs/00000000-0000-4000-8000-000000000043/switch` answers `404` because the caller is no
member of it. That caller is served their OWN, empty tenant: `PUT /conversations/{id}` and
`GET /tickets` answer `200` (`{"tickets":[]}`), but `POST /conversations/{id}/turns` is refused
`403 conversation_event_rejected` — the turn dispatcher is bound to the deployment's tenant, so a
foreign turn is rejected fail-closed (`cross_tenant`), with no workflow started and no reply. The
four `support_catalog` rows are seeded under the seeded tenant alone, so none of the demo's data is
reachable that way either. Mint an owner invite for the seeded org instead:

```bash
DATABASE_URL="postgres://rayspec:rayspec@localhost:5433/play_support_chat" \
  rayspec tenant ensure --org-id 00000000-0000-4000-8000-000000000043 \
    --name 'Support Chat Co' --owner-email you@local --owner-invite-out ./owner-invite.txt
```

`DATABASE_URL` is doing real work there. `tenant ensure` provisions — and applies the migration chain
to — whatever database it names, and the dev-boot serves the throwaway `play_support_chat` while
deliberately ignoring `.env`'s `DATABASE_URL`; the CLI does read that file for anything the shell
leaves unset, so without the override the org lands in your main dev database and the invite is
nowhere the demo can see it. `RAYSPEC_API_KEY_PEPPER` comes from that same repo-root `.env` — the file
the dev-boot took it from — and it has to be the value the demo booted with, because the invite token
is hashed under it; minted under a different pepper the token is refused at accept. The command
creates no user and never prints the token (it writes it to a mode-600 file); the
[CLI reference](../../docs/cli-reference.md#tenant-ensure) has the output shape.

Redeeming that token is what creates the account:

```bash
curl -s -X POST http://127.0.0.1:8794/v1/invites/accept -H 'content-type: application/json' \
  -d '{"token":"<the contents of ./owner-invite.txt>","password":"<8+ characters>"}'
```

The `201` hands back an access token already scoped to the seeded org — no login and no switch follow.
Then delete `./owner-invite.txt`: until it is redeemed it is a tenant-takeover credential. Re-running
the command mints nothing once the org is claimed — it reports `already_owned` — and reports
`pending` (writing no file at all) while an invite is still outstanding, so if you lose the token
before redeeming it, add `--reissue-owner-invite`, which revokes the outstanding invite and mints a
replacement; give that run a path that does not exist yet, because a minting run refuses an existing
`--owner-invite-out` rather than overwriting it.

With that token, `PUT /conversations/{id}`, `POST /conversations/{id}/turns`
(optionally `Accept: text/event-stream`), and read `GET /tickets/{conversation_id}` + `GET /tickets`.

> **LOCAL / trusted posture / NOT internet-facing** — the separate hardening layer (per-tenant
> sandbox, RLS, KMS-DEK, DPoP) is the gate before any external exposure. End-user identity is
> org-member bearer today; a browser-widget / end-user auth story is a named follow-on. Never put
> this behind a public address.

## Honest scope

- **Deterministic path** is proven end-to-end by the merge-gated e2e
  (`packages/app/server/src/support-intake-chat-e2e.db.test.ts`) — CI-green with NO LLM creds.
- **Live path** is REAL but its proof is the self-skipping smoke
  (`packages/app/server/src/support-intake-chat-live.smoke.db.test.ts`) — it needs `OPENAI_API_KEY` and
  runs locally, not in CI. Do not expect the live path to work without the key.
- **Catalog grounding is PROMPT-enforced + SHAPE-validated, not structural.** The reply is grounded by
  INSTRUCTING the responder to use the bounded catalog context (`store_context` — an equality read of
  ONE declared store, unfiltered here for a seeded catalog; NOT embeddings/search — out of scope by
  design). The classifier is likewise INSTRUCTED to pick `category` / `suggested_routing` from the
  catalog (the `other` row when nothing matches). Catalog MEMBERSHIP of those values is NOT
  structurally guaranteed in the LIVE path — a determined prompt injection in the turn text could
  steer an off-catalog value. The blast radius is capped: the reply and extractor agents are tool-less
  (`tools: []` — verified in `@rayspec/product-yaml`), the extractor uses native structured output,
  and `validation.check` gates only the ticket SHAPE (required fields present) — it does NOT check
  catalog membership (the same posture the invoice-intake example uses).
- **The ticket is per CONVERSATION, UPSERTed per turn** (the conversation IS the ticket), and reflects
  the LATEST turn's classification. The async extractor sees ONE turn's text + the catalog; accumulating
  multi-turn context INTO the extraction is a named follow-on (the bounded history window feeds the
  synchronous REPLY, not the extraction).
- **Per-backend streaming honesty:** the SSE transport is uniform, but token-incremental deltas are a
  backend-specific property; OpenAI emits the reply only in the terminal frame (non-streaming SDK
  overload); Anthropic/Codex emit one whole-message delta. The terminal `conversation_reply` frame
  always carries the complete reply. The e2e's delta arm is a SYNTHETIC transport exercise — the
  deterministic responder injects two chunks to prove SSE relay (intake → deltas → terminal), NOT live
  per-backend token streaming; against real gpt-5 the reply arrives only in the terminal frame.
- **Reconnect = one-shot replay** (the run-events read surface) + client poll; there is no live SSE
  tail.
- **The classified fields land as ONE `ticket` jsonb column**: the grammar has no transform/project
  node to decompose an artifact into scalar columns; the scalar columns come from the event's
  server-derived turn facts.
- **The `ticket_ref` conflict key derives a deployment-GLOBAL unique index**: a foreign-tenant key
  collision fails LOUD (a typed `store_write_conflict` terminal failure, never a silent success) and
  is not reachable in the single-deployment-tenant beta.
- **The catalog store_read is bounded at `limit: 50`** (author-tunable): a catalog with more than 50
  categories exposes only the first 50 rows to the extractor/responder. A v1 scope limit.
- Reads are GET views; there is no product write/admin surface (`assertProductScope` enforces it).
