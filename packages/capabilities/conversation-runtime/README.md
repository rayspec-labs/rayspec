# @rayspec/conversation-runtime

The generic Tier-B **conversational-ingress capability** (`conversation_input`).
A record×file hybrid: `record_input` donates the JSON-payload/durability discipline, `file_input`
donates the manifest/handler/mount template.

What it does (product-neutral, zero product vocabulary):

- **Idempotent conversation create** — `PUT {base}/{conversation_id}` (client-chosen id; a
  re-create of the same id is the same ack, C10; a divergent `title` assertion is a loud 409).
- **Bounded turn submit** — `POST {base}/{conversation_id}/turns` with the closed body
  `{ message_id, text }`: validate → bounds (32 KiB UTF-8 default) → persist the user turn in the
  capability-owned ledger → emit the `conversation_input.turn_submitted` trigger event a declared
  Product-YAML workflow runs on.
- **The C10 turn state machine** — per-TURN idempotency (`turn_ref` =
  `<conversation_id>:<message_id>`, never `conversation_id`: that would silently collapse every
  later turn into the first run); a re-POST of one message converges on ONE durable run; two turns
  racing one conversation resolve LOUD (typed 409 `conversation_turn_conflict` on the ledger's
  `seq_ref` unique — no in-tx 23505 recovery, the in-tx-poison law).
- **Capability-owned stores** — `conversations` (head; client id, tenant-prefixed unique ref,
  `owner` end-user SEAM column [NULL in v1], title, state, timestamps) + `conversation_turns` (the
  INSERT-only ledger; per-turn message text as RAW DATA, `run_id` seam, tenant-prefixed uniques
  on message and sequence). The ledger stores ONLY each turn's own message — never serialized
  history (the anti-quadratic law).

- **The live reply** — the SAME `POST .../turns` produces a REAL agent reply in the same
  request: the intake COMMITS first (its own short tx — a model fault can never roll it back), the
  reply runs through the injected `ConversationTurnResponder` with NO transaction held (the
  `routeTx: 'handler-managed'` engine posture), and the assistant reply persists as its OWN ledger
  row (`role: assistant`, `state: replied`, message id `reply~<user message_id>` — '~' sits
  outside the client id alphabet, so reply refs can never collide with client ids). The model
  input is a BOUNDED window over the ledger (turns + chars — the chars axis is ONE shared budget
  across the history block AND the optional store-context block, oldest history truncated first,
  the answered turn always surviving), trust-boundary-framed:
  every stored message is serialized to a single jailed JSON line (control chars +
  U+0085/U+2028/U+2029 escaped) below an untrusted-data preamble — stored content can never forge
  a section header or instructions.

**The honest reply seq-ordering law (read before consuming the ledger):** the reply row takes the
next FREE sequence AT PERSIST TIME. If the user's next turn arrives while the model is running,
that turn may win the earlier sequence and the reply lands AFTER it (user#1 → user#2 →
reply-to-#1 at seq 3): the ledger records ARRIVAL order, and the reply↔turn association is the
derived `reply~<message_id>` id — NEVER seq adjacency. When the USER turn wins the seq, the reply
silently retries onto the next one; when the REPLY persist wins a seq a concurrent user turn had
read, that turn surfaces the loud 409 `conversation_turn_conflict` (so the 409 is not
user-vs-user only) and its same-`message_id` retry converges;
on reply-persist retry exhaustion (bounded, 3 fresh-tx attempts) the typed 503 carries the
deterministic reply run id and a same-`message_id` re-POST converges on one reply without a second
model call (C10 — the reply row and the deterministic run id are the convergence authorities).

The event seam (`TurnSubmittedSink`) is bridged to the durable workflow runtime by
`@rayspec/conversation-workflow-bridge`. The assistant reply row emits NO event — only user turns
trigger workflows.

Exports: the core ops (`createConversation`, `submitTurn`, `ensureTurnReply`), the trust-boundary assembly
(`assembleTurnInput`/`readHistoryWindow`), the responder port (`ConversationTurnResponder` — the
live `runAgent` implementation is `@rayspec/product-yaml`'s `makeLiveTurnResponder`, wired
boot-side from the per-product `conversation/<agent_id>.responder.json`), the manifest
(`CONVERSATION_CAPABILITY_MANIFEST`, mirrored by the committed `manifest.json`), the store DDL
(`conversationCapabilityStores`), and the RaySpec binding (`./rayspec` —
`mountConversationCapability`).
