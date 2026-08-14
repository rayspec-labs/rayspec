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
  into its `node_modules` (the pack ENTRY imports `defineExtension` at runtime). That workspace link
  is the **in-repo** form of the platform dependency: the manifest's `workspace:*` specifiers resolve
  only inside this workspace, so a real pack in its own repo declares the same two dependencies on a
  **released** version instead — see
  [Shipping this pack from its own repo](#shipping-this-pack-from-its-own-repo). It declares **no**
  build/typecheck/test scripts and is excluded from CI by the `--filter='!@spike/*'` rule. It is not
  build-free, though: the deploy runtime loads compiled JavaScript only, so this example ships its own
  [`build.mjs`](./build.mjs) (see [Shipping this pack from its own repo](#shipping-this-pack-from-its-own-repo)).
- **Zero product-specific code enters the platform.** The `stream`/`BlobStore`/`extensions[]`
  primitives are strictly product-agnostic (raw `Request`/`Response`, zero audio/media vocabulary in
  core). The pack HANDLER modules import ONLY `@rayspec/handler-sdk` (type-only); the
  manifest-derived `gate:handler-imports` + `gate:extension-capability` discover + scan the pack's
  `handlers/` root.

## Shipping this pack from its own repo

Copied out of this monorepo, this pack does **not** install as committed: its manifest declares
`@rayspec/platform` + `@rayspec/handler-sdk` as `workspace:*`, and the pnpm workspace protocol
resolves only inside this workspace. Installing it elsewhere fails outright (`npm` →
`EUNSUPPORTEDPROTOCOL`, `pnpm` → `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`), so `node_modules` stays empty
and — in a deploy tree that carries no `@rayspec` install of its own — the pack entry aborts the boot
fail-closed with

```
extension 'stream_pack': failed to load pack entry 'index.ts' (…/dist/index.js):
Cannot find package '@rayspec/platform' imported from …/dist/index.js — a pack's entry
module must default-export a defineExtension(...) manifest (fail-closed).
```

The trailing clause is the loader's standing advice on that error path, not a second diagnosis: the
entry never ran, so nothing could inspect what it exports.

The **resolution rule** behind that error is the thing to design the delivery around: the loader
imports the pack entry by the entry's own absolute file URL, so Node resolves the bare
`@rayspec/platform` specifier from the **built file's own location** upward — the pack directory
first, then every ancestor above it, the deployment root included. The pack's own `node_modules` is
the first stop on that walk and the only one the pack controls, so a pack that brings its own
dependencies is the one that gets the version it pinned. A pack shipped from its own repo needs
three things.

**1 — a manifest pinning a RELEASED platform.**
[`packs/stream-pack/package.out-of-repo.json`](./packs/stream-pack/package.out-of-repo.json) is this
pack's manifest in that form (the file additionally carries a `"//"` note explaining itself); copy it
over `package.json` after copying the pack out:

```json
{
  "name": "stream-pack",
  "version": "1.0.0",
  "private": true,
  "license": "FSL-1.1-ALv2",
  "type": "module",
  "main": "./dist/index.js",
  "dependencies": {
    "@rayspec/handler-sdk": "1.7.0",
    "@rayspec/platform": "1.7.0"
  }
}
```

The pinned version **must equal the platform version the deployment runs** — the entry imports
`defineExtension` from that exact build, and the `@rayspec` closure (`core`, `db`, `handler-sdk`,
`platform`, `spec`) is released in lockstep under one version. `1.7.0` is the current release and what
the pins above name; the recipe itself was verified against `1.6.2`, the release before it. Check the
registry for the current version.

`@rayspec/platform` is a **runtime** dependency: the entry imports `defineExtension` as a VALUE, and
`tsc` transpiles rather than bundles, so the bare specifier survives into `dist/index.js` and is
resolved when the pack is loaded. `@rayspec/handler-sdk` is not in the same position — the handlers
import only its TYPES (`import type`, erased under `verbatimModuleSyntax`), so nothing asks for it at
runtime. It is pinned here anyway, and deliberately: a handler that later imports a value from it
would otherwise fail at boot rather than at build, and it costs one entry in a manifest that has to
be version-locked to the platform regardless.

**2 — an install, so the pack has a real `node_modules`.**

```bash
npm install   # -> node_modules/@rayspec/{core,db,handler-sdk,platform,spec}
```

**3 — the pack DIRECTORY at the deploy target, `dist/` *and* `node_modules/` together.** Put
`node_modules` where the upward walk from `dist/index.js` reaches it first — beside `dist/`, in the
pack root. Ship `dist/` alone and the walk continues past the pack into the deploy tree, with two
outcomes and no third: nothing up there provides `@rayspec/platform` and the boot fails with the
error above, or something does and the pack quietly runs against a platform build it never pinned —
exactly the version skew step 1 exists to prevent. The deployment spec then references the built
directory:

```yaml
extensions:
  - id: stream_pack
    module: ./packs/stream-pack/dist # the BUILT dir; ./packs/stream-pack/node_modules is one level up
    version: 1.0.0
```

Note the difference from the committed `rayspec.yaml` at the top of this page, which points at
`./packs/stream-pack` — the pack SOURCE. That form works in this repository because the dev/test
importer strips types on the way in; a deploy runtime loads compiled JavaScript only, so an
out-of-repo deployment points at the built directory.

To walk it with this pack: `node examples/stream-backend/build.mjs`, copy `packs/stream-pack/`
(without its workspace-linked `node_modules`) anywhere outside the repo, do the three steps above.
The `version` in this manifest is npm's, and nothing in the platform reads it. The version
`loadExtensions` fail-closed-matches against the deployment's `extensions[].version` is the one the
pack ENTRY declares — the `version` field passed to `defineExtension(...)` in `index.ts`. They are
both `1.0.0` here, which is convenient and not a rule.

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
