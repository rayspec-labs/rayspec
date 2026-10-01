# @rayspec/bundle-contract

The **bundle contract** in code: the format of a RaySpec application bundle (`.ray`), of the
encrypted migration snapshot and of the managed hosting receipt. It carries the JSON Schemas and
vocabularies of the contract, their TypeScript types, the canonical JSON form the contract
defines, and validators for `ray.json`, `snapshot.json` and the managed receipt that return codes
from the contract's closed error vocabulary.

- `validateManifest`, `validateSnapshot`, `validateReceipt` — parse a document under the
  canonical JSON rules, validate it with its JSON Schema (Ajv 2020, strict), then apply the
  rules a schema cannot express. The first failure comes back as `errors[0]`; hostile input never
  throws.
- `validateObjectIndex` — `payload/object-index.json` of a snapshot: canonical JSON, the schema,
  entries sorted by tenant and then key by byte value with each pair once, and stored ranges that
  start at offset 0, follow one another without a gap or an overlap and, given the size of
  `objects.bin`, end exactly where it ends (`RAY_DIGEST_MISMATCH` `object-range`). `SNAPSHOT_PATHS`
  and `SNAPSHOT_ROOT_NAME` name the fixed entries of the inner snapshot archive.
- `checkRuntimeAdmission` — the runtime, target, capability and reserved-binding checks of a
  validated manifest against one runtime.
- `canonicalJson`, `canonicalJsonFile`, `parseJsonDocument` — keys in code-point order, safe
  integers only, NFC strings, at most 64 nested containers, one trailing LF in a file.
- `planDigest`, `planExpiresAt`, `isPlanExpired`, `productSchemaDigest`, `bindingRevisionId`,
  `checkRequestBase`, `checkPrepareRequest` — the pure rules of the runtime-control operations,
  so a runtime and a caller compute the same plan digest from the same inputs; `SCHEMA_LOCK_*` is
  the shared schema lock key, and `PLATFORM_TABLES` the platform tables with their snapshot data
  categories (the committed ones plus the runtime-control pair).
- `ERROR_CODES`, `CAPABILITIES`, `RESERVED_BINDING_NAMES`, `DEFAULT_READER_LIMITS`,
  `SUPPORTED_TARGETS` and the other vocabularies, plus the types of the result envelope and the
  runtime-control operations.

The package does no I/O: it reads no file, opens no connection and knows no cloud provider. The
committed contract files ship under `contract/`, and `contract/CONTRACT-LOCK.json` records the
SHA-256 of each of them. The golden fixture corpus under `corpus/` is rebuilt from
`contract/fixtures/EXPECTATIONS.json` by `pnpm --filter @rayspec/bundle-contract gen:corpus`, and
the tests compare it byte for byte.

Part of [RaySpec](https://rayspec.dev) — **file-deployable AI infrastructure**: describe a
product's backend in one declarative YAML file, and RaySpec stands up accounts and
authentication, in-process agents, an HTTP API, a Postgres-backed data layer, durable
background jobs, and the supporting tooling — deployed GitOps-style from that single file.

Most projects consume this package indirectly — start with
[`npx rayspec init`](https://www.npmjs.com/package/rayspec) or `@rayspec/server` rather
than depending on it directly.

## Links

- Website & docs: <https://rayspec.dev>
- Source (monorepo): <https://github.com/rayspec-labs/rayspec>
- Changelog: <https://github.com/rayspec-labs/rayspec/blob/main/CHANGELOG.md>

## License

Source-available under the **Functional Source License (FSL-1.1-ALv2)** — each release
converts to Apache-2.0 two years after publication. See
[LICENSE](https://github.com/rayspec-labs/rayspec/blob/main/LICENSE).
