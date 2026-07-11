# The v1 posture — what a product document may declare

RaySpec v1 serves a deliberately **narrow, closed** declarative surface. A
product-profile document (`version: '1.0'` with a `product:` section) is mounted
only if every section it declares maps to a wired runtime; anything outside the
sets below is rejected at compose time, loudly, rather than mounted as an inert
route that fails at request time. This chapter enumerates that surface exactly —
the closed sets a mounted document may draw from — and the shape guarantees the
runtime enforces.

This is the *capability* posture. It sits on top of, and does not restate, the
deployment posture in the README's [Security posture](../README.md#security-posture)
section: one **trusted, self-hosted, single node**, pre-external-hardening. Read
that first.

## One deployment, one tenant

A v1 deployment serves **exactly one tenant** (the deployment org). Every workflow
run, every store write, and every view read executes under that single
server-derived tenant id — there is no request-time tenant fan-out. Multi-tenant
routing is a later, hardening-adjacent concern; it is not in v1.

## Triggers are ingress events only — no cron, no outbound

A v1 workflow is driven **only** by an inbound capability ingress event (an audio
session finalized, a file submitted, a record submitted, a conversation turn
submitted). There is **no** scheduled/cron trigger surface and **no** outbound
call surface in a product document: a product cannot declare a timer, a webhook
out, or a call to a third-party API. The only way work starts is an end user (or
their client) driving one of the wired ingress capabilities.

### The four trigger events

Each wired ingress capability emits exactly one workflow trigger event. The event
id, its single-flight idempotency key field, and its canonical payload keys are
fixed by the capability manifest (not a hand-maintained list) and normalized
through `packages/kernel/spec/src/product-events.ts`:

| Trigger event (canonical id)         | Capability manifest                                     | Idempotency scope / key field | Payload keys |
| ------------------------------------ | ------------------------------------------------------- | ----------------------------- | ------------ |
| `audio_input.finalized_session`      | `packages/capabilities/audio-runtime/src/manifest.ts`        | `session_scoped` / `session_id` | `session_id`, `tenant_id`, `tracks`, `source_capability` |
| `file_input.file_submitted`          | `packages/capabilities/file-runtime/src/manifest.ts`         | `file_scoped` / `file_id`       | `file_id`, `tenant_id`, `source_capability`, `sha256`, `size_bytes`, `content_type`, `original_filename`, `blob_key` |
| `record_input.record_submitted`      | `packages/capabilities/record-runtime/src/manifest.ts`       | `record_scoped` / `record_id`   | `record_id`, `tenant_id`, `source_capability` |
| `conversation_input.turn_submitted`  | `packages/capabilities/conversation-runtime/src/manifest.ts` | `turn_scoped` / `turn_ref`      | `conversation_id`, `message_id`, `turn_ref`, `tenant_id`, `source_capability`, `turn_seq`, `role`, `message` |

A workflow's `trigger.event` names the capability event (e.g. `session_finalized`,
which normalizes to `audio_input.finalized_session`). A `store_write` step's
`{ event: … }` value may draw **only** from that event's payload keys.

## Views are read-only

Every view is a **`GET`** projection. A product document declares no mutating view
(a `POST`/`PUT`/`DELETE` implies a handler, which the product profile does not
expose); writes happen only inside a workflow, off-request. The sole view auth
policy is **`bearer_tenant`** — a valid org-scoped bearer for the deployment
tenant. A store- or `artifact_query`-sourced view **must** declare a `read` block
(a source with no read cannot serve anything); a `capability`-sourced view (e.g. a
playback-token mint) delegates to the capability's own handler.

## The data plane is equality-and-upsert only

A declared product store is a single tenant-scoped table with a **single-column
key**. `store_read` filters are **equality-only** column filters; `store_write` is
an **upsert on the key column** (the durable engine is at-least-once, so every
write must converge). Composite keys, per-column defaults, product-to-product
foreign keys, and non-tenant stores are deliberately unsupported. Artifacts are
**ingress-unit-scoped**: a persisted artifact declares a `collection` (its backing
store) and a `scope` (`session`/`file`/… — the ingress unit it belongs to), and
the composition derives one collection store per declared collection.

## The closed capability set

A mounted document may declare only these **nine** capabilities
(`packages/compose/product-yaml/src/compose.ts`, `WIRED_CAPABILITIES`):

`audio_input` · `media_playback` · `record_input` · `file_input` ·
`conversation_input` · `stt` · `grounding` · `validation` · `artifact`.

A workflow step's `type` is one of **seven** compilable step types
(`COMPILABLE_STEP_TYPES`): `capability`, `agent`, `validation`,
`artifact_persist`, `artifact_read`, `store_read`, `store_write`.

A step's `use` operation is one of **eight** wired non-agent operations
(`WIRED_OPERATIONS`) — `stt.transcribe_session`, `grounding.check`,
`validation.check`, `artifact.persist`, `artifact.read`, `store.read`,
`store.write`, `file_input.parse_text` — plus one **dynamic** `agent.<extractor_id>`
per declared extractor. Anything else is rejected.

## Grounding is same-run, closed-span citation checking

When a document declares `grounding`, the executed gate is a **closed-span-set
citation check against the same run's source spans** — it does not reach across
runs or fetch anything. Because the runtime honours a fixed policy, a *mounted*
document must declare the load-bearing fields exactly
(`packages/compose/product-yaml/src/compose.ts`, the grounding envelope):

- `require_source_spans` **must be `true`**, with a `source_span_contract` (the
  closed span-set contract the citations are validated against);
- `on_invalid_citation` **must be `prune`** (out-of-set citations are removed);
- `on_empty_evidence` **must be `drop`** (an evidence-less claim never persists);
- `attribution_policy.tracks` values must each be `local`, `remote`, or `unknown`.

**What the checker verifies today:** by default, citation **membership** — every
cited span id must belong to the declared closed span set; out-of-set citations are
pruned and evidence-less claims are dropped. A stronger **quote-text** check is
available **opt-in**: when an artifact declares a `provenance.quote_field`, each
claim's quoted text must be a **verbatim token-run subset** of a cited, in-set span
(checked **per span**, never the concatenation of spans); a quote that no cited span
supports is flagged `unsupported_claim` (verdict `ungrounded`). It is **default-off**
— an artifact that declares no `quote_field` gets membership-only checking, exactly as
above: the span text is never read, so a product declaring no `quote_field` on any
artifact is unaffected by the quote check. The check is **fail-closed** on a missing
or malformed span-text carrier (no text ⇒ unsupported, never a silent pass). How an
unsupported claim is then handled follows
the declared `grounding.on_unquoted_claim` mode — `fail` | `prune` | `drop` |
`ignore`, **default `ignore`** (advisory finding only). **Known limitation:** an
**empty** quote string (`''`) is not verified — a zero-length quote skips the check
(a declared-but-empty quote is treated as "no quote to check", not a failure).

## The complete worked example

[`examples/acme-notes/acme-notes.product.yaml`](../examples/acme-notes/acme-notes.product.yaml)
is a neutral document that exercises this whole surface end to end (audio → STT →
grounded note extraction → validation → typed-artifact persistence → read views).
It validates and composes:

```bash
rayspec deploy --dry-run examples/acme-notes/acme-notes.product.yaml
```
