# CLI reference

RaySpec ships two executables. After `pnpm build` they are the built entry
files; in a published install they land on your `PATH`:

- **`rayspec`** — the diagnostic/dev CLI documented here (`packages/app/cli`).
- **`rayspec-serve`** — the boot server, documented at the end of this page.

For the walkthrough that uses these commands in order, see
[getting-started](./getting-started.md); for the grammar the validating commands
check against, see the [spec reference](./spec-reference.md).

---

## Conventions

Every `rayspec` subcommand emits **exactly one JSON object on stdout** and uses a
three-value exit-code contract:

| Exit | Meaning                                                                 |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Success — the spec is valid / the plan passed / the action succeeded.  |
| `1`  | A not-ok result — an invalid spec, a blocked migration, a failed op. The JSON result explains why (in its `errors` / findings). |
| `2`  | A usage/CLI error — no subcommand, an unknown subcommand, or an unknown/invalid flag (including a missing or invalid required flag or path for `gen-handler` and `dev`). A short JSON error is written to **stderr** and the usage text is printed. |

A bad, missing, or out-of-jail **spec path** given to `doctor`, `plan`, or
`openapi` is *not* a usage error — it is caught and returned as an `ok: false`
result on **stdout** (exit `1`), the same channel as an invalid spec.

The commands split into two groups:

- A **read-only diagnostic floor** — `doctor`, `plan`, `openapi`, `gen-handler`.
  These never mutate a real/target database and never print secret values.
- A clearly separated **local-dev, mutating `dev` group** — `dev gen-secrets`,
  `dev db`, `dev bootstrap-tenant`. These deliberately write a secrets file,
  create a database, or provision a tenant.

### The spec-path jail

Every command that reads a spec resolves the path against the current working
directory and **rejects a path that escapes it** — a `..` climb above the cwd, or
an absolute path pointing outside the cwd, is refused (`path_escape`). The check
is re-applied after symlink resolution, so an in-cwd symlink pointing outside is
also refused. The file must exist, be a regular file, and be within a 1 MiB cap.

The practical consequence: **run the commands from the directory that contains
your spec** (typically the repo root), and pass a path *inside* it. An absolute
path to a spec outside the working directory will be rejected — this is a
deliberate, defence-in-depth jail, not a bug.

---

## `doctor`

```
rayspec doctor <spec.yaml>
```

Statically validates a spec against the grammar. **No database, no network.** It
runs the strict parser plus the semantic linter and reports the full,
fail-closed list of violations (not just the first). Validates either profile —
it dispatches on the `product:` discriminant.

- **Postgres:** not needed.
- **Flags:** none (exactly one positional spec path; an unknown flag is a usage
  error).
- **Output:**

  ```json
  { "ok": true, "errors": [] }
  ```

  On failure, each entry carries a closed `code`, a `message`, and an optional
  `path`:

  ```json
  { "ok": false, "errors": [{ "code": "unknown_field", "message": "…", "path": "stores[0].colums" }] }
  ```

- **Exit:** `0` if valid, `1` otherwise.

---

## `plan`

```
rayspec plan <spec.yaml> [--against <old-spec.yaml>] [--allowlist <file.json>]
```

Runs the **read-only front half of a deploy**: it validates the spec, computes the
migration SQL it *would* apply, and runs the destructive-change safety gate. It
never applies a migration to your target database, never rolls out, and never
introspects a live target.

- **Postgres:** not required for the validate/diff/gate work. If
  `SHADOW_DATABASE_URL` is set (and there is SQL to apply), `plan` additionally
  applies the generated SQL to a **throwaway shadow database** whose name it
  generates and drops afterward — to prove the SQL is clean. It **never** mutates
  the target database. A fail-closed guard refuses to shadow-apply if the shadow
  URL resolves to the same host and database name as `DATABASE_URL`.
- **Flags:**
  - `--against <old-spec.yaml>` — optional. Switches to **update mode**: instead
    of a first materialization, `plan` diffs the prior spec file into a *delta*
    migration. The baseline is the old spec **file**, never a live-DB
    introspection. A destructive delta is blocked unless covered by an allowlist,
    and the machine-proposed allowlist is surfaced so a reviewer can copy the
    entries they approve. Must be the same profile as the new spec.
  - `--allowlist <file.json>` — optional; requires `--against`. A reviewed JSON
    array of `{ kind, match, reason }` entries that let an approved destructive
    delta preview as would-pass. A bad allowlist aborts at validation
    (fail-closed) — it never silently clears a finding.
- **Output** (a stable envelope; update/product fields are additive):

  ```json
  {
    "ok": true,
    "stores": [{ "name": "notes", "columns": 3, "foreignKeys": 0 }],
    "migrationSql": "CREATE TABLE …",
    "routes": [{ "method": "POST", "path": "/notes", "action": "store" }],
    "agents": [{ "id": "summarizer", "backend": "openai", "model": "gpt-4o-mini" }],
    "gateFindings": [],
    "gateSummary": "",
    "breakingChangeBlocked": false,
    "shadowApplied": false,
    "errors": []
  }
  ```

  Key fields: `ok`; `phase` (`validate` | `gate` | `shadow`, on failure);
  `stores`/`routes`/`agents` (projected summaries — never raw secrets);
  `migrationSql` (the reviewable SQL); `gateFindings` and `gateSummary` (the
  per-statement destructive-scan verdict); `breakingChangeBlocked` (true when the
  gate would block the deploy); `shadowApplied`; `errors`. In update mode it also
  carries `updateMode`, `proposedAllowlist`, and `notes`; for a product-profile
  document it carries `product` section counts and, when a shadow ran,
  `driftFindings`.

- **Exit:** `0` if the spec validated, the gate did not block, and any shadow
  applied cleanly; `1` otherwise.

---

## `openapi`

```
rayspec openapi <spec.yaml>
```

Emits an **OpenAPI 3.1** document for a **product-profile** document's declared
view surface — the read routes, their parameters, and their response contracts —
as a deterministic client contract.

- **Postgres:** not needed.
- **Flags:** none (one positional spec path).
- **Profile:** product-profile only. A backend-profile document has no
  declarative `views` section, so it is rejected fail-closed
  (`unsupported_version`) rather than emitting a misleading empty document.
- **Output:**

  ```json
  { "ok": true, "openapi": { "openapi": "3.1.0", "info": { "title": "…", "version": "1.0" }, "paths": {}, "components": { "schemas": {} } } }
  ```

  The command reports `info.version: "1.0"` (the authoring language version). Note
  that a *running* product deployment's served OpenAPI document reflects an
  internal engine compatibility target instead — see the
  [spec reference version note](./spec-reference.md#a-note-on-versions).

- **Exit:** `0` on success, `1` on an invalid/non-product/unreadable spec.

---

## `gen-handler`

```
rayspec gen-handler --holes <holes.json> --out <dir> [--file <name.ts>]
```

Renders **one** escape-hatch handler `.ts` file from a bounded template, driven by
a "holes" contract (a small JSON file). The emitted code imports the handler SDK
**type-only**, takes zero npm dependencies, and reaches the database only through
the injected tenant-bound handle — so a generated handler cannot escape tenancy.

- **Postgres:** not needed.
- **Flags:**
  - `--holes <holes.json>` — **required**. The typed holes contract (size-capped;
    path-jailed to the cwd).
  - `--out <dir>` — **required**. The output directory (created if absent;
    path-jailed to the cwd).
  - `--file <name.ts>` — optional. A **bare** filename (no path separators, must
    end in `.ts`) overriding the default filename. The default is the export name
    lower-kebab-cased plus `.gen.ts` (e.g. `persistNote` → `persist-note.gen.ts`).
- **Output:**

  ```json
  { "ok": true, "file": "handlers/persist-note.gen.ts", "exportName": "persistNote", "template": "persist", "errors": [] }
  ```

  A malformed holes set is `ok: false` with an `errors` entry (exit `1`); a
  missing/invalid flag is a usage error (exit `2`).

---

## `dev gen-secrets`

```
rayspec dev gen-secrets [--out <path>]
```

Mints the three platform boot secrets into a `.env` file and `chmod 600`s it.
**Mutating, local-dev only.**

The three secrets are minted on distinct cryptographic chains: an RS256 JWT/OIDC
signing key (a PKCS#8 PEM), an API-key pepper, and a distinct media-signing key.
It is **idempotent**: a key already present in the target file is left untouched
(only missing keys are appended), and it **never echoes a secret value** — the
output reports only which keys were written vs. already present.

- **Postgres:** not needed.
- **Flags:** `--out <path>` — optional target file, default `./.env`.
- **Output:**

  ```json
  {
    "ok": true,
    "command": "dev gen-secrets",
    "out": ".env",
    "mode": "600",
    "keys": {
      "RAYSPEC_JWT_SIGNING_KEY": "written",
      "RAYSPEC_API_KEY_PEPPER": "written",
      "RAYSPEC_MEDIA_SIGNING_KEY": "already-present"
    },
    "errors": []
  }
  ```

---

## `dev db`

```
rayspec dev db [--database-url <url>] [--name <db>]
```

Creates the local dev database **if it is absent** — idempotent and never
destructive (a second run is a no-op; it never drops or alters an existing
database). It connects to the maintenance database on the same host and issues a
single `CREATE DATABASE`. The database name is validated against a strict
identifier pattern before use, since `CREATE DATABASE` cannot be parameterized.

- **Postgres:** required (reachable on the host in the base URL).
- **Flags:**
  - `--database-url <url>` — optional base URL; defaults to `DATABASE_URL`.
  - `--name <db>` — optional target name; defaults to the database named in the
    base URL.
- **Output** (value-free — the connection string is never echoed; any stray URL
  in an error message is redacted):

  ```json
  { "ok": true, "command": "dev db", "db": "rayspec", "created": true, "errors": [] }
  ```

  `created` is `true` when freshly created, `false` on the idempotent no-op path.

---

## `dev bootstrap-tenant`

```
rayspec dev bootstrap-tenant --base-url <url> [--email <e>] [--password <p>] [--org-name <n>]
```

Creates the first tenant and owner against a **running** RaySpec backend — it is
a pure HTTP client of the shipped auth API. It registers a user (which
auto-creates the organization and owner membership), then switches into that org
to obtain an org-scoped token.

- **Postgres:** not directly — it talks to a running server (which needs its own
  database).
- **Flags:**
  - `--base-url <url>` — **required**. The running backend's base URL.
  - `--email`, `--password`, `--org-name` — optional; sensible defaults are used
    when omitted.
- **Output** (the `orgToken` is the command's deliberate credential output — an
  org-scoped token you need for tenant routes):

  ```json
  {
    "ok": true,
    "command": "dev bootstrap-tenant",
    "orgId": "<ORG_ID>",
    "orgToken": "<ORG_TOKEN>",
    "email": "owner@example.com",
    "errors": []
  }
  ```

- **Exit:** `0` on success; `1` on an HTTP/network failure or unexpected response.

---

## `deploy` — boot and serve a declared product

```
rayspec deploy <spec.yaml> [--port <n>]
rayspec deploy --dry-run <spec.yaml>
```

**Production-mutating.** `deploy` boots the platform from the ambient environment,
materializes the declared product's tenant-scoped stores, mounts its routes, and
**serves** it on `PORT` (default `8080`) until `SIGINT` / `SIGTERM` — the
GitOps-from-one-file path. It reads the same fail-closed environment as
[`rayspec-serve`](#rayspec-serve--the-boot-server) (it sets `RAYSPEC_SPEC_PATH`
from the positional for you) and registers the product's stores through the
sanctioned, validating registration path (every store's tenant predicate is
checked before it joins the deny-by-default chokepoint).

- **`--dry-run`** is a **one-shot**, DB-free, network-free check: it validates the
  document and **composes** it against the wired runtime, emitting a JSON verdict.
  It does **not** prove the migration, boot-env sufficiency, any provider
  credential, live-schema drift, or that the app serves — it is a fast
  validate-and-compose. Exit `0` if it composes, `1` otherwise.

  ```
  rayspec deploy --dry-run examples/acme-notes/acme-notes.product.yaml
  ```

- **Postgres:** required for the serve path (it applies the migration chain and
  materializes stores). `--dry-run` touches no database.
- **Flags:** `--port <n>` overrides `PORT` (serve path); `--dry-run` selects the
  one-shot compose check.
- **Exit:** the serve path stays up until a signal; a fail-closed boot error (a
  missing secret, an unreviewed destructive migration) prints an actionable
  message and exits `1`.
- **Profiles — declaration vs. custom code.** `deploy` runs a **product-profile**
  document (like `examples/acme-notes/acme-notes.product.yaml`) directly — it is
  pure declaration with no custom code. A **backend-profile** document may ship
  custom escape-hatch handler modules; the serve runtime imports **compiled**
  modules, so a backend document that references `.ts` handlers fails closed at
  roll-out:

  ```
  handler '…': failed to import module 'handlers/….ts': Unknown file extension ".ts"
  ```

  Compile such handlers to `.js` before deploying — the deploy runtime ships no
  turnkey `.ts` loader. ([`gen-handler`](#gen-handler) scaffolds a handler;
  [`doctor`](#doctor) validates the spec.)
- **Database state.** The serve path applies the committed migration chain to
  `DATABASE_URL`, then materializes the declared stores, so it expects a **clean or
  fully-migrated** database. A half-provisioned database — for example one where the
  migration bookkeeping exists but the chain was only partly applied — makes boot
  fail with a raw migration error. There is no reset command (`dev db` creates a
  database but never drops one); if boot fails this way, deploy against a fresh,
  empty database instead (`rayspec dev db --name <fresh>` creates one, then point
  `DATABASE_URL` at it).

---

## `rayspec-serve` — the boot server

```
rayspec-serve
```

The local boot entrypoint. It is **entirely environment-driven** — a real
deployment sets its configuration through its orchestrator or secret manager.

- It reads its configuration from the ambient environment and **fails closed** on
  a missing or unsafe value: it refuses to boot unless `DATABASE_URL`,
  `RAYSPEC_JWT_SIGNING_KEY` (the RS256 PKCS#8 PEM), and `RAYSPEC_API_KEY_PEPPER`
  are set — secrets live in the environment or a secret manager, never in the
  database or in git.
- On boot it **applies the committed migration chain** to the target database
  (idempotent — it bootstraps a clean database and no-ops on an up-to-date one).
- It prints a **loud banner** stating that this is a local, single-node,
  not-yet-hardened deployment and must not be placed behind a public address.
  See [Architecture → Security model](./ARCHITECTURE.md#security-model) and
  [SECURITY](../SECURITY.md).
- With no spec configured it is an **auth-only** boot — accounts, authentication,
  OIDC, and a `/health` probe, with no product routes. Point `RAYSPEC_SPEC_PATH`
  at a spec to deploy the declared product on top. A **backend-profile** spec that
  declares agents boots **directly** this way: the entrypoint builds each declared
  agent's backend instance from the ambient environment (for example the `openai`
  backend from `OPENAI_API_KEY`) — no hand-written `AgentBackendsFactory` wrapper,
  and a missing credential fails the boot fast, naming the backend and the agent(s)
  that select it. (`rayspec deploy <spec>` is the same boot with `RAYSPEC_SPEC_PATH`
  set for you; see
  [getting-started](./getting-started.md#serving-your-declared-backend).)

It listens on `PORT` (default `8080`) and shuts down gracefully on `SIGINT` /
`SIGTERM`. The full set of environment variables is documented in
[`.env.example`](../.env.example).

---

## See also

- **[Getting started](./getting-started.md)** — these commands in sequence.
- **[Spec reference](./spec-reference.md)** — the grammar `doctor`/`plan`/`openapi`
  check.
- **[Architecture](./ARCHITECTURE.md)** — how a deploy turns a spec into a running
  backend.
