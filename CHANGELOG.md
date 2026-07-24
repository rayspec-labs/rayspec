# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Static frontends can ship a custom `404.html`.** When a request to a mounted
  static frontend misses (no file, no `dir/index.html`, and no SPA fallback), and the
  mount's root contains a `404.html` file, the response is that file's contents with
  HTTP status 404 (`Content-Type: text/html`) — the GitHub Pages / Netlify /
  Cloudflare Pages convention. Backward compatible for a deployment that does not
  already ship a root `404.html`: without the file, behavior is unchanged (the
  platform's uniform 404). A deployment whose static root already contains a `404.html`
  (or a nested mount that ships one) will begin serving it (status 404) on a miss —
  the convention. The custom page is served only on a genuine content miss: reserved
  platform prefixes (`/v1`, `/health`, `/oidc`) and refused paths (traversal,
  dotfiles, symlink escapes) keep the uniform 404, and a `HEAD`/`OPTIONS` miss returns
  the 404 metadata without a body. On an `spa:true` mount the SPA `index.html` fallback
  still wins, so the custom page is a plain-mount not-found surface.

## [1.6.1] - 2026-07-22

### Fixed

- **`@rayspec/db` ships its migration chain in the npm tarball.** The package
  declared `files: ["dist"]`, which excluded the committed `drizzle/` platform
  migration chain (`meta/_journal.json` and `0000..0008_*.sql`) from the
  published tarball. A backend booted from the npm packages therefore failed at
  startup in `applyMigrations()` — `migrationsDir()` resolves to `<pkg>/drizzle`,
  absent in the installed package — before reaching the database. Adding
  `drizzle` to `files` ships the chain, so an npm-consumed boot applies its
  migrations. No API or runtime code changed.

## [1.6.0] - 2026-07-22

### Added

- **Boot secrets can be read from a file mount.** Each of the three boot
  secrets — `DATABASE_URL`, `RAYSPEC_JWT_SIGNING_KEY`, and
  `RAYSPEC_API_KEY_PEPPER` — now also accepts a `<VAR>_FILE` variant
  (`DATABASE_URL_FILE`, `RAYSPEC_JWT_SIGNING_KEY_FILE`,
  `RAYSPEC_API_KEY_PEPPER_FILE`) naming a file to read the value from, so a
  mounted secret (mode `600`) stays out of the container's declared environment
  (`docker inspect`) and out of the process's own environment. Precedence is
  unambiguous and fail-closed: a set `<VAR>_FILE` wins outright (the plain
  variable is not consulted); a blank `<VAR>_FILE` counts as not set (the plain
  variable is used); and a non-blank `<VAR>_FILE` pointing at a missing,
  unreadable, or empty file **aborts the boot** rather than silently downgrading
  to the plain variable. Documented in the CLI reference and `.env.example`.
- **A frontend-only spec boots as a static profile — no database, no auth
  surface.** A backend-profile document that declares only a `frontend` (empty
  `stores`, `api`, `agents`, `tooling`, `triggers`, `handlers`, and
  `extensions`, and no durable worker) now boots with **no** `DATABASE_URL`, JWT
  signing key, or API-key pepper, and mounts **no** auth / OIDC / run route — the
  database-and-auth composition is never reached (not merely left empty).
  `/health` is liveness-only (`200 {"status":"ok"}`, no database probe). The two
  response security headers a reverse proxy would otherwise supply —
  `Content-Security-Policy` and `Permissions-Policy` — are read from the
  environment (`RAYSPEC_FRONTEND_CSP` and `RAYSPEC_PERMISSIONS_POLICY`), each with
  a secure default when unset, so the app can serve a static UI directly with no
  proxy in front. This is distinct from serving a static `frontend` **alongside**
  a full API, which is unchanged.
- **Inline and hash-pinned extraction prompts.** A product-profile `extractors[]`
  entry may now carry its extraction system prompt inline as an `instructions`
  block scalar, or pin an external prompt file by hash with
  `instructions_ref: { file, sha256 }` — the file is read spec-relative
  (traversal-jailed) and **sha256-verified at boot**, fail-closed on a missing
  file or a hash mismatch. Exactly one prompt source is allowed (inline
  `instructions`, a pinned `instructions_ref`, or the existing sidecar
  `prompt_file`); declaring more than one fails closed. The no-code guardrail is
  **narrowed, not removed**: free-form prompt text is admitted only at the
  designated `instructions` field, and everywhere else — including `purpose`,
  `extraction_constraints`, and the still-banned `prompt` / `system_prompt` keys —
  the guardrail stays fail-closed.

### Changed

- **`rayspec plan`'s read-only shadow guard resolves its target from
  `DATABASE_URL_FILE` too.** The guard that refuses to shadow-apply when
  `SHADOW_DATABASE_URL` resolves to the same host and database as the real
  `DATABASE_URL` now resolves that comparison target from a `DATABASE_URL_FILE`
  file mount as well (with precedence over the plain variable), so it still fires
  when the connection string is supplied only through the mount. Because `plan`
  is read-only and never connects to the real database, a broken mount is **not**
  fatal here (unlike a server boot): it emits one stderr warning — naming the
  variable, the path, and the OS error code, never the file content — and
  proceeds with no comparison target rather than falling back to a possibly-stale
  plain `DATABASE_URL`.

### Security

- **Dependency advisories patched.** Six advisories are resolved by upgrade
  (across `hono`, `brace-expansion`, `fast-uri`, and `protobufjs` — direct
  dependencies and their transitive copies), and the dependency SBOM is
  refreshed. One remaining advisory — a Windows-only `@hono/node-server`
  `serve-static` path traversal, reached only transitively (the fixed 2.x line is
  used directly; the older copy is pulled in solely for a child-process JSON-RPC
  transport, never for static file serving) and not exercised on this project's
  Linux code paths — is **not** silently ignored: it is a single, tightly scoped,
  documented suppression in the vulnerability-scan allowlist, so a new advisory on
  any other package still fails the dependency audit.

## [1.5.1] - 2026-07-19

### Documentation

- Add a per-package `README.md` to the 22 published packages that shipped without one, so
  every package page on npm renders a purpose description, quickstart pointers, and the
  license summary. Docs-only release: no runtime, API, or dependency changes.

## [1.5.0] - 2026-07-18

### Added

- **RaySpec is installable from npm.** `npx rayspec init` scaffolds a new project (a
  minimal, valid backend spec you can `rayspec plan` and deploy without provider
  credentials), and `npm i -g rayspec` puts the `rayspec` command on your PATH — no
  clone-and-build required. The scoped `@rayspec/*` packages are published alongside the
  unscoped `rayspec` launcher.
- **Declarative full-text search.** A store can opt into Postgres full-text search with
  `fullTextSearch: true`: the store gains a generated `tsvector` column over its text
  columns, a GIN index, and a ranked `__search` query that orders results by relevance.
  Stores that do not opt in keep the existing substring search unchanged.
- **Out-of-band organization invites.** Invite a member by email with a single-use,
  expiring, organization-scoped invite token; the invitee redeems it to join (setting
  their own password for a new account, or authenticating as an existing one). This
  closes the account-existence signal the direct member-add response carried.
- **Read-only, path-jailed file source.** A new `fs_source` capability gives handlers a
  deployer-configured, read-only reader over local files, contained by a symlink-safe
  path jail (no traversal or absolute-path escape).
- **Cron catch-up.** A cron trigger can opt into missed-interval catch-up with
  `catchUp: true`: on startup the worker replays each interval it missed while it was
  down (bounded look-back). Default behaviour is unchanged (no catch-up).
- **Manual trigger firing.** Fire a manual trigger on demand through an auth-guarded,
  rate-limited, tenant-scoped control route (`POST /v1/triggers/:name/fire`).
- **Live-executor readiness probe.** A public `GET /recovery-scope` route reports the
  live durable-executor identity (`{ executorId, applicationVersion }`), failing closed
  (503) until the engine has finished launching.

### Changed

- **Handler and extension-pack modules load compiled JavaScript in production.** The
  production loader accepts only compiled `.js` modules (a deterministic, Node-version-
  independent boundary); a raw `.ts` module is refused fail-closed. The shipped example
  backends now include a build step, and the docs state the `.js`-only contract.
- **Durable cron exactly-once is hardened.** The run-level exactly-once guard on the
  durable cron path is strengthened, with a test that asserts the durable invariant
  directly rather than counting raw invocations.
- **A first upload can no longer reset a sealed row.** A conditional upsert closes the
  race where a first upload could reset an already-sealed row.

### Fixed

- **`rayspec plan` fails on a boot-fatal document.** A document whose stores cannot be
  derived now returns a non-ok plan verdict instead of reporting `ok: true` and crashing
  at boot.

### Documentation

- **Tenant-table registration guidance corrected.** The engine `deploy()` and the
  server composition root now describe the real mechanism — a product table joins the
  deny-by-default chokepoint set at boot through the sanctioned registration hook, and
  `deploy()` verifies rather than registers — replacing an out-of-date committed-source
  description.

## [1.4.1] - 2026-07-17

### Security

- **The per-tenant Anthropic credential directory is hardened further.** The
  directory is now created in a single atomic step (create-or-validate, with no
  check-then-create window), the credential root's ownership and permissions are
  asserted at startup, and the tenant identifier is validated — an empty, absolute,
  separator-, traversal-, or NUL-bearing value is rejected — before it is ever used
  to build a path. This builds on the mode-`0700` and containment checks from the
  previous release.
- **All static-analysis findings are resolved.** The code-, path-, and label-parsing
  and file-I/O findings surfaced by static analysis are fixed, or dismissed with a
  documented rationale, leaving zero open alerts.
- **CI supply-chain integrity is tightened further.** Container images used in CI
  are pinned by content digest, and repository secret-scanning with push-protection
  is enabled.

### Changed

- **Clearer startup and developer diagnostics.** Boot now emits a progress line
  before the ready banner and fails with an explicit timeout message if it stalls; a
  failed development-database connection reports its underlying cause; and a second
  local instance can run alongside the first through container, volume, and port
  overrides. The getting-started guide is polished to match.
- **Source comments and test descriptions are rewritten in self-carrying product
  language**, and the repository check that keeps the shipped source product-neutral
  is stricter. These are non-functional text and tooling changes; runtime behaviour
  is unchanged.

### Documentation

- **The v1 posture now states its honest edges.** A new "what v1 does not do yet"
  section documents that request cancellation is bounded to the request rather than
  propagated into in-flight work, that the hard-delete purge is operator-gated and
  off by default, and that the federation and residency columns are shape-only with
  enforcement deferred to the separate hardening layer.

## [1.4.0] - 2026-07-16

### Security

- **The local server now binds to loopback (`127.0.0.1`) by default.** A freshly
  started instance no longer listens on all network interfaces; it is not reachable
  from the network until a host is explicitly configured, closing an
  accidental-exposure default.
- **Request bodies are size-bounded on every ingress path.** Both the JSON and the
  audio-upload routes now reject an oversized payload before it is buffered, bounding
  the memory a single request can consume.
- **Rate-limit identity is derived from a trusted peer, and the limiter store is
  bounded.** A spoofed client identifier can no longer evade the limit, and the
  limiter's memory footprint is capped so a flood of distinct identifiers cannot grow
  it without bound.
- **The session-reprocess affordance is now rate-limited and recorded**, so repeated
  reprocessing of a session is bounded and observable.
- **An incoming `x-request-id` is constrained to a short, printable allow-list**
  before it is echoed or logged, so an untrusted header value cannot inject control
  characters downstream.
- **A declared `quote_field` that carries no quote is now rejected** under the
  unquoted-claim policy, rather than being silently accepted as an unquoted claim.
- **The per-tenant Anthropic credential directory is hardened against loose or hostile
  paths.** It is created with mode `0700`; a resolved path that is not a direct child
  of the configured root, an existing symlink or non-directory, or a group- or
  world-accessible directory is refused at startup (fail-closed), with containment
  re-checked against the real path. The adapter's interface and behaviour are
  otherwise unchanged.
- **Supply-chain integrity of the build is strengthened.** CI actions are pinned to
  verified commit SHAs, the `gitleaks` download is verified against a pinned SHA-256,
  and a CodeQL static-analysis workflow now runs over the codebase.

### Changed

- **The live provider parity smoke suites are now behind an explicit opt-in.** They
  run only when `RAYSPEC_REQUIRE_LIVE_TESTS=true`, with the exercised backends selected
  via `RAYSPEC_LIVE_BACKENDS`; without the opt-in an ordinary test run never reaches a
  live provider or spends against a real credential.
- **Build and gate tooling resolve repository roots portably** and fail closed on an
  empty scan, so a seam gate cannot pass vacuously.

### Fixed

- **An authentication test asserting that a password is never leaked is now
  deterministic**, removing a source of intermittent test failures.

### Upgrade notes

- **Anthropic credential directory permissions — one-time action may be required.**
  Anthropic credential directories are now created with mode `0700`, and the adapter
  refuses to start when a credential directory is group- or world-accessible. If you
  upgrade an existing installation whose credential directory still exists with `0755`
  (or any group/other permissions), run `chmod 0700` on that directory once after
  upgrading — otherwise the Anthropic adapter will not start.

Minor hardening follow-ups are tracked for v1.4.1.

## [1.3.3] - 2026-07-16

### Added

- **Persist a validated agent output to a store (`persistTo`).** An agent action —
  on both an api route and a trigger — may now declare `persistTo: <store>`. On a
  successful run the validated `outputSchema` output is written as one row into that
  store, exactly once, atomically with the run header's completing transition, across
  both the synchronous (in-request) and durable (off-request / recovery) execution
  paths. Safety is enforced at **deploy**, not runtime: the doctor validates the
  mapping in both directions and fails closed at boot on any mismatch — forward
  (every output property maps to a writable business column of a compatible type) and
  reverse (every NOT-NULL, no-default business column is reliably produced by a
  present, required, non-nullable output property; where a column and its mapped
  property both declare an `enum`, the property's enum must be a subset of the
  column's whitelist).
- **Declarative record-input normalization (`input_normalize`).** The `record_input`
  capability accepts an optional `input_normalize: { agent, output_contract }` that
  runs a declared agent over a submitted record before it is persisted: the record is
  transformed, re-validated, then stored — the stored and emitted value is the
  normalized one. It runs synchronously through the neutral agent path; a failure is
  fail-closed (nothing is persisted) and never leaks raw provider or database text to
  the client. It is idempotent, keyed on the canonical payload hash, so a retry
  converges while a corrected resubmission re-normalizes. It is wired via a
  `record/<agent>.normalizer.json` config (path-jailed and validated); declaring it
  without a wired normalizer fails closed at deploy. A record capability without it is
  byte-identical to before.
- **Server-side substring search on `list` routes (`?search=` / `?<col>__contains=`).**
  The declarative `list` op gains an opt-in, additive, keyset-stable search:
  `?search=<term>` is a case-insensitive `OR` match across the store's declared text
  columns, and `?<column>__contains=<term>` matches one declared text column. User
  terms are bound parameters with the `LIKE` wildcards `%` and `_` escaped (`ESCAPE`),
  so they match literally rather than as wildcards. Search folds into the same
  AND-chain as the equality and set filters and composes with ordering and the keyset
  cursor. `search` is a reserved query word — a store that declares a column named
  `search` fails lint.
- **`created_by` on escape-hatch handler inserts.** A handler-managed store insert now
  stamps the injected `created_by` column from the authenticated caller
  (server-derived and un-spoofable), matching the declarative `store` create path. A
  posture with no request principal is unaffected.

### Changed

- **Handler-facade input-validation rejections now return `400`** (previously `500`).
  An unknown column, a server-controlled column, an `enum`-whitelist violation, an
  injection attempt, an invalid timestamp, or a negative pagination value now surface
  as a typed `400` error rather than an internal `500`. The client-facing message
  stays generic and no internal detail ever leaves the server.
- **A spec-vs-spec plan no longer emits phantom platform-column deltas.** Running
  `rayspec plan <spec> --against <copy>` on two identical specs now produces no diff.
  The real-database injected-column reconcile stays reachable behind a new opt-in
  `--reconcile-injected-columns` flag (an update-mode flag that requires `--against`).
- **Opt-in run-journal payload scrub during tenant erasure.** Passing
  `journalScrub: true` to a tenant erasure NULLs the raw journal payload columns while
  keeping the journal rows and their idempotency and cost columns intact — closing the
  content-erasure gap where a per-subject purge left raw payloads behind. The default
  behaviour is byte-identical (no scrub).

### Fixed

- **A journaled error step-row no longer bricks an agent re-run.** The run-journal
  writer now upserts a step on its unique key — replacing an `error` predecessor, but
  never overwriting a successful row — and reconciles the run header to the healed
  terminal outcome without ever downgrading an already-completed run. A re-run of a
  previously-failed step now succeeds, and both run observability and the
  double-charge guard see the true result.

### Documentation

- Documented `persistTo` (agent output persistence) and `input_normalize` (record-input
  normalization) in the spec reference and the authoring skill, and the new server-side
  substring search (`?search=` / `?<column>__contains=`) under the `list`-route query
  surface — correcting the earlier "no `LIKE`/full-text operators" note.

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
  reserve-before-execute primitive: a concurrent loser replays the winner's **redacted**
  mint metadata (`200`, plaintext omitted — a caller that lost the original `201` must
  mint a new key) or gets a `409` while the mint is in progress, and exactly one key is
  ever minted. The
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
