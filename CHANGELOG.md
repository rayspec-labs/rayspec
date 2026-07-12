# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.1.0
[1.0.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.0.0
