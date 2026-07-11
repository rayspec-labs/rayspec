# @rayspec/server — LOCAL boot entrypoint + AppDeps composition root

The supported **LOCAL** production-style boot for the RaySpec platform: it reads config from the
environment, fails closed on missing secrets, applies the committed migration chain via the real
programmatic migrator, assembles the full app (auth + OIDC + optional declared product routes), and
serves it on a port.

> **LOCAL / single-node / pre-external-hardening — NOT internet-facing.**
> The external-hardening suite (RLS · KMS-wrapped DEKs · per-tenant sandbox · DPoP) is the gate before any external
> exposure and is **not built yet**. Do not place this server behind a public address. The boot
> prints a loud banner saying the same; see the security model in `docs/ARCHITECTURE.md`.

## Run

```bash
pnpm db:up                                 # Docker Postgres on :5433
pnpm --filter @rayspec/server serve       # tsx src/serve.ts (local dev)
# or the built bin:
pnpm --filter @rayspec/server build
node packages/app/server/dist/serve.js         # the `rayspec-serve` bin
```

A successful boot prints the banner + the routes, then listens on `PORT`. Probe it:

```bash
curl -s http://127.0.0.1:8080/health
# {"status":"ok","db":"ok"}
```

## Environment

| Var | Required | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | **yes** | Postgres connection string. The committed migration chain is applied here at boot (bootstraps a clean DB; idempotent on an up-to-date one). |
| `RAYSPEC_JWT_SIGNING_KEY` | **yes** | RS256 PKCS#8 PEM — the JWT signing key AND the OIDC provider signing key. Secret-manager/env only (never DB/git). |
| `RAYSPEC_API_KEY_PEPPER` | **yes** | The api-key pepper. Secret-manager/env only. |
| `ALLOWED_ORIGINS` | no | Comma-separated cookie-CSRF allow-list. **Unset ⇒ EMPTY (no cross-origin).** NEVER dev-permissive by default. |
| `OIDC_ISSUER` | no | The OIDC issuer (drives emitted URLs). Default `http://127.0.0.1:<port>/oidc`. |
| `PORT` | no | TCP port. Default `8080`. A non-numeric/out-of-range value fails closed. |
| `RAYSPEC_SPEC_PATH` | no | Absolute path to a `rayspec.yaml` to deploy at boot (the declarative engine). The platform ships **none** — the deployer injects it. Absent ⇒ an **auth-only** boot. |
| `RAYSPEC_HANDLER_ROOT` | no | The path-jail root for declared escape-hatch handlers. Defaults to the spec file's directory. |
| `RAYSPEC_SKIP_DOTENV` | no | Set to `1` to skip the local-DX `.env` loader (prove a pure-ambient-env boot). |

Missing `DATABASE_URL` / `RAYSPEC_JWT_SIGNING_KEY` / `RAYSPEC_API_KEY_PEPPER` → the boot aborts
with an actionable message (fail-closed), never a partial start.

## What it is (and is not)

- **Product-free:** the boot names no product table, route, agent, or domain. An auth-only
  boot is the default. If a spec is injected, EVERYTHING product comes from that injected
  `rayspec.yaml` — the platform ships none.
- **The composition root** is the one place a raw `Db` handle is built (`makeDb` on the public
  `@rayspec/db` surface — the production analogue of the test `makeDbWithSchema`). Request/run-core
  code still holds only a `TenantDb` (enforced by `gate:chokepoint`).
- **A spec WITH agents** also needs its backend instances wired (the platform ships none).
  This generic entrypoint ships no backend, so a spec-with-agents boot uses a wrapper that supplies
  an `AgentBackendsFactory` + a `registerProductTables` hook (the local table-registration
  stand-in) — see `examples/local-boot`, the local backend-boot wrapper. An auth-only or
  stores/api/handler-only spec boots here directly.

## Migration application

The boot applies the committed chain (`packages/kernel/db/drizzle/*`) via the real programmatic migrator
(`drizzle-orm/postgres-js/migrator`, `migrate(db, { migrationsFolder })`) — exactly the chain
`drizzle-kit migrate` / the `gate:migrate-clean` forcing-function apply. It
records the high-water mark in `drizzle.__drizzle_migrations` (the default table/schema) and is
idempotent: it bootstraps a clean empty DB AND no-ops on an already-migrated one.

## Smoke test

`src/boot.smoke.test.ts` boots the real composition root against a throwaway database (created +
dropped per run), proving the migration-chain boot path, then exercises a real authed round-trip
(`/health` → register → me → login → 401) with **no live-LLM call** — deterministic, CI-safe.
