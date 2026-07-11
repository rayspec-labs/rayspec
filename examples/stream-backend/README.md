# Stream backend — a synthetic stream/blob backend delivered as an extension pack

This is a tiny, **synthetic** backend that is the platform's **own** forcing function for the
`stream` primitive AND the **`extensions[]` pack mechanism**. It is **NOT** a real product pack —
those ship as product code in their own repos. A tiny synthetic fixture staying in `examples/` keeps
the platform itself product-free while still proving the mechanism end-to-end.

## The stream surface is an extension PACK

The deployment `rayspec.yaml` is **THIN** — `version` + `metadata` + ONE `extensions[]` ref. The
whole stream surface (the `blob_chunks` store, the ingest/playback/mint handlers, the stream + mint
routes) lives in a **`defineExtension` pack** under [`packs/stream-pack/`](./packs/stream-pack):

```yaml
extensions:
  - id: stream_pack
    module: ./packs/stream-pack   # a DIRECTORY (path-jailed at deploy; npm-module refs not exercised here)
    version: 1.0.0                 # an EXACT pin — a SKEW with the pack manifest aborts the deploy
```

At boot, `@rayspec/platform`'s `loadExtensions` resolves the pack (directory-only **path-jailed**;
**version-pin fail-closed** — a skew aborts the deploy, never a silent skip), jails each pack handler
against the **pack root**, and **merges** the pack's store/handler/route fragments into the
deployment spec. The **UNCHANGED** `deploy()` then materializes the pack store (through the
**UNCHANGED** migration gate + the chokepoint probe — **no new migration path**), the api interpreter
serves the routes, and the path-jailed loader loads the handlers. A real product pack is the intended
consumer of this exact mechanism, shipped from its own repo.

## It lives OUTSIDE the platform — by design

- The deployment dir is **not** a workspace package (a pure YAML fixture). The PACK
  (`packs/stream-pack`) IS a `@spike/*` workspace member **only** so pnpm links `@rayspec/platform`
  into its `node_modules` (the pack ENTRY imports `defineExtension` at runtime) — mirroring how a real
  pack ships in its own repo with the platform as a dependency. It ships **no** build/typecheck/test
  scripts and is excluded from CI by the `--filter='!@spike/*'` rule (a pure loaded-at-deploy fixture).
- **Zero product-specific code enters the platform.** The `stream`/`BlobStore`/`extensions[]`
  primitives are strictly product-agnostic (raw `Request`/`Response`, zero audio/media vocabulary in
  core). The pack HANDLER modules import ONLY `@rayspec/handler-sdk` (type-only); the
  manifest-derived `gate:handler-imports` + `gate:extension-capability` discover + scan the pack's
  `handlers/` root.

## What it exercises

| Section        | In the pack (`packs/stream-pack/index.ts`)                                                        |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `stores`       | `blob_chunks` — a blob **pointer-row** table + a `chunk_ref` **`unique`** idempotency-authority   |
| `api`          | a `stream`/`ingest` POST + a `play-token` mint POST + a `stream`/`playback` GET — all implemented |
| `handlers`     | `chunk-ingest.ts` + `chunk-playback.ts` + `play-token-mint.ts` — all **route**-kind               |
| `extensions`   | the deployment `rayspec.yaml` references THIS pack via one `ExtensionRef` (exact pin `1.0.0`)     |

## The ingest contract — and its idempotency authority

`packs/stream-pack/handlers/chunk-ingest.ts` implements the idempotent **200-ack / 409-gap /
200-no-op** chunk-ingest contract using ONLY the injected tenant-bound capabilities — `init.blob`
(put-by-index, idempotent) + `init.db` (the pointer row). It reads the **raw** binary request body
(never JSON) and returns a raw `Response`.

The idempotency authority is the **DB UNIQUE** on `chunk_ref` (= `${tenantId}:${upload_id}:${chunk_index}`),
NOT a durable run (the chunk ingest is a synchronous request, so the non-idempotent-taint quarantine
does not cover it — idempotency rests on the pointer-row UNIQUE + the same-`transaction()` atomicity +
the idempotent blob put-by-index). The grammar expresses uniqueness only per-column (`unique:true`),
so `chunk_ref` is the in-grammar way to express a composite `UNIQUE(upload_id, chunk_index)` — and the
**tenant prefix** is load-bearing (the generated single-column UNIQUE index is GLOBAL, so without the
prefix two tenants' same `(upload, index)` would collide).

The committed `packs/stream-pack/generated/product-schema.ts` +
`packs/stream-pack/drizzle/0000_product_stores.sql` are the spec-derived artifacts (`@rayspec/db`
codegen — read the generated SQL, never blind-apply it) the pack ships; they carry the
`blob_chunks_chunk_ref_unique` index that enforces the contract.

## The playback contract — the media-streaming read + the SECOND auth path

`packs/stream-pack/handlers/chunk-playback.ts` implements the **Range/206 + conditional-GET
(ETag/If-Range/304/416)** media read over ONE chunk's blob, using ONLY the injected tenant-bound
capabilities — `init.blob.stat` (len + a stable `etagSource`) +
`init.blob.createReadStream({offset,length})` + `init.db` (the DB ownership re-validation).

The playback route is authenticated by a signed **`?token=` media-JWT** — a **SECOND auth path**,
HS256, signed with a **distinct** `RAYSPEC_MEDIA_SIGNING_KEY` (separate from the RS256 API/JWKS chain
— a leaked media URL grants nothing on the API, and vice versa). The verifier sets the server-derived
tenant FROM the token; the handler then (1) **binds** the token's opaque `resource` claim to the
requested route resource and (2) **re-validates ownership in the DB** (a tenant-A token against
tenant-B's blob finds no row under A's scope → 404). A per-user streaming **semaphore** bounds
concurrent streams → 429 + `Retry-After`.

`packs/stream-pack/handlers/play-token-mint.ts` is the **mint** route — a normal `{handler}` route on
the standard (RS256 Bearer) auth chain that, after confirming the caller's tenant owns the chunk (via
`init.db`), mints a short-lived `?token=` via the engine-injected `init.mintPlayToken`.

## Where it is exercised end-to-end

- `packages/kernel/spec/src/stream-backend.test.ts` — the THIN deployment spec parses + carries the
  `extensions[]` ref (spec layer; no `loadExtensions` dependency).
- `packages/kernel/platform/src/extensions/load-extensions.test.ts` — `loadExtensions` fail-closed
  battery (version-pin skew, path-jail, npm-style ref, non-manifest entry, multi-root merge).
- `packages/compose/api-auth/src/engine/stream-ingest.db.test.ts` + `stream-playback.db.test.ts` — the
  ingest + playback surface, loaded **via the pack** (`test-support/stream-pack-support.ts`).
- `packages/app/server/src/stream-pack.db.test.ts` — the FULL pack mechanism end-to-end through the REAL
  composition root + a real DB (deploy → store materializes → ingest 200 → playback 206; version-skew
  aborts).
