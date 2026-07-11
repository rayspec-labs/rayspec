# PRD — Support Intake Chat

> This is the plain-language product brief the document `support-intake-chat.product.yaml` was
> authored from. It is a conversational product running the whole chain: a multi-turn chat with a
> grounded reply, plus an async workflow that classifies the conversation into a routed ticket.

## The product

A support team wants a first-line intake CHAT. A user opens a conversation and describes their problem
over one or more turns. The assistant replies helpfully in the moment — grounded in the team's
known-issues/routing catalog so it can point the user to the right team — and, in the background, the
system classifies the conversation into a structured, routed ticket the support desk can pick up.

## Users & jobs

- **End user (chat):** creates a conversation, submits turns (their messages), and reads the assistant's
  replies. Re-sending the same message must not double-process it; a streamed reply is available for
  clients that want it. **v1 auth:** this actor authenticates as an ORG MEMBER (every route is
  org-member bearer). A public browser-widget / untrusted external end-user identity is the product
  VISION, deferred to the separate hardening layer — v1 does NOT serve untrusted external end-users.
- **Support desk (read):** GETs a single conversation's ticket (its current classification + routing),
  and GETs a paged list of tickets.

## What happens on each turn (the pipeline)

1. **Reply (synchronous):** assemble a bounded window of the recent conversation history plus a bounded
   read of the known-issues/routing catalog (as CONTEXT DATA), and produce a grounded reply. The reply
   can stream (SSE) or return as JSON. History and the catalog reach the model strictly as untrusted
   data (never as instructions).
2. **Classify (asynchronous):** on every accepted turn, an async workflow reads the catalog, classifies
   the turn into `{category, severity, summary, suggested_routing}`, validates the shape, and UPSERTs the
   conversation's ticket (the conversation IS the ticket — later turns refine it).
3. **Serve:** the support desk reads the ticket (detail) and a paged list.

## Rules & posture

- **Catalog grounding is PROMPT-enforced, not structurally guaranteed.** The reply agent is INSTRUCTED
  to ground in the bounded catalog context and to invent no routing/owning team or a fix it cannot
  ground in the catalog or the user's own words; the async classifier is INSTRUCTED to pick its
  `category` / `suggested_routing` from the catalog (the `other` row when nothing matches). Catalog
  MEMBERSHIP of those values is NOT structurally enforced — a determined prompt injection in the turn
  text could steer an off-catalog value. The blast radius is capped: the agents are tool-less
  (`tools: []`), the extractor uses native structured output, and `validation.check` gates the ticket
  SHAPE (the required fields are present) — it does NOT check catalog membership (the same posture the
  invoice-intake example uses).
- Re-sending an identical message converges on ONE reply and ONE processing run (never a double
  classification); sending different text under the same message id is rejected (409), never silently
  replaced.
- Oversized messages are rejected before any processing (413).
- A conversation belongs to exactly one tenant; a turn for another tenant's conversation never runs, and
  a tenant's ticket views never read another tenant's rows.
- Reads are GET endpoints; there is no product write/admin endpoint — writes happen only through the
  conversation ingress + the workflow.
- LOCAL / single-node / trusted posture (not internet-facing without the separate hardening layer).
  Every route — including the chat turns — is org-member bearer in v1; a browser-widget / untrusted
  external end-user auth story is a named follow-on (see Users & jobs). v1 does not serve untrusted
  end-users.

## Explicitly out of scope (v1)

- Knowledge-base / retrieval ("answer from all past tickets"): the grounding is a BOUNDED catalog read,
  never embeddings/search (out of scope by design). Any KB pull is its own decision.
- Accumulating multi-turn context INTO the async extraction: the classifier sees ONE turn's text + the
  catalog; the ticket is UPSERTed per turn and reflects the LATEST turn's classification. The bounded
  history window feeds the synchronous REPLY, not the extraction. (A named follow-on.)
- Tool-using chat agents (the reply agent is tool-less in v1), per-conversation delete, conversation-level
  cost rollup, and a rename/close surface (a title is a creation-time assertion, not mutable state).
- A product-declared mutation/admin API — this product has no write/admin surface.

## How this maps to the document

| PRD need | Document construct |
| --- | --- |
| Multi-turn conversation + turns | capability `conversation_input` (PUT `/conversations/{id}` + POST `/conversations/{id}/turns`) |
| Idempotent re-send / divergence reject | the `turn_submitted` event's per-turn idempotency key + the divergent-text 409 |
| Grounded, multi-turn reply (JSON or SSE) | the responder config (`conversation/support_responder.responder.json`): history window + a bounded `store_context` read of `support_catalog` |
| Known-issues/routing catalog | a declared `support_catalog` store (seeded) read by BOTH the responder and the workflow |
| Classify the turn into a routed ticket | a single-turn extraction `agent` (`support_extractor`) fed the turn text (payload) + the catalog |
| Validate the ticket shape | a `validation.check` step |
| One ticket per conversation | a declared `support_tickets` store + a `store_write` UPSERT on `ticket_ref` (= conversation id) |
| Ticket detail + list reads | two GET `views` over `support_tickets` |
