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

### Reading the boot values from a file

Each of those three also accepts a `<VAR>_FILE` variant — `DATABASE_URL_FILE`,
`RAYSPEC_JWT_SIGNING_KEY_FILE`, `RAYSPEC_API_KEY_PEPPER_FILE` — naming a file (a mounted secret,
mode `600`) to read the value from. The value then stays out of the image, out of the compose file,
out of the container's declared environment (`docker inspect` does not show it), and out of the
server's own exec environment in `/proc/<pid>/environ` — and it removes the need for a wrapper
entrypoint that materializes secrets into the environment before starting the server.

One caveat, so the benefit is not read for more than it is: at boot the server places the two auth
secrets into its process environment for the components that read them there, so any child process
it spawns is exec'd with them and they do appear in that child's `/proc/<pid>/environ`. The
connection string is not placed there.

- **Precedence:** when `<VAR>_FILE` is set it wins — the plain variable is not consulted at all. A
  `<VAR>_FILE` left in a local `.env` therefore takes precedence for every component that resolves
  its configuration from the ambient environment.
- **Blank counts as unset:** an empty / whitespace-only `<VAR>_FILE` is treated as not set, so the
  plain variable is used (orchestrators routinely materialize an unset variable as `""`).
- **Fail-closed:** a `<VAR>_FILE` pointing at a missing, unreadable, empty, or non-regular file
  **aborts the boot**. It never falls back to the plain variable — a broken secret mount must not
  silently downgrade to the weaker source. The abort names the variable, the path, and — when the
  read itself failed — the OS error code, never the file content.
- **The variable holds a path, not the secret:** the abort quotes that path so the error is
  actionable, which is a deliberate trade — a secret pasted into `<VAR>_FILE` by mistake is quoted
  back in the abort. Treat such a value as exposed and rotate it.
- **Content:** the real bytes of the value, with surrounding whitespace trimmed. That covers both a
  trailing newline and a leading newline / space / byte-order mark — the latter would otherwise
  reject the signing key at signer construction, well after the database is open. The flip side is
  that a secret whose real bytes begin or end with whitespace cannot be expressed in the file form;
  that limit applies to the two auth secrets, which are used exactly as written, and not to the
  connection string, which the plain path trims as well. The signing-key file holds a **real
  multi-line PEM**, not the single-line `\n`-escaped form a `.env` file uses.
- **Where:** point `<VAR>_FILE` outside the repository — a tmpfs or orchestrator secret mount such
  as `/run/secrets/`, or another path only the server user can read. Create the file so it is never
  readable by others — the umask in the same subshell as the redirect **and** a `chmod` after it:

  ```bash
  (umask 077; openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
    > /run/secrets/jwt-signing-key)
  chmod 600 /run/secrets/jwt-signing-key
  ```

  Both, because they cover different failure modes: the umask constrains a file being *created*, so
  it closes the window a later `chmod` would leave open — but it does not touch a file that already
  exists, so a rotation onto a path an earlier key or a configuration-management copy left
  group- or world-readable keeps that mode when the redirect truncates it, and only the `chmod`
  corrects that.
- **Server boot only:** `rayspec-serve` and `rayspec deploy` read `<VAR>_FILE`; the CLI subcommands
  that need a database URL of their own (`rayspec plan`, `rayspec dev db`) read the plain
  `DATABASE_URL`. With only `DATABASE_URL_FILE` set, `rayspec plan` has no connection string to
  compare `SHADOW_DATABASE_URL` against, so its guard against a dry-run landing on the real database
  does not fire — set the plain `DATABASE_URL` as well wherever you run those.
- **The local development wrapper is both:** `examples/local-boot` requires all three *plain*
  variables of its own accord, because it provisions a throwaway dev database from `DATABASE_URL`
  before the resolver is ever reached — so a `_FILE`-only environment fails there first, early and
  loudly. It then points `DATABASE_URL` at that dev database and hands over to the ordinary server
  boot, which resolves from the ambient environment, where `<VAR>_FILE` still wins. An ambient
  `DATABASE_URL_FILE` therefore outranks the dev database the wrapper just provisioned, while the
  boot banner still names the dev database. On a machine that has no such file the boot aborts
  fail-closed instead of retargeting anything silently; leave `<VAR>_FILE` out of a local `.env`
  unless you mean it for every boot.

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
