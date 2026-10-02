# Contributing to RaySpec

Thanks for your interest in improving RaySpec. This guide covers the toolchain,
the local workflow, the standards a change is held to, and the licensing terms
your contribution is made under.

Before changing anything substantial, read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
(the design and package taxonomy) and [`docs/concepts.md`](./docs/concepts.md)
(the vocabulary). The most valuable contributions respect the platform's core
invariant: **no product-specific code lives in the platform** — everything
product-specific arrives as the spec a deployer injects.

---

## Toolchain

RaySpec is a TypeScript/Node monorepo managed with pnpm and Turborepo.

- **Node** `>=22.21.0`. CI runs one exact patch of the 22 line, pinned in
  `.github/workflows/ci.yml`; the floor is the first 22 release that implements
  `NODE_USE_ENV_PROXY`, which the server's proxy handling relies on.
- **pnpm** `10.12.4` — pinned via `packageManager` in `package.json`. Use
  [Corepack](https://nodejs.org/api/corepack.html) (`corepack enable`) so your
  pnpm matches the pin exactly.
- **Turborepo** — orchestrates the per-package `build` / `test` / `typecheck`
  tasks across the workspace.
- **Biome** — formatting and linting (one tool for both).
- **Vitest** — the test runner.

## Local setup

```bash
git clone <this-repo> rayspec && cd rayspec
pnpm install          # installs from the frozen lockfile
pnpm build            # builds every package
pnpm db:up            # a local Postgres for the database-backed tests
```

## The core commands

Run these from the repo root:

| Command          | What it does                                                    |
| ---------------- | --------------------------------------------------------------- |
| `pnpm build`     | Builds all packages via Turborepo.                              |
| `pnpm typecheck` | Type-checks all packages (`tsc`).                               |
| `pnpm lint`      | Runs Biome's format + lint check over the tree.                 |
| `pnpm lint:fix`  | Applies Biome's safe fixes.                                     |
| `pnpm test`      | Runs the full Vitest suite across packages.                     |
| `pnpm gate`      | Runs the platform structural-invariant checks (see below).      |

Some tests are database-backed and need a reachable Postgres (`pnpm db:up`
provides one). A change should be green on `pnpm typecheck`, `pnpm lint`,
`pnpm build`, `pnpm test`, and `pnpm gate` before it is proposed. What a run
that leaves nothing out needs is under [A complete local test run](#a-complete-local-test-run).

### The structural gate

`pnpm gate` runs the platform's structural-invariant checks — automated guards
that fail the build when a change would violate one of the load-bearing
architectural rules (for example, weakening the tenant chokepoint, or letting an
adapter reach past the neutral boundary). Treat a gate failure as a real defect
in the change, not as a check to route around: the gates encode the guarantees
the [security model](./docs/ARCHITECTURE.md#security-model) depends on.

## The monorepo layout

The workspace is organized into dependency tiers under `packages/` — kernel,
adapters, capabilities, workflow, compose, app, and test. Each tier depends only
downward. See the **package taxonomy** in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md#package-taxonomy) for what lives
where; put new code in the lowest tier that fits, and never introduce an upward
dependency. `pnpm gate:tier-direction` (part of `pnpm gate`) fails on one.

---

## Proposing a change

1. **Open an issue first** for anything non-trivial, so the approach can be
   discussed before you invest in an implementation.
2. **Branch** from the default branch and keep the change focused — one logical
   change per pull request.
3. **Keep it green.** Run the core commands above locally. If you add or adjust a
   dependency, update the lockfile and confirm `pnpm install --frozen-lockfile`
   still passes.
4. **Write tests that would fail without your change.** A test that passes
   whether or not the code is correct proves nothing; assert the real behavior.
   New behavior needs coverage; a bug fix needs a regression test.
5. **Update the docs** when you change an observable behavior, a CLI flag, or the
   grammar.
6. **Open a pull request** describing what changed and why, and how you verified
   it.

## Coding standards

- **Formatting and linting are Biome-enforced.** Run `pnpm lint` (or
  `pnpm lint:fix`) before pushing; a red Biome check blocks a change.
- **Fail closed.** New parsing/validation surfaces reject the unknown rather than
  ignoring it — matching the strict, fail-closed posture of the existing grammar.
- **Respect the neutral boundary.** Backend-specific behavior belongs inside an
  adapter; the neutral types must not move to accommodate one SDK's shape.
- **New stores/tables must be registered as committed source.** The tenant
  chokepoint is deny-by-default: a tenant-scoped table is reachable only if it is
  registered as committed source, and the deploy step *verifies* this rather than
  registering it on the fly. If your change adds a tenant-scoped table, register
  it in committed source — otherwise a deploy that declares it will fail closed,
  by design. A new predicate-exempt (genuinely global) table is a deliberate,
  reviewed exception, not a default.

## Tests

- Use Vitest. Run `pnpm test` for the whole suite, or `pnpm --filter <package>
  test` for one package.
- Database-backed tests require Postgres. They must not silently no-op when a
  database is absent in an environment that expects one — a security-relevant test
  that skips itself is a false green.
- Make that a hard failure while you work, rather than trusting a green run.
  `RAYSPEC_REQUIRE_DB_TESTS=true` turns a database-backed suite that finds no
  `DATABASE_URL` into a collection-time failure instead of a skip, and
  `RAYSPEC_REQUIRE_MEDIA_TESTS=true` does the same for the ffmpeg-backed suites. CI needs
  neither — a run with `CI=true` already requires the database-backed ones.
- `RAYSPEC_REQUIRE_LIVE_TESTS=true` is the opt-in the cross-backend parity smoke requires
  before any live call: without it every live block there self-skips, whatever credentials
  are around. It does not reach the other provider-backed tests. The server intake smokes
  run whenever `DATABASE_URL` and `OPENAI_API_KEY` are both present, and the Deepgram live
  test whenever `DEEPGRAM_API_KEY` is; both packages load the repo-root `.env` themselves,
  so a filled-in `.env` alone is enough for those to call a real provider and spend. What
  the opt-in adds for them is a collection-time failure when their credential is absent,
  instead of a skip.
- For the parity smoke the opt-in is weaker than the two gates above: it fails only when
  **no** provider credential at all is present, so a box holding one is green with the
  blocks whose credential is absent skipped. `RAYSPEC_LIVE_BACKENDS` is what closes that
  gap — a comma-separated list drawn from `openai`, `pi`, `anthropic` and `codex`, naming
  the backends the run must exercise. Any name in it whose credential is absent, and any
  name outside those four, fails collection rather than skipping. `openai` and `pi` both
  run on `OPENAI_API_KEY`, `anthropic` on `CLAUDE_CODE_OAUTH_TOKEN`, and `codex` on
  `~/.codex/auth.json`. CI's live lane sets both variables and names its backends
  explicitly.
- A live run also fails collection when `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`
  are **both** present. The Anthropic SDK credential precedence is `ANTHROPIC_API_KEY` >
  `CLAUDE_CODE_OAUTH_TOKEN`, so the anthropic blocks would authenticate as `api-key` and
  bill the API instead of using the subscription harness — and the `authMode` assertion
  that catches it runs only once the call has been paid for. Unset `ANTHROPIC_API_KEY` for
  the run. Like the two refusals above it fails the live smoke file as a whole, so it stops
  the `openai`/`pi`/`codex` blocks with it; with the subscription token absent the anthropic
  blocks self-skip and nothing can be billed, so a lone stray key is not refused. CI's live
  lane sets no `ANTHROPIC_API_KEY`, which is why the refusal is inert there.
- For a run where nothing skips for want of configuration, put those variables and
  `DATABASE_URL`/`SHADOW_DATABASE_URL` in the **environment** rather than only in a
  `.env` file. `pnpm test` drives the suites through turbo in strict env mode, so a
  task sees only the variables `turbo.json` declares for it; most database-backed
  packages additionally load a repo-root `.env` themselves, but `@rayspec/cli` and the
  local-boot wrapper do not — so a `.env` alone leaves those two skipping while the
  rest run. The live parity blocks are the exception no variable covers: each needs its
  own backend's credential, so a box holding some of the four still skips the rest.
  `RAYSPEC_LIVE_BACKENDS` makes that a named failure instead of a green run; it does not
  supply the missing credential.

### A complete local test run

A fresh clone with no `.env` and no secrets exported runs the whole suite and the
structural gate. It needs:

- **Node** `>=22.21.0` and **pnpm** `10.12.4` (see [Toolchain](#toolchain)).
- **Docker with Compose v2** for `pnpm db:up`. It starts Postgres 16 on
  `localhost:5433`, pinned by digest to the image CI uses, and creates the `rayspec`
  and `rayspec_shadow` databases. Nothing else may be listening on that port, or set
  `RAYSPEC_PG_PORT` and adjust the URLs below.
- **The two database URLs and the require flag in the environment**, because turbo
  passes a test task only the variables `turbo.json` declares and `@rayspec/cli` and
  the local-boot wrapper read no `.env`:

  ```bash
  pnpm install --frozen-lockfile
  pnpm build
  pnpm typecheck
  pnpm lint
  pnpm db:up
  export RAYSPEC_REQUIRE_DB_TESTS=true
  export DATABASE_URL=postgres://rayspec:rayspec@localhost:5433/rayspec
  export SHADOW_DATABASE_URL=postgres://rayspec:rayspec@localhost:5433/rayspec_shadow
  pnpm test
  pnpm gate
  pnpm db:down
  ```

- **No boot secrets.** The tests that boot a server generate a throwaway
  `RAYSPEC_JWT_SIGNING_KEY` and `RAYSPEC_API_KEY_PEPPER` themselves. The one that
  spawns an example's `dev-boot.mjs` passes an exported value through (CI exports
  both) and generates only what is missing.
- **`pg_dump` and `pg_restore` of the server's major (16)** for the snapshot suite of
  `@rayspec/server` and the export suite of `@rayspec/cli`. They use the host's when their
  major matches; otherwise they run both from the pinned `postgres` image of
  `docker-compose.yml` through `docker run`, so Docker alone is enough. The export suite hands
  the CLI an executable wrapper around that image as `RAYSPEC_PG_DUMP`;
  `RAYSPEC_TEST_PG_TOOLS=docker` makes it use the image on a host that has the tools too.
- **The `age` command on the `PATH`** (optional): the age encryption suite of `@rayspec/server`
  then also decrypts what it encrypts with the reference implementation; without it that one
  test skips.
- **`ffmpeg` on the `PATH`** for the media suites. Without it they skip; set
  `RAYSPEC_REQUIRE_MEDIA_TESTS=true` to turn that skip into a failure.
- **The runtime-role lane.** CI runs the database-backed suites of `@rayspec/api-auth`,
  `@rayspec/platform`, `@rayspec/workflow-durable`, `@rayspec/durable-dbos`,
  `@rayspec/server` and `@rayspec/cli` a second time with
  `RAYSPEC_TEST_DATABASE_ISOLATION=roles`. The code under test then runs as a runtime
  role (no superuser, no `BYPASSRLS`, owner of nothing) with every tenant table's
  row-level policy enabled and forced: a hand-built test schema is served as a role of
  its own (`testAppDb` in `@rayspec/db/testing`); every server boot is handed role
  separation, migrating as a migration role and serving as a runtime role that the
  shipped setup SQL prepared (`packages/app/server/vitest.setup.ts`); a workflow engine
  launches as the runtime role on a system database the migration role migrated; a CLI
  or server a suite spawns gets both connections (`runtimeRoleEnv`). The suite itself
  keeps its superuser connection for seeding and inspecting. Run one package locally
  with, for example, `RAYSPEC_TEST_DATABASE_ISOLATION=roles pnpm --filter @rayspec/server test`.
  A few suites stay on the superuser in both lanes, each for a stated reason: the
  migration and apply tooling (`plan`, `shadow-apply` and the `.env` loader that feeds
  it, `pack --against`, the apply crash suite), which is the migration role's work, not
  the runtime's; `dev db`, which creates databases, and the example dev-boot shutdown,
  which checks signal handling; and the `@rayspec/db` suites of the chokepoint itself,
  beside which the row-level isolation suite creates its own roles and runs as the
  runtime role in either lane.
- **Time.** The test task runs one package at a time and takes a little over ten
  minutes on a current laptop. `pnpm test` keeps going after a package fails, so the
  summary at the end lists every failed package, and the command still exits
  non-zero.

The provider-backed live tests still skip: they need paid credentials and are
opted into separately, as described above. Leave those credentials unset for a run
that must not spend.

### Reference journeys

`scripts/reference-journeys.mjs` runs [the quickstart](./docs/quickstart.md) and the three
reference applications end to end with the release a consumer installs: it packs the workspace,
installs the tarballs into an empty directory with npm, and drives every step with that `rayspec`,
never the workspace's. Each application goes from source to bundle, is deployed on fresh databases,
written to, updated (one additive release, one destructive release that is refused), exported,
imported into an empty target, written to again, exported and imported into a second target, and
checked there by counts, digests and rows, along with the identity reset an import makes. The
custom-code application also shows the export refusing an extension that provides its own blob
backend. What each journey covers is in the application's README.

```bash
pnpm build
DATABASE_URL=postgres://rayspec:rayspec@localhost:5433/rayspec pnpm test:journeys
pnpm test:journeys --app document-intake   # one journey
```

`DATABASE_URL` names a superuser of a PostgreSQL 16 server: each environment gets databases and
roles of its own, dropped at the end (`SHADOW_DATABASE_URL`, when set, is where schema changes are
planned). The run needs npm and the registry for the dependencies the tarballs do not carry,
`openssl`, and `pg_dump`/`pg_restore` of the server's major on `PATH`, or Docker to run them from
the pinned image. It prints one JSON summary with every check and exits 1 on the first that fails.
On a laptop with a warm npm cache the whole run takes under four minutes.

CI runs it on every pull request and every push to `main`, in the `reference-journeys` job.
`pnpm test:journeys-logic` (lane 1) checks the harness itself without a database.

---

## Certificate of origin

By opening a pull request you certify that you wrote the contribution, or
otherwise have the right to submit it under the project's license.

That certification is what matters, and it comes from submitting the
contribution — a per-commit trailer is **not** required. If you would like to
record it explicitly, `git commit -s` adds a `Signed-off-by` line:

```
Signed-off-by: Your Name <you@example.com>
```

Nothing in CI checks for that line, and the history does not carry it.

## License

RaySpec is source-available under the **Functional Source License
(FSL-1.1-ALv2)** — see [`LICENSE`](./LICENSE). By contributing, you agree that
your contribution is licensed under those same terms. Third-party dependency
attributions are recorded in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
