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

- **Node** `>=22`.
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
`pnpm build`, `pnpm test`, and `pnpm gate` before it is proposed.

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
dependency.

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

---

## Developer Certificate of Origin (sign-off)

Contributions require a **Developer Certificate of Origin** sign-off. By signing
off you certify that you wrote the contribution (or have the right to submit it)
under the project's license. Add a `Signed-off-by` line to each commit:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you.

## License

RaySpec is source-available under the **Functional Source License
(FSL-1.1-ALv2)** — see [`LICENSE`](./LICENSE). By contributing, you agree that
your contribution is licensed under those same terms. Third-party dependency
attributions are recorded in [`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md).
