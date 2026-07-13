# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-07-13

### Added

- **Static frontend serving from the spec.** A backend-profile document may now
  declare a `frontend` list of `{ route, dir, spa? }` mounts, and the booted server
  serves each mount's built static assets alongside its API — one config can ship a
  whole product, UI included. Static mounts are served last: every API route,
  `/health`, `/v1/*`, and `/oidc/*` always wins (a path under a reserved platform
  prefix is never answered by a static mount), and a static miss returns the uniform
  `404`. `spa: true` falls unmatched deep links back to `index.html`; Range and HEAD
  requests are honored. Serving is fail-closed — path traversal (including
  URL-encoded forms), dotfiles/hidden paths, and directory-escaping symlinks are
  refused, and directories are never listed. A missing/unreadable `dir` fails the
  deploy closed with an actionable error, and `doctor` reports a missing directory
  and route collisions (a `frontend` route may not duplicate another mount, equal a
  declared `api` path, or target `/v1`/`/health`/`/oidc`). Not in v1 (documented):
  SSR, templates, an asset pipeline, cache/CDN headers, and the product profile. See
  `examples/notes-ui/` and the `frontend` spec reference.

## [1.2.2] - 2026-07-13

### Added

- **A server-stamped `created_by` actor column on every store row.** Each row now
  records the principal that created it — `user:<userId>` for a JWT request,
  `key:<apiKeyId>` for an API-key request. It is stamped on create only (never
  re-stamped on update), returned in responses, and is not client-settable: it is a
  reserved column, so a `created_by`/`createdBy` field in a request body is rejected
  (`400 VALIDATION_ERROR`). It is filterable on a `list` route, so a caller can list
  only the rows it created. (A row created before this column existed carries a null
  `created_by`.)
- **Query power on the declarative `store` `list` op.** A `list` route now accepts
  equality filters (`?<column>=<value>` on any declared column plus `created_by`,
  AND-combined — equality only, no ranges / `OR` / `LIKE`), single-column ordering
  (`?order=<column>.asc|desc` over non-nullable columns and the injected
  `id`/`created_at`; default `id asc`), and keyset pagination (`?limit=` in `1`–`200`,
  default `200`, plus `?after=<opaque cursor>`). A full page sets
  `X-Result-Truncated: true` and returns an `X-Next-Cursor`. Every filter, order, and
  cursor is folded through the tenant predicate, and an unknown query parameter is
  rejected (`400`). An offset-paged read or a filtered total count still drops to a
  `handler` route.
- **`Idempotency-Key` replay on `store` `create`.** A create request carrying an
  `Idempotency-Key` header is deduplicated per tenant and per store: a repeat with
  the same key value replays the original row (`200` with `Idempotency-Replay: true`,
  no duplicate row and no `409`), regardless of the request body. A request without
  the header is never deduplicated. This is distinct from a `unique: true` column,
  whose duplicate value is a `409 CONFLICT` rather than a replay.
- **Owner-gated org membership management.** `POST /v1/orgs/{orgId}/members` adds a
  member by `{email}` — owner-only, via a live-membership permission check (a
  non-owner, or an API-key principal, is refused). An existing user is added
  idempotently as a `member`; a new email provisions an account and returns a
  `oneTimePassword` once in the owner's response (the core sends no mail — the owner
  conveys it out of band). `GET /v1/orgs/{orgId}/members` lists the org's members and
  is readable by any member. Accepted limitation: because the one-time password
  appears only for a newly provisioned account, the response reveals whether an email
  already has a platform account — accepted for the trusted single-node posture and
  closed by the out-of-band invite flow in the hardening layer (see `SECURITY.md`).
- **A shipped authoring skill, `rayspec-author`,** guiding an assistant from a
  plain-language product brief to a validated spec and a deployed, curl-testable
  local backend, plus a `gate:skill-drift` build guard (in the deterministic CI lane)
  that fails if the skill drifts from the shipped grammar version, the CLI
  entrypoints, or the example specs it cites.
- **`rayspec dev db --reset --yes`.** An opt-in, destructive local-dev reset that
  DROPs and re-CREATEs a clean, empty dev database (and drops the sibling
  `<name>_dbos_sys` durable-worker system database). It is gated on an explicit
  `--yes`; `--reset` without it refuses and touches nothing. The default `dev db`
  remains create-if-absent and never destructive.

### Changed

- **`store` `create`/`update` bodies accept snake_case or camelCase column keys.** A
  request may key each declared column by its snake_case declared name or its
  camelCase twin (the form the generated OpenAPI documents); both are accepted.
  Sending both variants of the same column in one body is rejected
  (`400 VALIDATION_ERROR`). Responses are always snake_case.
- **Newly minted API keys use an `rk_` prefix** (previously `mk_`); the key shape is
  `rk_<public-prefix>.<secret>`. Existing `mk_` keys stay valid indefinitely — both
  prefixes are accepted.
- **Quieter boot.** The benign `NOTICE` frames Postgres emits for each idempotent DDL
  guard in the migration chain (`… already exists, skipping`) are no longer printed,
  so a clean boot no longer prints a wall of messages that read like errors. A
  `WARNING` (or any higher severity) is still logged, and query error handling is
  unchanged.

## [1.2.1] - 2026-07-12

### Changed

- **`LICENSE` copyright holder is now the legal entity `Socialinsiders UG
  (haftungsbeschränkt)`.** The FSL-1.1-ALv2 notice attributes copyright to the
  operating legal entity rather than the trade name (counsel instruction,
  2026-07-12). No license terms change — the grant, the change date, and the
  future license are unchanged.

## [1.2.0] - 2026-07-12

### Changed

- **An author-declared store column `unique: true` is now TENANT-SCOPED.** The
  generated unique index is a compound `(tenant_id, <col>)` index rather than a
  global one, so two tenants may hold the same value (uniqueness is enforced
  within a tenant) and a duplicate never reveals another tenant's data. A durable
  product-store `key` column keeps its single-column index (its `ON CONFLICT`
  upsert target is unchanged).

### Fixed

- **A same-tenant uniqueness violation on a REST store write now returns `409
  CONFLICT` instead of a bare `500`.** The response names the violated column and
  never echoes the offending value or any foreign-tenant data; it applies to both
  `create` and `update` store routes.
- **Every `5xx` response now emits one server-side log line** — carrying the request
  id and status, plus the error code and message when the failure was a thrown error.
  This covers both a thrown error (mapped by the global handler) and a directly
  returned upstream `502`/`504` (the live sync-run path), each logged exactly once.
  The previous `500` branch was a silent swallow; a `4xx` (including the new `409`)
  still logs nothing. The line is server-side only (the client still gets the bare
  envelope); the log path does no database write and never throws, so it is safe
  during an outage.

## [1.1.0] - 2026-07-12

### Added

- **`rayspec-serve` and `rayspec deploy` boot a backend-profile spec with agents
  directly.** Point either entrypoint at a backend-profile document that declares
  agents — `rayspec-serve` reads `RAYSPEC_SPEC_PATH`, and `rayspec deploy <spec>`
  sets it for you — and the shipped boot builds each declared agent's backend
  instance from the ambient environment (for example the `openai` backend from
  `OPENAI_API_KEY`), with no hand-written `AgentBackendsFactory` wrapper. Both paths
  assemble their deployer seams through the same shared builder, so `deploy` and
  `serve` are the same boot for a spec with agents. A missing or misconfigured
  credential fails the boot fast, naming the backend and the agent(s) that select it.
- **A worked backend-profile example with a live agent.** `examples/lead-qualifier`
  is a backend-profile spec whose declared agent runs off-request on the durable
  worker and records its verdict through a persist tool — a runnable end-to-end
  example (with deterministic and live test suites), not just a grammar showcase.
- **Scope-gap 403s name the missing permission.** An authenticated request that
  lacks the required permission now returns a `403` whose error body carries
  `details.missing_permission`, so a client can tell which scope it is missing. A
  membership-failure 403 and an unauthenticated 401 stay bare (no scope leak).

### Changed

- **`LICENSE` copyright holder is now RaySpec Labs.** The FSL-1.1-ALv2 notice
  attributes copyright to RaySpec Labs.
- Internal tidy-ups: `pnpm lint` is warning-free, and the dev-harness scratch
  directory `.dev-blobs/` is now gitignored.

### Fixed

- **`@rayspec/local-boot` drops the derived DBOS system database on a fresh-database
  re-provision.** When the local dev harness re-provisions its throwaway database
  (`DROP`+`CREATE`), it now also drops the sibling `<db>_dbos_sys` durable-worker
  system database, so a fresh-empty app database never pairs with orphaned
  workflow/queue state auto-created by a previous run.

### Documentation

- Clarified four onboarding points: a backend-profile spec with agents boots
  directly (no wrapper) — via either `rayspec-serve` or the equivalent `rayspec
  deploy`; a returning user calls `POST /v1/auth/login` (which returns
  `activeOrgId: null`) then `POST /v1/orgs/{id}/switch` to obtain an org-scoped
  token; the Anthropic subscription path needs `CLAUDE_CODE_OAUTH_TOKEN` in the
  server process's own environment; and the declarative `store` `list` op is
  unfiltered, unsorted, and uncounted (capped, with an `X-Result-Truncated` header)
  — a filtered, sorted, paged, or counted read drops to a `store:write`-gated
  `handler` route.
- `.env.example` now documents `RAYSPEC_PRODUCT_TENANT_ID` and
  `RAYSPEC_EXTRACTION_MODE`, the two variables a product-profile `deploy` requires.

## [1.0.0] - 2026-07-11

The first tagged release of RaySpec — file-deployable AI infrastructure. Describe
a product's backend in one declarative `version: '1.0'` spec, and the platform
stands up the running backend from that single file.

### Added

- **Declarative spec engine.** One `version: '1.0'` language with two profiles —
  a full-control **backend profile** (`metadata`, `stores`, `api`, `agents`,
  `tooling`, `triggers`, `handlers`, `extensions`, `deployment`) and a
  higher-level **product profile** (selected by a top-level `product:` section).
  Specs are parsed fail-closed: an unknown key is rejected, not ignored. The
  deploy pipeline validates, diffs the required migration, gates destructive
  changes, and materializes the declared backend.
- **Accounts, authentication, and tenancy.** First-class organizations,
  memberships, users, API keys, and JWT/OIDC — all owned by the platform. Every
  query against tenant-owned data carries a tenant predicate, enforced
  structurally by a single fail-closed, deny-by-default database chokepoint.
- **Four in-process agent backends behind one neutral interface.** OpenAI Agents,
  Anthropic's Claude Agent SDK, Pi, and OpenAI Codex all run in-process behind a
  single neutral `Backend` interface; an agent is declared once and its backend is
  chosen from the spec. A cross-backend parity suite holds every adapter to the
  same neutral contract.
- **A generated, tenant-scoped data layer.** Declared stores become
  Postgres/Drizzle tables with the tenancy and data-lifecycle columns injected
  automatically; migrations are diffed and passed through a safety gate before
  they apply, including a from-clean-database bootstrap check.
- **Durable background work and a run journal.** Long-running agent runs and
  scheduled triggers execute off-request on a durable worker, with a per-step,
  append-only, tenant-scoped run journal that is the single source of truth for
  replay, cost accounting, and audit.
- **Reusable ingress capabilities.** A product profile can request reusable
  capabilities by name — audio/transcription, file ingest, multi-turn
  conversation, and structured records — rather than writing the ingress plumbing.
- **The `rayspec` CLI.** `deploy` stands up a product's declared backend from its
  spec (validate → derive the required migration → plan → apply). Read-only
  diagnostics — `doctor` (static validation), `plan` (a read-only deploy preview
  with an optional shadow-apply), `openapi` (emit an OpenAPI document for a
  product's declared views), and `gen-handler` (render a bounded escape-hatch
  handler) — plus a local-dev `dev` group (`gen-secrets`, `db`,
  `bootstrap-tenant`).
- **The `rayspec-serve` boot server.** An environment-driven boot that fails
  closed on missing secrets, applies the committed migration chain, and serves the
  platform — with a loud banner stating its trusted, single-node, not-yet-hardened
  posture.

### Security

- Security by construction from the first boot: tenant isolation enforced by the
  fail-closed chokepoint (with a CI cross-tenant test), no plaintext secrets, an
  untrusted-content tool-dispatch trust boundary, an out-of-band audit journal,
  and per-backend credential isolation. The additional hardening required for
  untrusted, multi-tenant, public-internet hosting is a separate layer and is
  deliberately not part of the core — see [`SECURITY.md`](./SECURITY.md).

[1.3.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.3.0
[1.2.2]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.2.2
[1.2.1]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.2.1
[1.2.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.2.0
[1.1.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.1.0
[1.0.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.0.0
