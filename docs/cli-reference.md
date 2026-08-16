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

Every `rayspec` subcommand emits **exactly one JSON object on stdout** — with one
documented exception, `--help`, which prints plain text there instead (see
[below](#the---help-flag)) — and uses a three-value exit-code contract:

| Exit | Meaning                                                                 |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Success — the spec is valid / the plan passed / the action succeeded.  |
| `1`  | A not-ok result — an invalid spec, a blocked migration, a failed op. The JSON result explains why (in its `errors` / findings). |
| `2`  | A usage/CLI error — an empty argument list, an unknown subcommand, or an unknown/invalid flag (including a missing or invalid required flag or path for `gen-handler`, `tenant` and `dev`). A short JSON error is written to **stderr** and the usage text is printed. |

A bad, missing, or out-of-jail **spec path** given to `doctor`, `plan`, or
`openapi` is *not* a usage error — it is caught and returned as an `ok: false`
result on **stdout** (exit `1`), the same channel as an invalid spec.

The commands split into three groups:

- A **read-only diagnostic floor** — `doctor`, `plan`, `openapi`, `gen-handler`.
  These never mutate a real/target database and never print secret values.
- A **production-mutating `tenant` group** — `tenant ensure`. It writes to the
  database `DATABASE_URL` names (and applies the committed migration chain to
  it), so it is deliberately *not* under `dev`, which is local-only. It prints no
  secret value: a minted invite token goes to a file and nowhere else.
- A clearly separated **local-dev, mutating `dev` group** — `dev gen-secrets`,
  `dev db`, `dev bootstrap-tenant`. These deliberately write a secrets file,
  create a database, or provision a tenant.

### The `--version` flag

One flag stands outside the subcommand grammar. `rayspec --version` (or `-v`)
reports the CLI's own version on **stdout** and exits `0`:

```json
{ "ok": true, "version": "1.8.0" }
```

The value is read from the CLI package's own manifest at run time, so it names
the version you actually have installed. It takes no arguments: a token after it is
refused as a usage error (exit `2`) rather than ignored.

### The `--help` flag

`--help` (or `-h`) is a help **request**, not a usage error: it prints help on
**stdout** and exits `0`. It is the one exception to the single-JSON-object rule
above — the help text is plain text, so a `set -e` script or a CI smoke step can
run it and read it.

Named on its own it prints the full manual; named after a command it prints
**that command's** help alone, which is how you ask what flags one command takes
without scrolling the whole thing:

```console
$ rayspec deploy --help
rayspec deploy — RaySpec CLI

PRODUCTION-MUTATING (boots + serves a real deployment; mutates the target DB):
  rayspec deploy <spec.yaml> [--port <n>] [--host <addr>] [--apply-migration …]
  …
```

A group answers for its members: `rayspec dev --help` prints all three `dev`
commands, `rayspec dev db --help` just that one.

The flag is honoured where a command name sits — `rayspec --help`,
`rayspec <command> --help`, `rayspec <group> <sub> --help` — and, like
`--version`, it takes no arguments: a token *after* it is refused as a usage
error (exit `2`) rather than ignored. Everything past the command path is that
command's own argument grammar, which the top level hands over untouched, so a
`-h` written further along is still that command's to interpret.

Every *other* leading `--flag` remains a usage error (the exit-`2` row above):
with no subcommand there is nothing to dispatch it to.

### The spec-path jail

Every command that reads a spec resolves the path against the current working
directory and **rejects a path that escapes it** — a `..` climb above the cwd, or
an absolute path pointing outside the cwd, is refused. The check is re-applied
after symlink resolution, so an in-cwd symlink pointing outside is also refused.
The file must exist, be a regular file, and be within a 1 MiB cap.

Every one of those read-time refusals is reported through the same envelope as a
malformed document: `code` is `yaml_parse_error`, and the **message** is what
names the cause — `spec path "…" escapes the working directory …`,
`spec path is not a regular file: …`, `spec file not found: …`,
`spec file is N bytes — exceeds the 1048576-byte cap`. That flattening is
deliberate: the envelope stays uniform across the closed `code` set below. So a
tool that needs to tell a jail refusal from a syntax error must read the message,
not the code.

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
  { "ok": true, "errors": [], "warnings": [] }
  ```

  `warnings` is part of every envelope, empty or not. It carries the non-fatal
  advisories the linter raised — each a `code`, a `message` and a `path` — and
  never affects `ok` or the exit code.

  A fourth key, `suppressed`, is present **only** when a node's `lintSuppress`
  acknowledged an advisory: the finding moves out of `warnings` into it, carrying
  the finding's `code`, the acknowledgement's `because` verbatim, and the
  finding's `path`. It does not affect `ok` either, and a document that
  acknowledges nothing gets no `suppressed` key at all:

  ```json
  { "ok": true, "errors": [], "warnings": [], "suppressed": [{ "code": "cron_tenant_required", "because": "…", "path": "triggers[0].kind" }] }
  ```

  A fifth key, `claimedSections`, is present **only** when the document
  references an [extension pack](./concepts.md) that claims a top-level section.
  A claimed key is owned by the pack, not by the core grammar, so `doctor` runs
  the same loader the boot runs, from the same deployment tree, and reports one
  neutral line per claim naming the key and the pack that owns it. It never
  affects `ok` — it states who owns a key, not that anything is wrong:

  ```json
  { "ok": true, "errors": [], "warnings": [], "claimedSections": ["section 'auditing' is claimed by extension pack 'audit-pack'"] }
  ```

  A document that references no pack loads no pack, reaches no pack module, and
  gets no `claimedSections` key at all.

  On failure, each entry carries a closed `code`, a `message`, and an optional
  `path`:

  ```json
  { "ok": false, "errors": [{ "code": "unknown_field", "message": "…", "path": "stores[0].colums" }], "warnings": [] }
  ```

  Two of those codes are about the packs themselves, and they prescribe opposite
  actions: `extension_pack_unavailable` means the pack is **not on this
  deployment** (install it, or drop it from `extensions[]` together with the
  sections it claims), while `extension_pack_refused` means the pack **is** here
  and was refused — a version pin that does not match its manifest, two packs
  claiming one key — so deploying it again changes nothing. A violation **inside**
  a claimed section is the pack's own, reported at `<section>.<field>` with the
  same codes a core section's violation carries.

- **Exit:** `0` if valid, `1` otherwise.

---

## `plan`

```
rayspec plan <spec.yaml> [--against <old-spec.yaml>] [--allowlist <file.json>]
             [--reconcile-injected-columns]
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
  URL resolves to the same host and database name as `DATABASE_URL`. That guard
  resolves its comparison target from a
  [`DATABASE_URL_FILE`](#rayspec-serve--the-boot-server) file mount as well as the
  plain `DATABASE_URL` (the file form takes precedence when set), so it still fires
  when the connection string is supplied only through the mount. Because `plan` is
  read-only and never connects to the real database, a broken `DATABASE_URL_FILE`
  (missing, unreadable, a directory, or empty) is **not** fatal here — unlike a
  server boot: `plan` emits one stderr warning (naming the variable, the path, and
  the OS error code, never the file content) and proceeds with no comparison target
  rather than falling back to a possibly-stale plain `DATABASE_URL`. With neither
  form set there is nothing to compare and the guard does not fire.
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
  - `--reconcile-injected-columns` — optional; requires `--against` (**update
    mode only**). Forces the platform-injected-column reconcile: the delta then
    also carries an idempotent `ADD COLUMN IF NOT EXISTS "created_by"` /
    `"idempotency_key"` plus the tenant-scoped idempotency unique index, for a
    database materialized before those injected columns existed. A spec never
    declares the injected columns, so a spec-vs-spec diff is otherwise blind to
    them; `IF NOT EXISTS` keeps it a no-op on an already-current database. Passing
    it without `--against` is refused fail-closed (a first materialization creates
    those columns fresh). Without the flag (the default) the diff never touches the
    injected columns, so the spec-vs-spec plan stays phantom-free.
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
  `driftFindings`. A backend-profile document that carries **non-fatal
  advisories** — the findings of the same document pass [`doctor`](#doctor) runs,
  such as a handler module that needs a build step before deploy — also carries
  `specWarnings` (the structured list) and `specWarningSummary` (one readable
  line each). These are the **raw** findings: `plan` does not apply the
  document's `lintSuppress` acknowledgements, so a finding a node has
  acknowledged is moved out of `doctor`'s `warnings` and still listed here. An
  advisory never changes `ok` and never blocks a plan; the fields are omitted
  when there are none. They are document findings, distinct from the operational
  stderr warning the read-only guard emits for a broken `DATABASE_URL_FILE`
  mount.

  A document that references an extension pack claiming a top-level section also
  carries `claimedSections` — the same one-line-per-claim list, from the same
  loader run against the same deployment tree, that [`doctor`](#doctor)
  documents. `plan` is the command an operator debugs with, which is why the key
  that is neither the core grammar's nor an error is named rather than left to be
  inferred. It never affects `ok`, and it is absent for a pack-free document.
  In update mode the `--against` **baseline** is parsed with the packs of the
  deployment being planned — the tree of the **new** document. The baseline is a
  prior revision of that same deployment's document handed in as a diff input, so
  it may be kept anywhere (`git show HEAD~1:rayspec.yaml > /tmp/prior.yaml`) and
  the packs that can validate it are the installed ones either way.

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
rayspec gen-handler --holes <holes.json> --out <dir> [--emit <ts|js>] [--file <name>]
```

Renders **one** escape-hatch handler module from a bounded template, driven by
a "holes" contract (a small JSON file). The emitted code imports the handler SDK
**type-only**, takes zero npm dependencies, and reaches the database only through
the injected tenant-bound handle — so a generated handler cannot escape tenancy.

- **Postgres:** not needed.
- **Flags:**
  - `--holes <holes.json>` — **required**. The typed holes contract (size-capped;
    path-jailed to the cwd).
  - `--out <dir>` — **required**. The output directory (created if absent;
    path-jailed to the cwd).
  - `--emit <ts|js>` — optional, default `ts`. The emit target. `ts` renders
    TypeScript source; `js` renders the *same* program as plain ESM JavaScript.
    Because the SDK import is type-only, `js` drops exactly what a compiler would
    erase — and nothing else.
  - `--file <name>` — optional. A **bare** filename (no path separators, ending in
    the extension `--emit` selects) overriding the default filename. The default is
    the export name lower-kebab-cased plus `.gen.<ts|js>` (e.g. `persistNote` →
    `persist-note.gen.ts`).
- **Output:**

  ```json
  { "ok": true, "file": "handlers/persist-note.gen.ts", "exportName": "persistNote", "template": "persist", "emit": "ts", "nextSteps": ["…"], "errors": [] }
  ```

  A malformed holes set is `ok: false` with an `errors` entry (exit `1`); a
  missing/invalid flag is a usage error (exit `2`).

### The holes contract

The holes file is one JSON object whose `template` field selects the shape:
`"persist"` (a write handler) or `"lookup"` (a read handler). Both carry
`exportName` and `store`. A `persist` set adds `columns`, `successStatus`, `mode`
(`update-by-id` or `upsert-by-natural-key`) with the `idArg` or `naturalKeyCol` that
mode needs, and the optional `fkRevalidate`, `fixedValues` and `clampValues`. A
`lookup` set adds `filterCols`, `projectCols`, `maxRows`, and the optional
`fixedFilter` and `substringArg`/`substringCol` pair. Every field is validated
fail-closed, and every hole object whose shape is fixed carries a **closed key
set**: the hole-set itself (per template), each `columns[]` entry, `fkRevalidate`,
and each `clampValues` rule. A key that shape does not declare — a typo, or a key
belonging to the other template — is rejected by name (naming the known key it is
a near-miss of), never ignored, because an ignored key silently drops the
mechanism it was meant to configure: `fkRevalidate` mistyped drops the whole FK
re-check, and `lookupFixedFilter` mistyped inside it drops that re-check's fixed
predicate. The map-valued holes (`fixedValues`, `fixedFilter`,
`lookupFixedFilter`, `clampValues`) are keyed by column name instead, so their
keys are fenced by the snake_case charset and the column rules — which leaves no
tolerated annotation prefix at any level. So a malformed hole-set never reaches a
renderer.

What each field means, and the coherence rules over combinations of them, is specified
in [the authoring skill](../.claude/skills/rayspec-author/SKILL.md) — read that before
writing a holes file. This reference deliberately does not restate the contract, so it
has exactly one specification.

### Which target to emit

`deploy` loads every `handlers[].module` as **compiled JavaScript only** — it
refuses a `.ts` module fail-closed (the failure and the fix are walked in
[getting-started → the backend profile](./getting-started.md#the-backend-profile-direct-agent-boot)).
So a `--emit ts` render is not yet deployable: compile it first (the
`examples/acme-notes-backend/build.mjs` wrapper transpiles the handlers and
rewrites the spec's `module:` paths) and point `handlers[].module` at the built
`.js`. A `--emit js` render skips that step — wire `handlers[].module` straight at
the emitted file and deploy, provided the deployment directory resolves `.js` as
ESM (`"type": "module"` in its nearest `package.json`, which the build wrapper
also writes). The `nextSteps` field of the envelope states this for the target
you actually asked for.

---

## `tenant ensure`

```
rayspec tenant ensure --org-id <uuid> --name <n> [--owner-email <e>] [--owner-invite-out <path>]
                      [--invite-ttl-seconds <n>] [--reissue-owner-invite]
```

Idempotently **creates or resolves** the organization named by `--org-id`, so a
product deployment's `RAYSPEC_PRODUCT_TENANT_ID` can be settled before anything
is deployed. It talks to `DATABASE_URL` directly — **no running server, and no
HTTP route exists for it in any posture**.

Run it twice with the same `--org-id` and you get the same organization and no
second row. The chosen id *is* the operation id: `orgs.id` is a primary key, so
the database itself is the ledger and two concurrent runs of the command converge
rather than race — one reports `created`, the other `existing`, and both name the
same organization. That holds against a **fresh** database too: the migration
step below is serialized by a Postgres advisory lock, because the migrator's own
`CREATE … IF NOT EXISTS` bootstrap is not concurrency-safe and would otherwise
fail the loser before it ever reached the reservation. So the command is safe to
call unconditionally from a deploy script that cannot know whether an earlier
attempt got through.

- **Postgres:** yes, directly. **It applies the committed migration chain** to
  that database — required on a first bootstrap and idempotent afterwards, but it
  means pointing the command at an unexpected `DATABASE_URL` migrates *that*
  database.
- **Secrets:** `DATABASE_URL` and `RAYSPEC_API_KEY_PEPPER`, each also honouring
  its `<VAR>_FILE` variant with the usual precedence and fail-closed behaviour
  (see the [server package README](https://github.com/rayspec-labs/rayspec/blob/main/packages/app/server/README.md)).
  The pepper must be the **same value the target deployment runs with**, because
  it is what the invite token is hashed under. `RAYSPEC_JWT_SIGNING_KEY` is
  deliberately not read — the command mints no JWT.
- **Flags:**
  - `--org-id <uuid>` — **required**. The organization id to create or resolve.
    A malformed uuid is a usage error, refused before the database is opened.
    Letter case does not matter: the id is bound and reported as the database
    stores it (lower case), which is what a deployment compares against.
  - `--name <n>` — **required**. The display name; the slug is derived from it
    the same way every other path derives one.
  - `--owner-email <e>` — optional. Mint an owner **invite** for this address so
    a human can claim the organization. Omitted, the command only reserves the
    organization and writes no invite.
  - `--owner-invite-out <path>` — **required with `--owner-email`**. Where the
    minted token is written: an exclusively-created, mode-600 file holding the
    token and nothing else. An existing path is **refused**, never overwritten.
    There is deliberately no flag that takes a token *value* — a secret passed as
    an argument lands in shell history and in `ps`.
  - `--invite-ttl-seconds <n>` — optional. Overrides the **1-hour** operator
    default, clamped to the shipped 5-minute/30-day bounds.
  - `--reissue-owner-invite` — optional. Revoke the outstanding owner invite and
    mint a replacement, in one transaction (for a token that was lost). Without
    it, a run that finds a live invite reports it and mints nothing.
- **Output** — one JSON object, containing **no secret material**:

  ```json
  {
    "ok": true,
    "command": "tenant ensure",
    "orgId": "<ORG_ID>",
    "name": "Acme",
    "slug": "acme",
    "org": "created",
    "ownerHandoff": {
      "status": "issued",
      "inviteId": "<INVITE_ID>",
      "email": "founder@example.com",
      "expiresAt": "2026-08-02T13:00:00.000Z",
      "tokenFile": "/run/secrets/owner.token"
    },
    "acceptPath": "/v1/invites/accept",
    "errors": []
  }
  ```

  `org` is `created` on the run that made the organization and `existing` on
  every later one. `ownerHandoff.status` is one of `not_requested` (no
  `--owner-email`), `already_owned` (the organization already has an owner — the
  command does not displace one), `pending` (an earlier run's invite is still
  live) or `issued` (this run minted one). The one gap in `already_owned`: an
  invite that is being redeemed at that exact moment is consumed a statement
  before the membership is written, so a run landing in between sees neither and
  mints. That produces an additional owner invite, never a displaced owner.

  On a run that resolves an existing organization, `--name` is not applied: the
  stored name and slug are what comes back. The command creates or resolves; it
  does not rename.

- **Exit:** `0` on success; `1` on an operational failure (a missing secret, a
  soft-deleted id, an invite-out path that is taken, a migration chain that could
  not be applied — that one reports `MIGRATION_FAILED` and creates nothing); `2`
  on a usage error.

### The owner handoff, and why it creates no user

The command creates **no platform user and no membership**. What it writes, in
the same transaction as the organization row, is one `owner` invite authored by
nobody (`created_by IS NULL`). A real person then redeems it at the ordinary
public `POST /v1/invites/accept` — which provisions *their* account with *their*
password and attaches the owner membership. Nothing temporary is left behind,
which is the property the older bootstrap dance could not offer: a user cannot be
removed once created (the last owner cannot be removed, and a user delete is a
soft delete that leaves a row).

Between the two steps the organization has **zero members**. Nothing can act in
that window, but the product boot gate checks only that the organization exists
and is not soft-deleted, so a reserved organization is bootable before it is
claimed.

> **The token in `--owner-invite-out` is a tenant-takeover credential** until it
> is consumed or expires. `POST /v1/invites/accept` lets any holder provision the
> target account with a password of their choosing when that address has no
> account yet — so whoever can read that file owns the organization. The
> exclusive-create mode-600 write and the short default lifetime bound the
> exposure; they do not remove it. Delete the file once the invite is redeemed.

Note also what the command does **not** check. The data-integrity rules are the
same code the HTTP surface runs — the tenant predicate, email normalization, the
role, the TTL clamp, the single-flight on `orgs.id`. The *authorization* check is
absent, because there is no principal: the command's authority is possession of
`DATABASE_URL` and `RAYSPEC_API_KEY_PEPPER`.

### The one-step production order

```bash
# 0. Settle the id first — this one does not exist yet; step 1 creates it.
ORG_ID=$(uuidgen)

# 1. Create the organization and mint the owner handoff. No server needed.
rayspec tenant ensure --org-id "$ORG_ID" --name "Acme" \
  --owner-email founder@example.com --owner-invite-out ./owner.token

# 2. Hand ./owner.token to the founder, who redeems it:
#      POST /v1/invites/accept  {"token": "<contents>", "password": "…"}
#    …then delete the file.

# 3. Deploy the product against the id.
RAYSPEC_PRODUCT_TENANT_ID="$ORG_ID" rayspec deploy path/to/product.yaml
```

Steps 1 and 3 can run against the same `DATABASE_URL` with no server in between,
and step 1 is safe to re-run. `RAYSPEC_TENANT_BOOTSTRAP_ENABLED` stays unset
throughout — `POST /v1/auth/bootstrap-tenant` is never registered on the
deployment at all.

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
rayspec dev db --reset --yes [--database-url <url>] [--name <db>]
```

By default, creates the local dev database **if it is absent** — idempotent and
never destructive (a second run is a no-op; it never drops or alters an existing
database). It connects to the maintenance database on the same host and issues a
single `CREATE DATABASE`. The database name is validated against a strict
identifier pattern before use, since `CREATE DATABASE` cannot be parameterized.

With **`--reset --yes`** it instead **DROPs and re-CREATEs** a clean, empty
database (and drops the sibling `<name>_dbos_sys` durable-worker system database),
so you can wipe a corrupt or stale dev DB in one command. Because it destroys data
it is gated on an explicit `--yes`: `--reset` **without** `--yes` refuses and
touches nothing (the guard fires before any DB connection). Local-dev only.

- **Postgres:** required (reachable on the host in the base URL).
- **Flags:**
  - `--database-url <url>` — optional base URL; defaults to `DATABASE_URL`.
  - `--name <db>` — optional target name; defaults to the database named in the
    base URL.
  - `--reset` — DROP + re-CREATE a clean database (destructive). Requires `--yes`.
  - `--yes` — confirm the destructive `--reset`.
- **Output** (value-free — the connection string is never echoed; any stray URL
  in an error message is redacted):

  ```json
  { "ok": true, "command": "dev db", "db": "rayspec", "created": true, "errors": [] }
  ```

  `created` is `true` when freshly created, `false` on the idempotent no-op path; a
  `--reset --yes` run reports `"created": true, "reset": true`.

---

## `dev bootstrap-tenant`

```
rayspec dev bootstrap-tenant --base-url <url> [--email <e>] [--password <p>] [--org-name <n>]
                             [--org-id <uuid>]
```

Creates the first tenant and owner against a **running** RaySpec backend — it is
a pure HTTP client of the shipped auth API. It registers a user (which
auto-creates the organization and owner membership), then switches into that org
to obtain an org-scoped token.

- **Postgres:** not directly — it talks to a running server (which needs its own
  database).
- **Flags:**
  - `--base-url <url>` — **required**. The running backend's base URL.
  - `--email` — optional; defaults to `owner-<epoch-ms>@rayspec.local`, a fresh
    address on every run, so a repeat never collides with the user the previous
    run registered. Pin it only if you want a predictable owner — a second run
    with the same address is a `409` and the command reports `REGISTER_FAILED`.
  - `--password` — optional; defaults to the literal
    `correct-horse-battery-staple-9`. It is a **development** default, not a
    secret: it is the same on every machine, so pass `--password` yourself
    whenever the account is meant to outlive the walkthrough. Whatever value is
    used is the one `POST /v1/auth/login` will want later — this command never
    prints it back.
  - `--org-name` — optional; defaults to `My Workspace`.
  - `--org-id <uuid>` — optional. Create the organization under **this** id
    instead of a server-generated one, so you can put the id in
    `RAYSPEC_PRODUCT_TENANT_ID` before the product deployment exists. Requires the
    target server to be running with `RAYSPEC_TENANT_BOOTSTRAP_ENABLED=true` (see
    below); against a server without it the request is a plain `404` and the
    command reports `REGISTER_FAILED`. A malformed uuid is a usage error, refused
    before any request is made. An id that is already taken is a `409`.
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

### Choosing the org id: the operator gate, and why it exists

`POST /v1/auth/register` is public and unauthenticated, and it will **never**
accept a client-chosen org id: ids stay server-generated and unguessable there.
That unguessability is load-bearing, because a product deployment binds itself to
one org id. If any public caller could name the id, somebody who learned the id
you intend to deploy against could create that organization first, with themselves
as owner, and your deployment would come up bound to an organization they control.

So the chosen-id path is a **separate route** (`POST /v1/auth/bootstrap-tenant`)
that a server **only registers** when it was started with
`RAYSPEC_TENANT_BOOTSTRAP_ENABLED=true`. On any other deployment that path does
not exist at all — there is no gate to guess at and no collision reply to read as
an existence oracle. Turn the variable on for the bootstrap boot, and off again
for the deployment.

### The local-dev order for a product deployment

A product deployment **refuses to boot** when `RAYSPEC_PRODUCT_TENANT_ID` is
malformed or names no live organization, and — because `deploy` serves the auth
surface itself — it therefore cannot create its own tenant. Bootstrap first,
deploy second.

In **production**, use [`tenant ensure`](#tenant-ensure): it does the same thing
in one step, against `DATABASE_URL` directly, without a server and without ever
registering `POST /v1/auth/bootstrap-tenant`. The walkthrough below is the
local-dev route through a running server, and stays fully supported:

```bash
# 0. Settle the id first — this one does not exist yet; step 2 creates it.
ORG_ID=$(uuidgen)

# 1. Boot the auth surface alone, with the bootstrap gate on. No spec, no product.
#    This runs in the foreground, so give steps 2-3 a second shell.
RAYSPEC_TENANT_BOOTSTRAP_ENABLED=true rayspec-serve

# 2. Create the tenant under the id you chose.
rayspec dev bootstrap-tenant --base-url http://127.0.0.1:8080 --org-id "$ORG_ID"

# 3. Stop that server. Deploy the product against the id — gate off.
RAYSPEC_PRODUCT_TENANT_ID="$ORG_ID" rayspec deploy path/to/product.yaml
```

Step 0 is the one case where generating a fresh UUID is right: the id is created
in step 2. Everywhere else `RAYSPEC_PRODUCT_TENANT_ID` must name an organization
that already exists — a random id names none, and the boot check refuses it.

Against an existing organization, skip steps 1–2 entirely and set
`RAYSPEC_PRODUCT_TENANT_ID` to that organization's id.

---

## `deploy` — boot and serve a declared product

```
rayspec deploy <spec.yaml> [--port <n>] [--host <addr>]
rayspec deploy <spec.yaml> --apply-migration <delta.sql> [--allowlist <file.json>]
               [--port <n>] [--host <addr>]
rayspec deploy --dry-run <spec.yaml>
rayspec deploy --check-env <spec.yaml>
```

**Production-mutating.** `deploy` boots the platform from the ambient environment,
mounts the declared product's routes, and **serves** it on `PORT` (default `8080`)
until `SIGINT` / `SIGTERM` — the GitOps-from-one-file path. It reads the same
fail-closed environment as [`rayspec-serve`](#rayspec-serve--the-boot-server) (it sets
`RAYSPEC_SPEC_PATH` from the positional for you) and registers the product's stores
through the sanctioned, validating registration path (every store's tenant predicate is
checked before it joins the deny-by-default chokepoint).

**`deploy` is mount-only against an existing schema.** On a **clean** database it
materializes the declared stores; on an **up-to-date** one it mounts them unchanged. It
does **not** derive and apply a schema change on its own: if the live schema has
**drifted** from the spec, the boot **fails closed** rather than altering it. A schema
change is applied by the explicit `--apply-migration` flag below.

- **`--dry-run`** is a **one-shot**, DB-free, network-free check: it validates the
  document with the grammar of the **profile it boots**, and — for a product
  document — **composes** it against the wired runtime, emitting a JSON verdict.
  It does **not** prove the migration, boot-env sufficiency, any provider
  credential, live-schema drift, or that the app serves. Exit `0` if the document
  passes its profile's check, `1` otherwise.

  ```
  rayspec deploy --dry-run examples/acme-notes/acme-notes.product.yaml
  ```

  Each of the three profiles `deploy` boots is answered on its own terms, so the
  verdict never reports one profile's document in another's vocabulary and a caller
  gating on `ok` needs to know nothing about which ruleset applied:

  | Document | `ok: true` payload | Judged by |
  | --- | --- | --- |
  | **product** (carries `product:`) | `composed` — the product id and the store / view-route / trigger-event / workflow names it composes to | the product grammar + a stubbed compose |
  | **backend** (`rayspec`, no `product:`) | `backendProfile` — the profile named, plus the declared `stores`, `routes` (`METHOD /path`), `agents`, `handlers` and (when the document declares any) `frontendMounts` | the same parser `doctor` and `plan` use |
  | **frontend-only** (static) | `staticProfile` — the profile named, the `frontendMounts` that boot would serve, and the statement that no database is touched, no migration applies, and there is nothing to compose | the same detection the static boot branches on |

  A **backend** document declares its routes and handlers rather than lowering to
  them, so there is nothing to compose: the check is the validation `doctor` runs,
  and the payload is **declared names only** — no SQL, nothing derived. It covers the
  sections [`plan`](#plan) also projects (`stores`, `routes`, `agents`) plus the
  declared handler ids, but it is not `plan`'s payload: `plan` publishes no handlers,
  and its stores and routes are richer objects (column and FK counts,
  `{method, path, action}`). `ok: true` means the document **validates**, not that it
  boots: `notProven` carries the shared boundary **plus** this profile's boot refusals
  — a `stream` route with no blob backend configured, a declared handler module that
  does not resolve as compiled JavaScript under the jailed root, the `STT_PROVIDER` /
  `TTS_PROVIDER` credentials demanded at boot, and any declared **frontend mount**
  whose directory does not hold servable built assets (this profile boots the full
  platform, which refuses an unservable mount fail-closed — see
  [spec-reference → `frontend`](./spec-reference.md#frontend); the mounts themselves
  are echoed in `frontendMounts`, so the verdict names what boot will check). A
  document the backend grammar rejects reports **its own** violations (a
  `dangling_ref`, an unknown key) — the same errors `doctor` reports for it. It is
  also the profile whose grammar carries `extensions[]`, so a document that
  references a pack claiming a top-level section is validated with that pack
  loaded and carries the same `claimedSections` list [`doctor`](#doctor) and
  [`plan`](#plan) report. A document that **writes** such a section carries no extra
  boundary: **the boot resolves the deployment's packs before it validates the
  document**, so a claimed section boots exactly as this preview validated it, and
  the verdict keeps the boundary list every other backend verdict gets.
  (`--check-env` still loads no pack: running one is exactly the side effect that
  command promises not to have. Having loaded none, it cannot tell a claimed key from
  a mistyped one, so on a **pack-bearing** document it lifts out **every** top-level
  key the core grammar does not own and names each in `notChecked` — see
  [`--check-env`](#deploy) below for what that costs.)

  A **frontend-only** document has nothing to compose either, and what its check does
  not prove narrows instead: it reads only the document, so it says nothing about
  whether the declared directories hold built assets, or that the app serves.

- **`--check-env`** is the other **one-shot**, DB-free, network-free check: the
  environment variables **this document's boot will require**, each with its
  `<VAR>_FILE` equivalent where it has one, **why** it is required, and whether it is
  currently set. Exit `0` when every demand is met **and** no refusal is already
  visible, `1` otherwise — `missing` lists the unmet demands, and `errors` names a
  refusal that is *not* an unset variable (a document that does not validate, an agent
  selecting a backend that is not wired, an `stt.*` step declared without the audio
  capability, an unrecognised `RAYSPEC_ANTHROPIC_REUSE_LOGIN` on a document that selects
  the `anthropic` backend). It is the answer a refused `deploy` used to be the only way
  to get, and that answer is not cheap: the demands a declared `stream` route, playback
  route or `cron` trigger raise are reached only **after** the boot has opened the
  database and applied the whole committed migration chain.

  ```
  rayspec deploy --check-env ./rayspec.yaml
  ```

  It reads the **document and the environment**, and it needs both — some demands have
  no document signal at all. On a **backend** document, setting `STT_PROVIDER=deepgram`
  makes `DEEPGRAM_API_KEY` required and `TTS_PROVIDER=openai` makes `OPENAI_API_KEY`
  required, whatever that document declares — the two speech capabilities are wired from
  the environment alone. (It is a backend-document law: a **product** document reads
  `STT_PROVIDER` on its own terms below and never reads `TTS_PROVIDER` at all, and a
  frontend-only one reads neither.) A provider **selector is never itself an
  unconditional demand**: on a
  backend document, leaving either unset means that capability is simply absent, which
  is not a boot error, so both are reported under `optional` saying exactly that; on a
  product document `STT_PROVIDER` *is* demanded, but only when the document declares an
  `stt.*` step **alongside the audio capability** — a document that declares `stt.*`
  without audio is refused on its shape, before the boot reads the selector at all, and
  the verdict reports that refusal instead of a demand no value would satisfy. In
  neither case does a credential become a demand before a provider has
  been selected. Each profile is answered on its own
  terms — a frontend-only (static) document is told it needs **none** of the three
  platform secrets, and a product document gets `RAYSPEC_PRODUCT_TENANT_ID` plus the
  capability-conditional demands its own declarations raise.

  The demands are not re-derived by the CLI: they come from the same records
  `@rayspec/server` composes its boot refusals from, so a demand the boot raises is a
  demand this prints.

  It generalizes a surface that already existed for exactly one variable.
  [`doctor`](#doctor) raises a `cron_tenant_required` **advisory** for every declared
  `cron` / `manual` trigger, naming `RAYSPEC_CRON_TENANT_ID` — and it can only be an
  advisory, because the lint pass is pure over the document and cannot read an
  environment. `--check-env` says the same thing about the same trigger *and* reports
  whether the variable is set; both statements stay true, and the advisory is unchanged.

  What it deliberately does not do is in the verdict's `notChecked`, not left to
  inference. It opens **no socket, no database and no credential**, and it loads **no
  extension pack** — running pack code is what would break that promise — so every
  demand a pack changes is invisible here. It runs in **both** directions: a
  pack-supplied blob backend *removes* the `RAYSPEC_BLOB_ROOT` demand, while a
  pack-contributed `api` route *adds* the `RAYSPEC_BLOB_ROOT` demand (any
  `kind: stream`) and the `RAYSPEC_MEDIA_SIGNING_KEY` demand (`mode: playback`), and a
  pack-contributed agent *adds* its backend's credential demand. The boot guards ask
  their questions of the **post-merge** document; this reads the base one — so a
  document whose whole route surface arrives from a pack (the
  [`stream-backend` example](../examples/stream-backend/rayspec.yaml) is exactly that
  shape) reports the three unconditional secrets and nothing more. To keep that from
  reading as a clean bill of health, the verdict **names the packs the document
  declares** — parsed off `extensions[]`, never loaded.

  Loading no pack has one further cost, and it is a **loss of coverage** rather than a
  missing demand. A pack may claim a top-level key of the document, and only the loaded
  pack can say which key. So on a document that **declares any pack**, this command lifts
  out **every** top-level key the core grammar does not own — claimed or not — accepts it
  unexamined, and names it in `notChecked`. **It therefore no longer refuses a mistyped
  top-level section on such a document**: `auditting:` where the pack claims `auditing:`
  is reported as a key whose owner it did not ask about, and the verdict's `errors` stays
  empty. The boot still refuses it, and so do [`doctor`](#doctor), [`plan`](#plan) and
  `--dry-run`, which all load the packs — run one of those for the verdict that has read
  them. On a document that declares **no** pack nothing is lifted and an unknown
  top-level key is refused here exactly as before.

  A set `<VAR>_FILE` mount counts
  as set from the variable alone: the file is
  never opened, so a missing, unreadable or empty secret file still refuses the boot.
  And **no value is validated** — a malformed PKCS#8 PEM, a non-UUID
  `RAYSPEC_CRON_TENANT_ID` or a media key under 32 bytes is reported as set and still
  refuses. A value is *read* only where it decides **which** demands apply: a selected
  `STT_PROVIDER` / `TTS_PROVIDER`, and `RAYSPEC_ANTHROPIC_REUSE_LOGIN`, whose
  unrecognised value *is* reported because it decides whether the anthropic token demand
  exists at all. No environment value is ever printed; every variable is a `set` boolean
  and the one refusal about a value names the variable without quoting it. The
  verdict also names the `.env` files the CLI's loader searched (`searchedDotenv`),
  which is usually the answer to a disputed "unset". It is rejected with `--dry-run`
  (each emits its own verdict) and with `--apply-migration` / `--allowlist` (it opens no
  database, so a delta handed to it would be dropped).
- **`--apply-migration <delta.sql>`** applies a **reviewed forward migration** in
  place before serving — the supported path for evolving an existing deployment's
  schema (author the delta with [`plan --against`](#plan)). It reaches the same gated
  migration engine `plan` previews: a **destructive** statement without a covering
  reviewed **`--allowlist <file.json>`** entry is **blocked**. It is **reboot-safe** —
  before deciding, the boot probes the objects the delta itself names: one whose objects
  are already in the state an applied delta leaves them in is **mounted** rather than
  re-applied (a non-idempotent delta re-applied would crash the boot), so a
  `Restart=always` unit applies the delta once and mounts thereafter (still, drop the flag
  once it lands to keep intent explicit). A delta whose objects are **not** there is
  **applied**, and the boot names the object it looked for — including when the live schema
  is drift-clean against the spec, which it always is for an object the spec cannot express
  (a hand-shaped index). A delta found only **partly** applied is **refused**, naming both
  sides, rather than half re-applied. It is rejected with `--dry-run` (a dry-run touches no database) and against a
  frontend-only spec (the static profile below touches no database either), and a bare
  `--allowlist` without `--apply-migration` is refused (it would be silently ignored).
  Both file paths are jailed exactly like the spec path.
- **`--host <addr>`** sets the interface the serve path binds, by writing `RAYSPEC_HOST` —
  a value passed here overrides an ambient one, exactly as `--port` overrides `PORT`.
  Unset, blank or whitespace-only means **loopback** (`127.0.0.1`), so a deployment is
  **not reachable off-box** until an operator names another interface (`--host 0.0.0.0`
  binds all of them); the boot banner reports the address actually bound rather than a
  fixed loopback string. It is a **serve-path** flag: `--dry-run` and `--check-env` answer
  without binding anything, so a `--host` passed alongside either is accepted and ignored —
  unlike `--apply-migration` / `--allowlist`, which those two modes refuse outright. It
  moves the **listen address only**. The OIDC issuer still defaults to
  `http://127.0.0.1:<port>/oidc`, so a deployment bound to `0.0.0.0` keeps emitting
  loopback OIDC URLs until `OIDC_ISSUER` names the address its clients reach it on.
- **Postgres:** required for the serve path (it applies the committed **platform**
  migration chain and materializes/mounts stores). `--dry-run` touches no database,
  and neither does a frontend-only spec — see the static-profile bullet below.
- **Frontend-only (static profile).** A document that declares only a `frontend`
  boots the **static profile**, the same branch
  [`rayspec-serve`](#rayspec-serve--the-boot-server) takes and entered **before** any
  secret is read: no database, none of the three boot secrets, and **no** auth / OIDC /
  run route mounted (`/health` carries no `db` field — it reports the mounts' readiness
  as `frontend`), with the `Content-Security-Policy`
  and `Permissions-Policy` defaults emitted by the app itself. Because it touches no
  database it applies no migration, so `--apply-migration` / `--allowlist` against such a
  document are **refused** as a usage error (exit `2`) rather than silently ignored.
  `--dry-run` reports this profile and the mounts it would serve (`ok: true`, exit `0`)
  instead of a compose verdict — the same detection the boot branches on, so the check
  and the boot cannot disagree. See
  [getting-started → a frontend-only (static) deployment](./getting-started.md#a-frontend-only-static-deployment).
- **Flags:** `--port <n>` overrides `PORT` (serve path); `--host <addr>` overrides
  `RAYSPEC_HOST` and moves the bind off the loopback default (serve path); `--dry-run`
  selects the one-shot compose check; `--check-env` selects the one-shot
  boot-environment check; `--apply-migration <delta.sql>` applies a reviewed forward
  migration; `--allowlist <file.json>` (requires `--apply-migration`) covers reviewed
  destructive statements in that delta.
- **Exit:** the serve path stays up until a signal; a fail-closed boot error (a
  missing secret, an unreviewed destructive migration) prints an actionable
  message and exits `1`.
- **Profiles — declaration vs. custom code.** `deploy` runs a **product-profile**
  document (like `examples/acme-notes/acme-notes.product.yaml`) directly — it is
  pure declaration with no custom code and no build step. A **backend-profile**
  document may ship custom escape-hatch handler modules (and an extension pack is
  authored the same way); the runtime loads them as **compiled JavaScript only** —
  it fail-closed-rejects a `.ts` module path at roll-out, deterministically (this
  does not rely on the Node version, even where Node transparently type-strips `.ts`):

  ```
  handler '…': module '…/handlers/….ts' is TypeScript source ('.ts') — production
  loads compiled JavaScript only. Compile it to JavaScript first …
  ```

  Compile such handlers to `.js` first and deploy the compiled artifact — the deploy
  runtime ships no turnkey `.ts` loader. The bundled examples ship a build step
  (`build.mjs`): `examples/acme-notes-backend` emits a deploy-ready `dist/rayspec.yaml`,
  and `examples/stream-backend` compiles its extension pack. A **pack** additionally
  resolves `@rayspec/platform` at load starting from its own compiled entry's location, so
  ship the pack directory to the deploy target with its installed `node_modules` — that is
  what pins the platform build it runs against. See
  [spec-reference → `extensions`](./spec-reference.md#extensions) for the section grammar and
  [getting-started → the backend profile](./getting-started.md#the-backend-profile-direct-agent-boot)
  for the walkthrough.
  ([`gen-handler`](#gen-handler) scaffolds a handler; [`doctor`](#doctor) validates the spec.)
- **Database state.** The serve path applies the committed **platform** migration
  chain to `DATABASE_URL` (idempotent — it bootstraps a clean database and no-ops on an
  up-to-date one), then materializes the declared stores on a clean database or mounts
  them when they already match — so it expects a **clean or fully-migrated** database. A
  half-provisioned database — for example one where the migration bookkeeping exists but
  the chain was only partly applied — makes boot fail with a raw migration error. If
  boot fails this way, deploy against a fresh, empty database:
  [`rayspec dev db --reset --yes`](#dev-db) DROPs and re-CREATEs a clean one, or
  `rayspec dev db --name <fresh>` creates a separate empty database; then point
  `DATABASE_URL` at it. A store **schema change** against an already-materialized
  database is **not** applied by a plain `deploy` — a drifted schema fails closed;
  apply the change with [`--apply-migration`](#deploy--boot-and-serve-a-declared-product)
  above.

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
- Each of those three also accepts a `<VAR>_FILE` variant (`DATABASE_URL_FILE`,
  `RAYSPEC_JWT_SIGNING_KEY_FILE`, `RAYSPEC_API_KEY_PEPPER_FILE`) naming a file to
  read the value from, which **takes precedence** over the plain variable; a
  `<VAR>_FILE` pointing at a missing, unreadable, or empty file **aborts the
  boot** rather than falling back to the plain variable.
- Leading and trailing whitespace (a trailing newline, a leading byte-order mark) is
  **stripped** from a resolved secret regardless of source — a `<VAR>_FILE` mount and the
  plain variable are byte-equivalent — while interior bytes are preserved (a multi-line
  PEM is safe). A secret whose real bytes need edge whitespace must be base64-encoded.
- When that normalization **actually changes** a resolved secret, the boot prints **one
  warning per changed secret** on stderr, naming the variable it was resolved from (`<VAR>`,
  or `<VAR>_FILE` when the mount won) and the kind of change — `a leading byte-order mark
  removed`, `leading whitespace removed`, `trailing whitespace removed`. It never prints the
  value or any part of it, and the boot continues with the normalized value. A secret the
  trim leaves untouched is silent. The stripped trailing newline of a key file created with
  a `>` redirect is the expected, harmless case; the signal matters when a secret that
  carried edge whitespace suddenly stops being accepted.
- Ahead of that resolution it loads a local `.env` **if one exists** — a
  local-development convenience; a real deployment has none. It searches `$PWD/.env`, the
  directory `rayspec-serve` was started in, **first** and the RaySpec **install root's**
  `.env` **second** — the install root being the directory four segments above the loader's
  own module: your checkout root when you run from a checkout, and from a registry install
  the consuming project's own root under npm's flat layout or a directory inside
  `node_modules/.pnpm/` under pnpm's. It is a position rather than a named package —
  whatever sits four segments up, including the unscoped `node_modules/rayspec` launcher
  directory itself under npm's nested layout — deduplicated to one
  read when they are the same file. Neither file
  overrides a variable the environment already sets, and the second never overwrites a key
  the first supplied, so the precedence per key is: environment > `$PWD/.env` >
  install-root `.env`. `RAYSPEC_SKIP_DOTENV=1` skips both. `rayspec deploy` applies the
  same two rules in the same order, so the two entrypoints **started in the same directory**
  read the same `./.env`. The first path is `$PWD`-relative, so that directory is what they
  have to share: a `rayspec-serve` started elsewhere — a unit file's `WorkingDirectory=`, a
  container's `WORKDIR` — reads that directory's `./.env` instead. The **install-root**
  candidate is resolved per package, from each loader's own module, so it is the same file
  only where the two packages sit under one root: in a checkout, and under npm's flat
  layout. Under pnpm each resolves inside its own
  `node_modules/.pnpm/@rayspec+cli@<version>/` and `…/@rayspec+server@<version>/`
  directory, so an install-root `.env` placed for one entrypoint is not read by the other.
  Where both entrypoints
  must agree regardless, set the variables in the environment: an already-set value beats
  either file.
- On boot it **applies the committed platform migration chain** to the target
  database (idempotent — it bootstraps a clean database and no-ops on an up-to-date
  one), then materializes a spec's declared stores on a clean database or mounts them
  when they already match. It does **not** auto-apply a store **schema change**: a
  live product schema that has drifted from the spec **fails closed** — reconcile it
  with a reviewed forward migration
  ([`rayspec deploy --apply-migration`](#deploy--boot-and-serve-a-declared-product),
  or the equivalent `RAYSPEC_UPDATE_MIGRATION` environment variable).
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
  set for you, except that `deploy` seals the product-store registrar once its boot
  returns and defaults the agent trace export **off**, neither of which
  `rayspec-serve` does; see
  [getting-started](./getting-started.md#serving-your-declared-backend).)
- A **frontend-only** spec — one that declares only a `frontend` (no `stores`,
  `api`, `agents`, `tooling`, `triggers`, `handlers`, or `extensions`, no
  durable worker and no enabled event bus) — boots as a **static profile**: it
  requires **none** of the three boot secrets and mounts **no** auth / OIDC / run
  route (`/health` runs no
  database probe; it reports the declared mounts' readiness as `frontend`). It emits
  its own `Content-Security-Policy`
  and `Permissions-Policy` response headers, read from `RAYSPEC_FRONTEND_CSP` and
  `RAYSPEC_PERMISSIONS_POLICY` (each with a secure default when unset), so a built
  single-page app can be served directly with no reverse proxy in front — the same two
  headers a full-backend boot stamps on the responses its own `frontend` mounts serve,
  from the same two variables. The CSP default is
  `default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'` — it names
  no `style-src` and no `script-src`, so a served page's CSS and JS belong in files, not
  inline, and an override replaces that whole baseline verbatim rather than adding to it — see
  [getting-started → a frontend-only (static) deployment](./getting-started.md#a-frontend-only-static-deployment).

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
