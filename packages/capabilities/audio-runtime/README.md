# @rayspec/audio-runtime

The product-neutral Tier B **Audio/Media session capability**. It owns
audio session/track upload, idempotent resumable chunk ingest, finalize, media storage, playback-token
minting, and range/streaming playback — with **zero product vocabulary**. It is the runtime realization
of the `audio_input` + `media_playback` capability contracts.

## Surface

- **Neutral root** (`@rayspec/audio-runtime`): the model (`types`), config/track policy (`config`), key
  derivation (`keys`), stores (`stores`), the capability core (`upload`, `playback`, `media-artifact`),
  the `session_finalized` event seam (`events`), the deterministic fake media adapter (`fake-media-adapter`),
  and the machine-readable `manifest`.
- **RaySpec binding** (`@rayspec/audio-runtime/rayspec`): `mountAudioCapability(...)` returns the neutral
  `stores[]`, the `api[]` routes, and the resolved handler map to wire behind RaySpec's real auth/tenancy
  chain (additive — touches no kill-set file). Handler factories bind the platform `RouteHandlerInit`/
  `StreamRouteHandlerInit` straight into the core ports.

## Behavior (declared 1.0 semantics)

- Upload watermark: `200` advance / `200` idempotent no-op / `409 gap`; sealed track late retry → `200`.
- Finalize: `409 chunk_count_mismatch`, idempotent terminal; a **dual-track finalize converges on exactly
  one** `session_finalized` event (session-scoped `${tenantId}:${sessionId}` idempotency key).
- Playback token: `409 not_ready` until a playable artifact exists; TTL `max(900, ceil(duration)+60)`
  clamped 24h.
- Playback: `200` / range `206` / `304` / `416`; resource-bound media token (`403` on cross-resource
  replay) + tenant-bound DB ownership re-validation (`404` on a cross-tenant token).
- Tenant isolation + blob path safety on every route (tested against a real Postgres + fs blob store).

## Event seam (Tier A hand-off)

Finalize does **not** run a product workflow — it emits `session_finalized` through an injected
`SessionFinalizedSink` (the id normalizes to the `audio_input.finalized_session` Tier B contract). The Tier A
workflow runtime subscribes and enforces session-scoped single-flight. `InMemorySessionFinalizedSink`
is the deterministic test/dev sink.
