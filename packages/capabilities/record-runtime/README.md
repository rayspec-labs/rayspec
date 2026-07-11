# @rayspec/record-runtime

The generic Tier-B **submit-ingress** capability (`record_input`): one
authenticated `POST /records/{record_id}/submit` route that turns a JSON business record into the
`record_input.record_submitted` workflow trigger event. Product-neutral by law — the record's
fields are arbitrary product DATA (never instructions — the trust boundary); this package carries zero product
vocabulary (enforced by `manifest.test.ts` + `deployed-surface.test.ts`).

## The durability recipe (the audio pattern, adopted)

- **Deterministic tenant-scoped event id** — `${tenantId}:${record_id}`.
- **Idempotent re-submit re-emits** — persist first (atomic upsert on the tenant-prefixed
  `record_ref` unique), then emit on EVERY successful submit; the tenant-bound dispatcher dedups by
  the descriptor-derived key `record_id:<id>` (idempotent single-flight — client retry = redelivery).
- **Per-tenant capability-store keying** — `record_ref` embeds the server-derived tenant, so two
  tenants' identical `record_id` never collide (NOT the declared-store global-key caveat class).
- **Different payload, same key → loud 409** (`record_conflict`, canonical-JSON payload hash) —
  never a silent dedup onto different data; the stored payload is authoritative (re-read on emit).

## The payload contract (manifest-stated, gate-pinned)

Submitted business fields MERGE **top-level** into the trigger payload alongside the fixed
envelope (`record_id` · `tenant_id` · `source_capability`) — that is what makes them reachable by
`store_write` `{ event: <field> }` sources. The envelope keys are therefore RESERVED in a
submission body (422), the canonical-JSON serialization is capped at 64 KiB (413), and the seam
adapter (`@rayspec/record-workflow-bridge`) stamps the envelope LAST (envelope wins).

## Composition

`composeProductDeploy` mounts this capability **iff the Product-YAML doc declares
`record_input`** (the conditional-mount law; audio stays unconditional), wiring the
submit route to the same tenant-bound `WorkflowEventDispatcher` behind the bridge's fail-closed
cross-tenant sink (403 `record_event_rejected`, zero enqueue).
