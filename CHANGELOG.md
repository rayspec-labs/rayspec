# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] - 2026-07-14

### Added

- **Opt-in `readonly` route handlers.** A `{ kind: route }` handler may now declare
  `readonly: true`. A `handler`-kind route is gated on the sensitive `store:write`
  permission by default (the platform cannot statically prove a handler only reads, so
  it fail-closes to the stronger gate); `readonly: true` is the author's assertion that
  the handler only reads product stores, so its route is gated on `store:read` instead
  — letting a read-scoped credential (for example an ingest-only API key) reach a
  read-only route. It is an authorization gate / author assertion, not a runtime
  write restriction. An absent or `false` flag parses byte-identically to before, so
  every existing spec, fixture, and golden is unchanged.
- **A tenant-scoped session reprocess endpoint.** `POST /v1/sessions/{id}/reprocess`
  (`store:write`, strictly tenant-scoped) re-drives a session's declared
  finalized-session workflow as a **fresh durable run under a distinct idempotency
  key** — the operational recovery path for re-running extraction after a fix or
  unsticking a stuck session, without manual database surgery (simply re-emitting the
  finalized event deduplicates to the original run and does nothing). It is wired for
  audio products; a deployment with no reprocessor wired answers `501`, and a foreign
  or absent session id returns `404` with zero enqueue.
- **Opt-in reuse of a machine `claude` login for the Anthropic backend.** Setting
  `RAYSPEC_ANTHROPIC_REUSE_LOGIN=true` lets the Anthropic subscription backend boot
  with **no `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` in the server environment**,
  reusing a `claude` login the operator has seeded into the per-tenant config directory
  under `RAYSPEC_ANTHROPIC_CONFIG_ROOT` (still required). A loud boot banner announces
  the mode. Honest caveats: the boot cannot verify any per-tenant directory is actually
  seeded, so an unseeded tenant boots clean and fails only at first run; seeding the
  login is a manual operator step; and if a token or key is *also* present in the
  environment it wins over the seeded login (the boot warns). Without the flag, boot
  behaviour is byte-identical (fail-closed when no credential is present). Documented in
  `docs/concepts.md` and `.env.example`.

### Fixed

- **Store `enum` whitelists are now enforced on the low-level escape-hatch handler
  write path too.** A `text` column's declared `enum` whitelist was already enforced on
  the HTTP `create`/`update` route and the workflow `store.write` value path, but a
  custom handler writing directly through the `HandlerDb` facade was not checked. It is
  now rejected fail-closed against a table-identity whitelist registry (a non-member
  value — including a non-string scalar — is refused; the failure names the store and
  column only, never the offending value), so all three write surfaces agree. This
  **closes the "the facade is not enum-checked" residual noted in `1.3.1`**.
- **Every sealed track of a multi-track audio session is transcribed.** The
  session-finalized event fires as soon as one track seals, but a sibling track could
  still be uploading at that instant; the transcribe node re-read only the completed
  tracks and finished, permanently dropping any track that sealed afterward. The
  durable transcribe node now waits (bounded, with real retry backoff) for all tracks
  to seal before transcribing, so every sealed track is transcribed under a staggered
  or concurrent finalize. The finalize emit stays unconditional, so a session-scoped
  idempotency key still deduplicates to exactly one durable run (never zero). Honest
  bound: once the wait elapses the run proceeds with whatever sealed and logs loudly, so
  an abandoned upload can never stall the run forever.
- **The migration generator emits foreign keys after the tables they reference.** A
  store that referenced a later-declared store emitted its `REFERENCES <parent>` before
  that parent's `CREATE TABLE`, failing at apply (`42P01 relation does not exist`) while
  `doctor`/`plan` still reported ok. A stable topological sort now orders every
  `CREATE TABLE` ahead of the foreign keys that reference it (an already-ordered spec
  stays byte-identical, so committed goldens are unchanged). A genuine foreign-key
  **cycle** is now a blocking `fk_cycle` error at `doctor`/`plan` time (rather than a
  throw at apply); a merely out-of-order forward reference is a non-blocking
  `fk_forward_reference` advisory.
- **An unsatisfiable `Range` on a static `frontend` mount now returns `416`.** The
  underlying static server mishandled an unsatisfiable byte range — a closed range
  beyond end-of-file yielded a malformed 0-byte `206`, and an open one surfaced as a
  `500`. An additive guard now returns RFC-7233 **`416`** with
  `Content-Range: bytes */<size>` for an unsatisfiable range (a start at/after EOF —
  open or closed — or a reversed range), under `GET` and every write verb. `HEAD`/
  `OPTIONS` stay `200` full-size (never `416`), every satisfiable/clamped `206` is
  unchanged, and the fail-closed dotfile/traversal/symlink guard still returns `404`
  under a `Range` request. This **corrects the `1.3.1` note** that said an unsatisfiable
  range returns `500`.
- **API-key minting is exactly-once under a concurrent `Idempotency-Key`.** The mint
  applied idempotency as a non-atomic find-then-act, so two concurrent requests with the
  same key could each mint a distinct usable key with the loser's key left stranded
  (usable but never replayable). The mint is now retrofitted onto the atomic
  reserve-before-execute primitive: a loser replays the winner's key (`200`) or gets a
  `409` while the mint is in progress, and exactly one key is ever minted. The
  no-idempotency-key path is behaviourally unchanged, and the plaintext secret is still
  never stored (the kill-trigger closure is preserved). Honest residual (documented in
  code): exactly-once except a rare ambiguous mint-commit window.
- **A user-dismissed collection row is preserved across a rebuild.** The collections
  materializer re-stamped `dismissed: false` on every rebuild, so re-extracting (or a
  reprocess) would resurrect a user-dismissed artifact. A dismissed row is now spared
  unconditionally — reconciliation never deletes it and the upsert loop skips it —
  mirroring the existing human-edit preservation, independent of `preserve_human_edits`.
- **An extension-pack agent that selects a backend no base agent uses now boots.** The
  env-driven backend factory derived its backend set from the pre-merge base document,
  so a backend introduced only by a pack agent was never built and the boot failed
  closed on it — including a backend spec whose *only* agents come from a pack (zero base
  `agents:`). The composition root now builds any backend a merged agent selects (via the
  same fail-closed path), while a base-only deploy stays byte-identical.

### Security

- **The API error envelope strips `details` structurally for non-input-echo codes.**
  The "a bare `401`/`404` leaks no details" invariant moved from a per-call-site
  convention to a structural guard at the single envelope chokepoint every non-2xx
  response flows through: an allowlist keeps `details` only for the codes whose details
  echo caller-supplied context (`VALIDATION_ERROR`, `FORBIDDEN`, `RATE_LIMITED`,
  `GATEWAY_TIMEOUT`) and drops it for every other code regardless of what a caller
  passes. Behaviour-preserving — no code outside the allowlist carries a `details`
  payload today, so no current response changes — but the guarantee is now enforced by
  construction rather than by convention.

### Documentation

- Updated the spec reference, concepts, and the authoring skill for the `readonly`
  route-handler flag, the session reprocess endpoint, the all-three-surfaces `enum`
  enforcement (the `1.3.1` handler-facade residual is closed), the static-mount `416`
  correction (superseding the `1.3.1` "returns `500`" note), and the
  `RAYSPEC_ANTHROPIC_REUSE_LOGIN` reuse-login option.

## [1.3.1] - 2026-07-13

### Added

- **Opt-in soft delete for a store.** A store may now declare `softDelete: true`.
  When it does, a `delete` stamps the injected `deleted_at` tombstone (through the
  tenant-scoped update chokepoint) instead of physically removing the row, and every
  read/write hides tombstoned rows — so a soft-deleted row is uniformly invisible:
  `get` → `404`, `list` omits it, a second `delete` → `404`, `update`/`PATCH` →
  `404`. Tombstone-hiding is enforced on the richer read/write surface too
  (declarative views, workflow `store_read`/`store_write`, and tool/route/trigger
  handlers), not just the CRUD routes. Without the field the default is unchanged —
  a `delete` is a hard physical delete with no `deleted_at` filtering. Documented
  caveat: because a tombstoned row physically persists (holding its column values),
  a `unique` value from a soft-deleted row still occupies the tenant-scoped unique
  index, so re-creating that same value returns `409 CONFLICT` rather than reusing it.
- **Server-enforced `enum` whitelists on a text column.** A `text` column may declare
  an `enum` list of allowed values, and the platform now enforces it server-side: an
  out-of-whitelist value on a `create`/`update` store route is a `400 VALIDATION_ERROR`
  (a `z.enum` derived at the write chokepoint), and the same whitelist is enforced on
  the workflow `store.write` value path. `enum` is valid only on a `text` column and
  its members must be distinct (rejected at validation otherwise). Honest residual: a
  custom escape-hatch handler that writes directly through the `HandlerDb` facade is
  not enum-checked — a handler author owns its own value discipline.
- **Foreign keys to a `unique` parent column (`referencesColumn`).** A store
  foreign key may set `referencesColumn` to target a `unique: true` column of the
  parent store instead of its injected `id`. It materializes as a **tenant-scoped
  compound** foreign key — `(tenant_id, <col>) REFERENCES parent(tenant_id, <refcol>)`
  — which structurally forbids a cross-tenant reference. A `create`/`update` naming a
  non-existent parent value returns `400`; a `restrict`-blocked parent delete returns
  `409` (both tenant-safe — the `400` names only the local column, the `409` names no
  relationship at all, never a foreign value). The
  local column's type must match the referenced column's, the referenced column must
  be `unique: true`, and `onDelete: 'set null'` is rejected (a compound FK cannot null
  `tenant_id`). The id-target FK path is unchanged.
- **A set (`IN`) filter on the declarative `list` op.** A `list` route now accepts a
  per-column set filter `?<col>__in=v1,v2,…` that maps to SQL `IN`, so a "status is
  open OR in_progress" read is expressible in one query. The distinct `__in` suffix
  keeps plain `?<col>=v` equality byte-identical and unambiguous on a comma-bearing
  value (a real column literally named `<x>__in` still routes as plain equality). It
  folds into the same AND-chain as equality filters, keyset pagination, and the tenant
  predicate. Fail-closed: an empty/blank element, an oversized set (> 100 values), a
  non-filterable (`jsonb`) column, or an unknown prefix column each return `400`.
- **`rayspec deploy --apply-migration <delta.sql>`.** `deploy` can now apply a reviewed
  forward migration in place, reaching the existing gated migration engine — an
  operator with a brownfield schema change no longer has to drop to the dev harness.
  `--allowlist <file.json>` supplies the reviewed cover for a destructive statement (a
  destructive statement without a covering entry is still blocked by the deploy gate);
  both paths are jailed through the same path check as the spec. It is **reboot-safe**:
  the boot classifies the live schema first and mounts a present-matching schema
  instead of re-applying a non-idempotent delta, so leaving the flag in a
  process-managed unit applies once and mounts thereafter. `--dry-run` rejects the flag
  (it touches no database), and a bare `--allowlist` (without `--apply-migration`) is
  refused. Reachable from both profiles.

### Fixed

- **An agent-free spec boots and updates with no provider key.** The local dev-boot
  wrapper hard-required `OPENAI_API_KEY` up front (an unconditional check before the
  spec was parsed, plus an always-on OpenAI factory), so applying an additive delta to
  an agent-free spec failed closed on a credential it never uses. The wrapper now
  routes through the shipped `assembleOptsFromEnv`, which returns an agent-backends
  factory only when the spec declares at least one agent — so a stores/api-only backend
  (or a product-profile document) boots and updates with no provider key, while an
  agent-bearing spec still fail-closes naming the missing per-agent credential.

### Documentation

- **Corrected the "deploy applies the migration" overstatement to the mount-only
  truth.** `rayspec deploy`/`rayspec-serve` materializes a store on a clean database
  and mounts a present-matching one, but against an existing deployment it is
  mount-only: it **fail-closes on a drifted schema** rather than altering it on its
  own. A schema change is applied by the explicit `rayspec deploy --apply-migration
  <delta.sql>` (with `--allowlist` for a reviewed destructive statement). The
  diff/gate and from-clean-database guarantees are unchanged. Corrected across
  getting-started, the CLI reference, concepts, ARCHITECTURE, and the README.
- **New "Restore and key rotation" operational note** (ARCHITECTURE → security model):
  a restored database dump survives whole at the row level — orgs, users, the argon2id
  password hashes, and all tenant data come back reachable. The only thing a
  **freshly-minted** `RAYSPEC_API_KEY_PEPPER` breaks is the set of *copied API keys*:
  their stored HMACs no longer match, so they return `401` — mint new ones. User
  passwords are argon2id (pepper-independent), so an org owner just logs in again and a
  fresh JWT under the current signing key reaches the data. (The JWT signing key is the
  same class and self-heals on that same re-login; an org whose sole credential was an
  API key needs a fresh key established out of band.)
- **Documented the new store features** in the spec reference (`enum`, `softDelete`,
  `referencesColumn`, and the `<col>__in` set filter), and pinned **Range and HEAD on
  a static `frontend` mount** as a supported feature with tests (byte-range `206` /
  `HEAD` `200`). Honest edge: an unsatisfiable range currently returns `500` — the
  underlying static server (`@hono/node-server` `serveStatic`) has no RFC-7233 `416`
  path.

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

[1.3.2]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.3.2
[1.3.1]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.3.1
[1.3.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.3.0
[1.2.2]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.2.2
[1.2.1]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.2.1
[1.2.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.2.0
[1.1.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.1.0
[1.0.0]: https://github.com/rayspec-labs/rayspec/releases/tag/v1.0.0
