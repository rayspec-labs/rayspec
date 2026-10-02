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
[below](#the---help-flag)) — and uses this exit-code contract:

| Exit | Meaning                                                                 |
| ---- | ---------------------------------------------------------------------- |
| `0`  | Success — the spec is valid / the plan passed / the action succeeded.  |
| `1`  | A not-ok result — an invalid spec, a blocked migration, a failed op. The JSON result explains why (in its `errors` / findings). |
| `2`  | A usage/CLI error — an empty argument list, an unknown subcommand, or an unknown/invalid flag (including a missing or invalid required flag or path for `gen-handler`, `tenant` and `dev`). A short JSON error is written to **stderr** and the usage text is printed. The bundle verbs also use `2` for an archive, manifest or inventory they refuse, and `pack` for an application it cannot package or an output that exists. |
| `3`  | Incompatible — a bundle pins another runtime, a target or a capability this runtime does not provide, or an application declares a `@rayspec/*` range that excludes the runtime it pins; for `export`, state a snapshot cannot carry (a second organization, an unknown table, no database write barrier); for `import`, a snapshot of another runtime or server major, or a dump with a second organization. Bundle verbs, `pack`, `deploy <file.ray>`, `export` and `import` only. |
| `4`  | Policy refusal — a reserved binding name, a secret in a bundle, a signature that does not verify, a fence epoch that is not the held one, a dump the import allowlist refuses, an import target that is not empty. Bundle verbs, `pack`, `deploy <file.ray>`, `export`, `import` and `resume` only. |
| `5`  | Retryable — a database that cannot be reached, a lock another operation holds, a source that did not drain before the deadline. `deploy <file.ray>`, `export`, `import` and `resume` only. |
| `6`  | Interrupted by SIGINT or SIGTERM before the command finished, or blocked until reconciled (schema drift, a failed restore). Bundle verbs, `pack`, `deploy <file.ray>`, `export` and `import` only. |
| `7`  | An unexpected internal failure (a defect, not a verdict). A short JSON error is written to **stderr**. |

The existing commands keep `0`, `1` and `2` for every outcome they have; only
an unexpected internal failure changed, from `2` to `7`. A bundle verb or
`pack` that fails several checks exits with the class that comes first in the
order 7, 6, 4, 3, 2, 1, 5.

A bad, missing, or out-of-jail **spec path** given to `doctor`, `plan`, or
`openapi` is *not* a usage error — it is caught and returned as an `ok: false`
result on **stdout** (exit `1`), the same channel as an invalid spec.

The commands split into these groups:

- A **read-only diagnostic floor** — `doctor`, `plan`, `openapi`, `gen-handler`.
  These never mutate a real/target database and never print secret values.
- The **passive `bundle` group** — `bundle inspect`, `bundle verify`. They read
  a `.ray` application bundle and never extract, import or run anything from it,
  and write nothing. They answer with the result envelope described under
  [`--json`](#the---json-flag).
- **`pack`** writes one `.ray` application bundle from an application that is
  already built. It builds, imports and runs nothing, and writes nothing but its
  output file. It answers with the result envelope too.
- **`export`**, **`import`** and **`resume`** move a self-hosted deployment:
  `export` fences it and writes its complete snapshot, encrypted, as a migration
  bundle; `import` restores that bundle into a new, empty target and leaves it
  fenced until its one-time cutover token releases it; `resume` releases an
  export's fence. All three answer with the
  result envelope. See [Exporting a deployment](./export.md) and
  [Importing a deployment](./import.md).
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

### The `--json` flag

`--json` is accepted by every command, anywhere before a `--` terminator. It
switches the answer to the **result envelope**, one JSON object on stdout:

```json
{
  "contractVersion": "1.0.0-draft.2",
  "ok": false,
  "operation": "doctor",
  "operationId": "3f0c2a8e-9b1d-4c47-8e2a-5d7f6b1c9a04",
  "data": { "ok": false, "errors": [{ "code": "unknown_field", "message": "…", "path": "bogus" }], "warnings": [] },
  "errors": [{ "code": "SPEC_UNKNOWN_FIELD", "message": "…", "path": "bogus", "retryable": false }],
  "warnings": [{ "code": "RAY_W_LEGACY_OUTPUT", "message": "this command reports its own result object in data" }]
}
```

- `ok` is `true` exactly when `errors` is empty; `errors[0]` is the first check
  that failed.
- `operationId` is a fresh random UUID for each invocation. It is also printed
  as the first line on **stderr** (`operationId: <uuid>`), so a saved envelope
  and the stderr log of the same run can be matched.
- On an existing command, `data` is the command's own result object, unchanged,
  and the warning `RAY_W_LEGACY_OUTPUT` says so. A spec error appears in
  `errors` as `SPEC_` plus its code in upper case (`unknown_field` becomes
  `SPEC_UNKNOWN_FIELD`); any other error of the result becomes
  `RAY_CHECK_FAILED` with its message. A usage error is `RAY_USAGE` (exit `2`)
  with `data: null`, and the usage text is not printed. The exit code is the one
  the command has without the flag. `--help` and `--version` put their text or
  object in `data`.
- A serving `deploy` with `--json` prints its banners on stderr instead and
  writes its one envelope when it stops: `ok: true` after a SIGINT/SIGTERM
  shutdown (exit `0`), `ok: false` with the refusal as `RAY_CHECK_FAILED` when
  the boot is refused (exit `1`).
- Without `--json`, every existing command's output is what it has always been.
- The bundle verbs and `pack` always answer with the envelope; for them the
  flag only silences the short description (for `pack`, the inclusion summary)
  they otherwise print on stderr.

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

  On failure, each entry carries a closed `code`, a `message`, and an optional
  `path`:

  ```json
  { "ok": false, "errors": [{ "code": "unknown_field", "message": "…", "path": "stores[0].colums" }], "warnings": [] }
  ```

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

## `pack`

```
rayspec pack --spec <path> --output <file.ray> [--id <application-id>] [--version <semver>]
             [--runtime <exact-version>] [--include <path>]... [--against <old-spec>
             [--allowlist <file.json>]] [--source-maps] [--preview] [--force] [--json]
```

Writes an application bundle (`.ray`) from an application that is **already
built**: the spec, the compiled handler and extension modules with everything
they import, the built frontend directories, the product configuration files,
the third-party packages the modules need, the dependency lock, a CycloneDX SBOM
(`payload/sbom.cdx.json`) and the license notices
(`payload/THIRD-PARTY-NOTICES.txt`). What goes in, what never does and how to fix
each refusal are in the [packing guide](./packing.md).

It runs these steps in order and stops at the first failure:

1. **Arguments.** `RAY_USAGE`; `--allowlist` without `--against` too.
   With `--against <old-spec>`, the product delta comes next: the previous spec
   must parse (`RAY_SPEC_INVALID`) and be of the same profile, the delta from its
   stores to the new spec's is generated as `plan --against` generates it, a
   destructive statement the `--allowlist` file does not clear is refused naming
   the store and column and the review step, and the product schema digests the
   delta migrates between are computed on a throwaway database on the server
   `SHADOW_DATABASE_URL` names (missing or unusable: `RAY_USAGE`, never naming the
   server). Each of these refusals is `RAY_USAGE`.
2. **Spec.** The spec (either profile) is parsed. `RAY_SPEC_INVALID`, followed
   by each grammar error as a `SPEC_` code.
3. **Identity.** `metadata.id` and `metadata.version` of a backend spec, or
   `product.metadata.id` and `product.metadata.version` of a product spec;
   `--id` and `--version` override them. Neither the name nor the runtime
   version is ever used instead. `RAY_APPLICATION_IDENTITY_MISSING` with reason
   `id` or `version`.
4. **Closure.** The inclusion list is built from what the spec names, never from
   the directory as a whole, and every path stays inside the directory of the
   spec. `@rayspec/*` packages are never copied: the runtime provides them, and a
   declared range that excludes the pinned runtime is `RAY_RUNTIME_UNSUPPORTED`.
   A missing or uncompiled module (with the build instruction in the message), an
   unresolved or computed import, a shared peer dependency that would need two
   copies, a symbolic or hard link, an explicitly named excluded file, a native
   addon not built for linux/x64 and Node 22, a package binary or `os`/`cpu`
   field for another platform, or a source map (a file or inlined) without
   `--source-maps` is `RAY_CLOSURE_INVALID` with reason `unresolved-import`,
   `escaping-link`, `excluded-file`, `native-module` or
   `source-map-not-opted-in`.
5. **Secret scan.** A private key or a secret file name in any file that would
   go in. `RAY_SECRET_DETECTED`, naming the path and never the content.
6. **Manifest.** The bundle must stay within the entry, path and size limits
   (`RAY_LIMIT_EXCEEDED`), and no binding name it declares may be reserved for the
   operator (`RAY_BINDING_RESERVED`).
7. **Write.** An existing output is `RAY_OUTPUT_EXISTS` unless `--force` is
   given; a directory as the output, or an output directory that does not exist,
   is `RAY_USAGE`. The archive is written to a temporary file in the directory of
   the output, synced, read back through the bundle reader, compared file by file
   with the digests the closure was checked under (a file rewritten in between is
   `RAY_USAGE`), and only then linked to the output path, or renamed over it with
   `--force`. A refused or interrupted pack leaves neither the output nor a
   temporary file.

- **Postgres:** not needed, except with `--against`, which creates and drops one
  throwaway database on the server `SHADOW_DATABASE_URL` names. **Environment:**
  `SHADOW_DATABASE_URL` with `--against`, nothing otherwise; no `.env` is loaded.
- **Runs nothing.** Handlers, extensions and frontends must be built first; pack
  reads modules with a lexer and never imports, evaluates or installs anything.
  `--build`, which would run the build in a disposable sandbox, is not available
  yet: it is refused with `RAY_USAGE` naming the manual build step, and it is not
  listed in `--help`.
- **Product delta.** `--against <old-spec>` carries, under `payload/migrations/`,
  the delta from the stores of the spec the environment runs to this spec's, the
  `--allowlist` file byte for byte, and in the manifest's `productMigration` the
  product schema digests before and after it and whether it is destructive. The
  target regenerates the delta from its product migration ledger and refuses any
  difference; see the [packing guide](./packing.md#a-product-schema-change).
- **Deterministic.** The same prepared files and flags give the same bytes,
  wherever and whenever they are packed. Bundle paths are relative to the
  directory of the spec, and the archive carries no timestamp, user, host or
  absolute path.
- **Flags:** `--spec <path>` and `--output <file.ray>`, both required (with
  `--preview` too, although nothing is written then); `--id <application-id>`
  (a lowercase letter, then up to 62 lowercase letters, digits or hyphens);
  `--version <semver>` (exact, no build metadata); `--runtime <exact-version>`
  (default: this CLI's version); `--include <path>`, repeatable, a file or
  directory relative to the spec; `--source-maps` (carry `*.map` files and
  scripts or style sheets that inline their source map); `--against <old-spec>`
  (the spec the target environment runs); `--allowlist <file.json>` (the
  reviewed allowlist, with `--against` only); `--preview`;
  `--force`; `--json`.
- **Output:** the result envelope on stdout (operation `pack`), with or without
  `--json`:

  ```json
  {
    "contractVersion": "1.0.0-draft.2",
    "ok": true,
    "operation": "pack",
    "operationId": "…",
    "data": {
      "outputPath": "/home/me/notes-1.4.0.ray",
      "preview": false,
      "sha256": "…",
      "size": 3874,
      "applicationId": "notes",
      "applicationVersion": "1.4.0",
      "runtimeVersion": "1.8.0",
      "target": { "os": "linux", "arch": "x64", "nodeMajor": 22 },
      "requires": ["declarative-api", "declarative-stores", "static-frontend"],
      "bindings": [],
      "execution": "none",
      "egressHosts": [],
      "inclusion": [
        { "path": "payload/THIRD-PARTY-NOTICES.txt", "size": 192, "sha256": "…", "source": "generated" },
        { "path": "payload/rayspec.yaml", "size": 431, "sha256": "…", "source": "rayspec.yaml" },
        { "path": "payload/sbom.cdx.json", "size": 203, "sha256": "…", "source": "generated" },
        { "path": "payload/web/dist/index.html", "size": 612, "sha256": "…", "source": "web/dist/index.html" }
      ]
    },
    "errors": [],
    "warnings": []
  }
  ```

  `outputPath` is the absolute path written. With `--preview`, `preview` is
  `true` and `outputPath`, `sha256` and `size` are `null`. On a refusal `ok` is
  `false` and `data` is `null`. `bindings` lists names, kinds and requiredness,
  never values. A spec that uses an agent backend but declares no egress hosts
  gets the warning `RAY_W_EGRESS_UNDECLARED`. On stderr: the operation id and,
  without `--json`, the inclusion summary — application, runtime and target,
  capabilities, binding names, execution level, egress hosts, file count and
  bytes, what was left out and why, warnings, and the output path and SHA-256
  (`--preview` also lists every file). The summary says that nothing was
  deployed; check the bundle with [`bundle verify`](#bundle-verify).
- **Exit:** `0` written (or previewed), `1` spec invalid, `2` usage, identity,
  closure, limit or an existing output, `3` a `@rayspec/*` range that excludes
  the pinned runtime, `4` a secret or a reserved binding name, `6` interrupted,
  `7` internal error.

---

## `bundle inspect`

```
rayspec bundle inspect <file.ray> [--json]
```

Reads a `.ray` application or migration bundle and reports what it is. It runs
the structural checks of the bundle reader, in order, and stops at the first
failure: the archive size, the ZIP container (the strict profile: stored entries,
fixed header values, no ZIP64, comments, extra fields or data descriptors, and
names that cannot escape the payload or collide), the `ray.json` manifest (its
bytes, schema and semantics), and every entry streamed against the manifest's
inventory (size, CRC-32 and SHA-256, under the extracted-byte limit). It does
**not** check the runtime, target, capabilities, spec or signature — that is
`bundle verify`.

- **Postgres:** not needed. **Environment:** none read (no `.env` is loaded).
- **Passive:** nothing in the archive is extracted, imported, evaluated or run,
  and nothing is written anywhere. A read has a wall-time budget of five minutes.
- **Flags:** `--json` only; exactly one positional archive path. A path that
  is missing or is not a regular file (a directory, a device, a FIFO) is
  `RAY_USAGE`; a FIFO is refused at once, never waited on.
- **Output:** the result envelope on stdout (operation `bundle.inspect`), with
  or without `--json`:

  ```json
  {
    "contractVersion": "1.0.0-draft.2",
    "ok": true,
    "operation": "bundle.inspect",
    "operationId": "…",
    "data": {
      "sha256": "20331da54f5c5b0911e1d9fe6dc4732b6ebd28448930d845b6a84e0188a9d194",
      "size": 1807,
      "entries": 5,
      "kind": "application",
      "applicationId": "format-fixture",
      "applicationVersion": "0.0.0-contract-fixture",
      "runtimeVersion": "0.0.0-contract-fixture",
      "target": { "arch": "x64", "nodeMajor": 22, "os": "linux" },
      "requires": ["static-frontend"],
      "bindings": [],
      "execution": "none",
      "egressHosts": [],
      "signature": { "present": false, "verified": false, "publicKeySha256": null },
      "verdict": "structurally-valid"
    },
    "errors": [],
    "warnings": []
  }
  ```

  `bindings` lists names, kinds and requiredness, never a value or a
  description. `signature.present` says whether a `<file.ray>.sig` lies next to
  the archive; inspect does not check it. On a refused archive `ok` is `false`,
  `data` is `null`, and `errors[0]` carries the code and reason, for example
  `RAY_INVALID_ARCHIVE` / `dot-segment`. A message never repeats a name or any
  other content from the archive. On stderr: the operation id and, without
  `--json`, a short description of the bundle — what it is and which checks
  passed, never a claim that its code is safe to run.
- **Exit:** `0` structurally valid, `2` a refused archive, manifest or
  inventory (or a usage error), `6` interrupted, `7` internal error.

---

## `bundle verify`

```
rayspec bundle verify <file.ray> [--runtime <exact-version>] [--signature <file.ray.sig>]
                      [--trusted-key <ed25519-public-key.pem>]... [--require-signature] [--json]
```

Everything `bundle inspect` checks, then whether this runtime can deploy the
bundle, in this order, stopping at the first failure:

1. **Runtime.** The version the bundle pins equals the runtime checked against
   exactly: this CLI's own version, or the one `--runtime` names
   (`MAJOR.MINOR.PATCH` with an optional pre-release; a range, `latest` or build
   metadata is a usage error). `RAY_RUNTIME_UNSUPPORTED`.
2. **Target.** The runtime supports `linux` / `x64` / Node 22 only.
   `RAY_TARGET_UNSUPPORTED`.
3. **Capabilities**, in the order the bundle lists them: an id the capability
   vocabulary does not know (`unknown-id`), an id this runtime does not provide
   (`not-provided`), then the execution level (`execution-level`; no runtime
   provides `sandboxed`). `RAY_CAPABILITY_UNSUPPORTED`.
4. **Reserved bindings.** A binding name reserved for the operator.
   `RAY_BINDING_RESERVED`.
5. **Spec.** The spec file the manifest names is parsed from the archive (never
   run). `RAY_SPEC_INVALID`, followed by each grammar error as a `SPEC_` code
   with its path. The message of each names the rule and, for a YAML error, the
   line and column; it never quotes the spec, whose text may hold a secret.
6. **Derived fields.** `requires`, the execution level and the egress hosts
   must be exactly what the spec derives: the capability ids its sections use,
   in code-point order; `in-process` when it declares handlers or extensions,
   else `none`; and the egress hosts it declares (backend `deployment.egressHosts`,
   product `deployment_overrides.egress_hosts`), compared as a set, so a manifest
   that lists one more or one fewer is refused. `RAY_MANIFEST_INVALID` with reason
   `requires-mismatch`, `execution-mismatch` or `permissions-mismatch`.
7. **Secret scan.** A payload file named `.env`, `.env.*`, `id_rsa`,
   `id_ecdsa`, `id_ed25519` or `.pgpass`, or one that contains a PEM private-key
   header (`-----BEGIN `, words of uppercase letters and digits such as `RSA` or
   `X25519`, then `PRIVATE KEY-----`). `RAY_SECRET_DETECTED`, naming the path and
   never the content.
8. **Signature.** When `--signature` names a file, or `<file.ray>.sig` lies next
   to the archive: the file must be a signature document for this archive's
   SHA-256, name one of the `--trusted-key` public keys, and verify with it.
   `RAY_SIGNATURE_INVALID` with reason `malformed`, `mismatch` or
   `untrusted-key` (a signed bundle checked with no trusted key is
   `untrusted-key`). With no signature, `--require-signature` refuses the bundle
   (`malformed`); otherwise it passes with the warning `RAY_W_UNSIGNED`.

A migration bundle gets the runtime, target and signature checks after the
structural checks (so `--require-signature` and `RAY_W_UNSIGNED` apply to it
too), but no capability, binding, spec or secret checks: its contents are
encrypted and are not read.

- **Postgres:** not needed. **Environment:** none read.
- **Passive:** as for inspect — nothing is extracted, imported or run, and
  nothing is written.
- **Flags:** `--runtime <exact-version>` (default: this CLI's version);
  `--signature <file.ray.sig>` (default: `<file.ray>.sig` when present);
  `--trusted-key <ed25519-public-key.pem>`, repeatable — a PEM public key; a
  private key, an unreadable file, one that is not a regular file, one over
  16 KiB or a non-Ed25519 key is a usage error;
  `--require-signature`; `--json`.
- **Output:** the result envelope (operation `bundle.verify`):

  ```json
  {
    "contractVersion": "1.0.0-draft.2",
    "ok": true,
    "operation": "bundle.verify",
    "operationId": "…",
    "data": {
      "sha256": "20331da54f5c5b0911e1d9fe6dc4732b6ebd28448930d845b6a84e0188a9d194",
      "kind": "application",
      "applicationId": "format-fixture",
      "applicationVersion": "0.0.0-contract-fixture",
      "runtimeVersion": "0.0.0-contract-fixture",
      "checkedAgainstRuntime": "0.0.0-contract-fixture",
      "signature": { "present": false, "verified": false, "publicKeySha256": null },
      "verdict": "deployable"
    },
    "errors": [],
    "warnings": [{ "code": "RAY_W_UNSIGNED", "message": "the bundle has no detached signature, so its origin is not established" }]
  }
  ```

  A failure after the structural checks keeps `data`, with `verdict`
  `not-deployable`; a structural failure has `data: null`. A verified signature
  reports the SHA-256 of the trusted key it verified with. `deployable` means
  every check above passed for this runtime; it establishes where the bundle
  came from only when a trusted signature verified, and it never vouches for
  the code the bundle carries.
- **Exit:** `0` deployable, `1` spec invalid, `2` a refused archive, manifest
  or derived field (or a usage error), `3` runtime, target or capability, `4`
  reserved binding, secret or signature, `6` interrupted, `7` internal error.

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
- **Single-tenant mode:** with `RAYSPEC_SINGLE_TENANT=true` (the setting the
  server reads) the command still resolves the one organization idempotently, but
  refuses to create a second one with `SINGLE_TENANT_LIMIT` and writes nothing.
  See [Hosting in the hardened posture](./hardened-posture.md).
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
  not be applied — that one reports `MIGRATION_FAILED` and creates nothing, and
  one that waited longer than 60 seconds for the shared schema lock a booting
  server or another migration held reports `SCHEMA_LOCK_TIMEOUT`, creates
  nothing and can simply be run again; on an environment quiesced by the
  runtime's source fence it reports `ENVIRONMENT_FENCED` and creates, resolves
  and migrates nothing until the fence is released; a migration chain the
  runtime refused for another reason reports `MIGRATION_REFUSED`; a second
  organization under single-tenant mode reports `SINGLE_TENANT_LIMIT`); `2` on a
  usage error.

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

## `tenant recover-owner`

```
rayspec tenant recover-owner --email <address> [--org-id <uuid>] [--ttl-seconds <n>]
```

Issues a **one-time owner-recovery token** for an active owner who holds **no password** — an owner
whose only credential was an API key, which a new API-key pepper breaks (after an
[import](./import.md#owner-recovery), for example). The owner redeems it once over HTTP, sets a
password and is signed in. The operator's authority is the database and the deployment's pepper;
no running server is needed to issue, and the command mounts no route.

- **Postgres:** yes, directly — `RAYSPEC_MIGRATION_DATABASE_URL` when set, else `DATABASE_URL`. It
  runs no migration.
- **Secrets:** `DATABASE_URL` and `RAYSPEC_API_KEY_PEPPER`, each also honouring its `<VAR>_FILE`
  variant. The pepper must be the **one the deployment runs with**: the token is stored as its HMAC
  under it, and a token hashed under another pepper never redeems.
- **What it writes,** in one transaction: one `owner_recovery_tokens` row (the HMAC, the owner, the
  expiry), the replacement of any token still outstanding for that owner, and an
  `owner_recovery_issued` row in `auth_audit` (who and until when, not the token).
- **Refusals** (`ok: false`, exit 1, nothing written): `NO_SUCH_OWNER` (no active owner with that
  address), `AMBIGUOUS_ORGANIZATION` (the account owns more than one; pass `--org-id`),
  `PASSWORD_PRESENT` (the owner signs in with their password), `ENVIRONMENT_FENCED` (an exported
  source, or an import target before its cutover), `INVALID_EMAIL`, `SECRETS_MISSING`,
  `RECOVERY_FAILED` (the database could not be reached).
- **Flags:**
  - `--email <address>` — **required**. The owner to recover.
  - `--org-id <uuid>` — the organization, when the account owns more than one.
  - `--ttl-seconds <n>` — the token's lifetime; default 1800 (30 minutes), clamped to 5 minutes – 24
    hours.
- **Output:** ONE JSON object on stdout, the **only** place the token ever appears:

  ```json
  {
    "ok": true,
    "command": "tenant recover-owner",
    "orgId": "…",
    "userId": "…",
    "recoveryId": "…",
    "expiresAt": "2026-10-01T10:30:00.000Z",
    "replaced": 0,
    "recoveryToken": "…",
    "redeemPath": "/v1/auth/owner-recovery",
    "errors": []
  }
  ```

  Do not capture it in a log; hand the token to the owner over a channel you trust. `--json` is not
  available for this command (the result envelope has no operation for it): with `--json` it refuses
  with exit 2 and prints nothing on stdout.
- **Redeeming:** `POST /v1/auth/owner-recovery` with `{"token": "…", "password": "…"}` (and
  `deliverRefreshTokenInBody` as for login). Unauthenticated and rate-limited per source
  (`owner-recovery`, 10 a minute). One transaction checks the token is unexpired, unused and not
  replaced and that the account is still an active owner without a password, consumes it, sets the
  password and ends any session the account had; the answer is a signed-in owner
  (`{accessToken, tokenType, expiresIn, activeOrgId, userId, role: "owner"}`, the refresh secret in the
  cookie). Every token that does not redeem — unknown, expired, used, replaced — answers the same
  `400`. The redemption is audited as `owner_recovery_redeemed` and the session's `login`.
- **Exit:** `0` issued, `1` refused, `2` usage.

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

A file that starts with a ZIP signature or whose name ends in `.ray` is an application bundle
and takes the bundle path instead — see [Deploying a bundle](#deploying-a-bundle) below. The check
reads at most four bytes, before any configuration is loaded; every other file is a spec and is
deployed exactly as described here.

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
  `dangling_ref`, an unknown key) — the same errors `doctor` reports for it.

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
  extension** — running extension code is what would break that promise — so every
  demand an extension changes is invisible here. It runs in **both** directions: an
  extension-supplied blob backend *removes* the `RAYSPEC_BLOB_ROOT` demand, while an
  extension-contributed `api` route *adds* the `RAYSPEC_BLOB_ROOT` demand (any
  `kind: stream`) and the `RAYSPEC_MEDIA_SIGNING_KEY` demand (`mode: playback`), and a
  extension-contributed agent *adds* its backend's credential demand. The boot guards ask
  their questions of the **post-merge** document; this reads the base one — so a
  document whose whole route surface arrives from an extension (the
  [`stream-backend` example](../examples/stream-backend/rayspec.yaml) is exactly that
  shape) reports the three unconditional secrets and nothing more. To keep that from
  reading as a clean bill of health, the verdict **names the extensions the document
  declares** — parsed off `extensions[]`, never loaded. A set `<VAR>_FILE` mount counts
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
  the boot classifies the live schema first and mounts a present-matching schema
  instead of re-applying a non-idempotent delta, so a `Restart=always` unit applies the
  delta once and mounts thereafter (still, drop the flag once it lands to keep intent
  explicit). It is rejected with `--dry-run` (a dry-run touches no database) and against a
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
  message and exits `1`. Every schema change the boot makes runs as a
  `runtime.apply` operation with receipts, and a refusal of one exits with its
  contract class: `3` a plan made stale by a concurrent change, `4` a fenced
  environment, `5` another operation holding the lease past the wait, `6` an
  interrupted earlier apply that needs manual reconciliation. See
  [Runtime operations](./runtime-operations.md).
- **Profiles — declaration vs. custom code.** `deploy` runs a **product-profile**
  document (like `examples/acme-notes/acme-notes.product.yaml`) directly — it is
  pure declaration with no custom code and no build step. A **backend-profile**
  document may ship custom escape-hatch handler modules (and an extension is
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
  and `examples/stream-backend` compiles its extension. An **extension** additionally
  resolves `@rayspec/platform` at load starting from its own compiled entry's location, so
  ship the extension directory to the deploy target with its installed `node_modules` —
  that is what pins the platform build it runs against. An application bundle written by
  [`pack`](#pack) is the exception: it leaves `@rayspec/*` out of the extension's files,
  because the runtime that deploys the bundle provides them. See
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

### Deploying a bundle

```
rayspec deploy <file.ray> --dry-run [--bindings-file <file>] [--state-dir <dir>]
               [--trusted-key <ed25519-public-key.pem>]... [--require-signature] [--json]
rayspec deploy <file.ray> [--bindings-file <file>] [--plan-digest <sha256>] [--state-dir <dir>]
               [--port <n>] [--host <addr>] [--trusted-key <ed25519-public-key.pem>]...
               [--require-signature] [--json]
```

**Production-mutating** (without `--dry-run`). Deploys an application bundle written by
[`pack`](#pack) on an explicitly configured self-hosted target and serves it. The walkthrough —
inspect, bind, review, apply, readiness, update, recovery — is
[Deploying a bundle on your own server](./self-hosted-deployment.md).

- **Configuration comes from the explicit process environment only.** No `.env` file is loaded on
  this path, whatever `RAYSPEC_SKIP_DOTENV` says. `DATABASE_URL` and `RAYSPEC_API_KEY_PEPPER` (or
  their `_FILE` variants) are required for a dry-run; a deploy also needs everything the boot
  needs (`RAYSPEC_JWT_SIGNING_KEY`, …). `SHADOW_DATABASE_URL` names the server where a plan with a
  schema change computes the head after it, on a throwaway database. A missing variable is refused
  with `RAY_USAGE`, naming it.
- **`--bindings-file <file>`** — the application's binding values, JSON
  `{"bindingsFormatVersion": 1, "bindings": [{"name", "value"}]}`. A regular file, not a link,
  owned by you, mode 0600 or stricter (`RAY_BINDINGS_FILE_INSECURE` otherwise); a reserved operator
  name (`DATABASE_URL`, `RAYSPEC_…`, `NODE_…`, a provider key's `_FILE` variant, …) is refused with
  `RAY_BINDING_RESERVED`. A name the bundle does not declare is refused with `RAY_USAGE`, except
  the key of the speech provider the operator selected (`DEEPGRAM_API_KEY` with
  `STT_PROVIDER=deepgram`, `OPENAI_API_KEY` with `TTS_PROVIDER=openai`); so is a provider key the
  environment also names a `_FILE` for. Bindings come only from this file and the process
  environment (a provider key also from its `<NAME>_FILE`). No value is put into the process
  environment: provider keys go to the adapters that use them, the application's own names to its
  handlers as `init.bindings`. Values never appear in output, logs, plans or receipts; plans carry
  revision ids.
- **`--dry-run`** — plan only: the bundle is read and verified by the one bundle reader (nothing is
  extracted or run), then planned against the live database. Prints the plan — required bindings,
  schema impact, permission changes, storage, blockers, warnings — with `planDigest`, `preparedAt`
  and `expiresAt` (30 minutes later), and writes the plan record `<state-dir>/plans/<planDigest>.json`.
  No SQL changes anything. A plan with blockers is still `ok: true`; the deploy refuses it.
- **`--plan-digest <sha256>`** — the plan to deploy, as a dry-run printed it. Required when the plan
  changes the schema or the grants (a first deploy always does). The plan is recomputed at its own
  `preparedAt`; a missing record, another bundle, an expired plan or any covered input that changed
  since (a binding value, the schema, the environment revision) is `RAY_PLAN_STALE`.
- **`--state-dir <dir>`** — the deployment state directory (default `.rayspec-state`): mode 0700,
  owned by you, holding one deployment — `deployment.json`, `active.json`, the read-only version
  directories `versions/<bundleSha256>/` and the plan records.
- **`--trusted-key`**, **`--require-signature`** — as for [`bundle verify`](#bundle-verify): an
  unsigned bundle is accepted with `RAY_W_UNSIGNED` unless a signature is required.
- **`--port`**, **`--host`** — where the deployment serves, as for a spec deploy.

**Order.** Nothing opens the database until the arguments, the bindings file, the trusted keys, the
state directory, the bundle (every reader check) and the bindings file's names have been checked.
Nothing changes the database until the plan is accepted and the boot has validated the signing key,
the spec and the rest of its preflight. The bundle is extracted into its version directory and
verified before the boot; the apply then runs the platform chain, the product change and the
switch of `active.json`, each with a receipt, under the operation lease and the shared schema lock.
A deploy that fails leaves the previous version active and reverses no schema change; the refusal
says how to finish it. The application is served from the active version directory, with
`@rayspec/*` resolved from the installed runtime and every other package from the bundle.

**Output.** One result envelope on stdout, with or without `--json`: `deploy.dry-run` with
`{bundleSha256, plan, planDigest, environmentRevision, preparedAt, expiresAt, planRecordPath}`, or
`deploy` with `{bundleSha256, deploymentId, planDigest, environmentRevision, status}` —
written when the deploy refuses (`status: refused`) or, once it serves, when it stops
(`status: stopped`). The operation id, the boot banner and, without `--json`, a summary of the plan
go to stderr, and so does anything else printed while the deploy runs (the durable runtime's
startup lines, a handler's `console.log`), so stdout holds the one envelope. After a deploy that
changed the product schema the banner's `Product DB` line names the product migration ledger row
that change wrote. A `.ray` path that cannot be opened is refused as `RAY_USAGE`, in the words
`rayspec bundle verify` uses.

**Exit codes.** `0` a dry-run that planned, or a deployment that stopped on `SIGINT`/`SIGTERM` ·
`1` the boot refused its configuration after the plan was accepted (`RAY_CHECK_FAILED`, with the
boot's message; nothing was applied) · `2` usage, an invalid archive, a digest mismatch or a missing binding · `3` runtime, target or
capability not supported, a stale plan, a schema change the plan does not approve · `4` a
signature, reserved binding, insecure file or policy refusal · `5` the environment is busy
(`RAY_LOCK_TIMEOUT`) or the database is unavailable (both retryable) · `6` drift, an interrupted
deploy, or reconciliation required · `7` an internal error.

---

## `export`

```
rayspec export --deployment <id> --recipient <age1...> --output <migration.ray>
               --run-history <included|excluded> [--confirm-quiesce] [--source-stopped]
               [--quiesce-deadline <seconds>] [--state-dir <dir>] [--json]
```

Writes the deployment's complete snapshot — the deployed application, the application database,
the workflow system database (whole, when it exists) and every blob — as one migration bundle
encrypted with age to the X25519 recipient, and leaves the source **fenced**. The operator guide is
[Exporting a deployment](./export.md).

- **Order.** A read-only precheck of the source; the operator's confirmation of the downtime; the
  fence (`quiesce`: writes, uploads, triggers and the run queue stopped, runs drained) with a
  database write barrier; the capture of both databases and the blobs under that one fence epoch,
  counts and digests verified; encryption in a private scratch directory under the state
  directory; the bundle written to `--output`, read back and linked into place; the scratch
  directory removed. Each step is a transition recorded in the receipts (below).
- **Flags.**
  - `--deployment <id>` (required): the `deploymentId` of the state directory; it must also be the
    one the database records, else `RAY_USAGE`.
  - `--recipient <age1...>` (required): the age X25519 recipient. A passphrase, an identity and the
    post-quantum or tag recipients are refused (`RAY_USAGE`).
  - `--output <file>` (required): refused if it exists (`RAY_OUTPUT_EXISTS`). Written with mode
    0600. Plaintext is never written there or anywhere outside the scratch directory.
  - `--run-history <included|excluded>` (required, no default): whether runs, run events, journals,
    conversation items and workflow runs leave the source.
  - `--confirm-quiesce`: confirms the downtime. Required with `--json` or without a terminal;
    otherwise the plan is printed on the terminal and `yes` is asked for.
  - `--source-stopped`: the operator attests that every runtime process is stopped. The database
    barrier without role separation; the export checks that no other session is connected.
  - `--quiesce-deadline <seconds>`: how long runs in flight are drained (default 300, at most
    86400).
  - `--state-dir <dir>`: the deployment state directory (default `.rayspec-state`).
- **Environment** (explicit, never a `.env` file): `DATABASE_URL` (or `_FILE`),
  `RAYSPEC_MIGRATION_DATABASE_URL` (or `_FILE`; role separation),
  `RAYSPEC_SNAPSHOT_DATABASE_URL` (or `_FILE`; the read-only snapshot role),
  `DBOS_SYSTEM_DATABASE_URL`, `RAYSPEC_BLOB_ROOT`, `RAYSPEC_PG_DUMP` (an absolute path; default the
  first `pg_dump` on `PATH`, which must be of the server's major). No output carries a value.
- **Database barrier.** With role separation the runtime role's writes are revoked until `resume`
  (`database-write-role`); without it, only a stopped source attested with `--source-stopped`
  (`database-stopped-source`). With neither the export fences, then refuses before any capture with
  `RAY_EXTERNAL_STATE_UNSUPPORTED` / `database-barrier-unavailable`; the source stays fenced.
- **Blobs.** The fs blob store under `RAYSPEC_BLOB_ROOT`. For an application that loads
  extensions, the blob backend its boot recorded decides, read from the database and never by
  loading the extensions: a backend an extension provides, or no record for the active version, is
  refused before the fence (`RAY_EXTERNAL_STATE_UNSUPPORTED` / `unsupported-blob-adapter`, naming
  the extension); see [Applications with extensions](./export.md#applications-with-extensions).
- **A second export while fenced** reuses the fence at its epoch.
- **Output:** the result envelope on stdout (operation `export`), with or without `--json`:

  ```json
  {
    "contractVersion": "1.0.0-draft.2",
    "ok": true,
    "operation": "export",
    "operationId": "…",
    "data": {
      "deploymentId": "3f9c0a1b2c3d4e5f",
      "outputPath": "/srv/handover/app-migration.ray",
      "sha256": "…",
      "ciphertextSha256": "…",
      "ciphertextSize": 48213374,
      "fenceEpoch": 4,
      "sourceState": "fenced",
      "excludedDataCategories": ["credential-state", "request-replay-state", "runtime-control-state", "security-audit-log"],
      "recovery": "The source stays fenced at epoch 4 (database barrier database-write-role held, database-stopped-source not-applied, object-writes held; snapshot read as snapshot-role). …"
    },
    "errors": [],
    "warnings": []
  }
  ```

  `recovery` names the barriers that held and did not apply, who the snapshot read as
  (`snapshot-role` or `single-role`), and the `rayspec resume` command. On a refusal `data` is
  `null`; after the fence was taken, `errors[0].message` ends with the resume command. On stderr:
  the operation id, progress lines and, without `--json`, a summary with the counts and the path of
  the local receipt.
- **Receipts.** `<state-dir>/receipts/export-<operationId>.json` (mode 0600, shareable: no secret,
  path, record or table name) and, once the downtime is confirmed (the `PRECHECK` transition is
  written then, before the fence is taken), rows of `runtime_control_receipts` of kind `export` — one
  per transition `PRECHECK`, `QUIESCING`, `FROZEN`, `EXPORTING`, `EXPORTED` or
  `BLOCKED`, each with the fence epoch, time, digests and recovery action.
- **Interruption.** SIGINT or SIGTERM stops the export at its next safe point, ends a running
  `pg_dump`, removes the scratch directory, keeps the fence and reports `RAY_INTERRUPTED` (exit 6). A
  process killed outright leaves its scratch directory, plaintext included, until the next `export`
  or `resume` of the deployment removes it first.
- **Codes.** The contract's list for the verb — `RAY_USAGE`, `RAY_BINDINGS_FILE_INSECURE`,
  `RAY_OUTPUT_EXISTS`, `RAY_MULTI_TENANT_UNSUPPORTED`, `RAY_OWNER_RECOVERY_REQUIRED`,
  `RAY_EXTERNAL_STATE_UNSUPPORTED`, `RAY_SCHEMA_DRIFT`, `RAY_SOURCE_NOT_QUIESCENT`,
  `RAY_LIMIT_EXCEEDED`, `RAY_LOCK_TIMEOUT`, `RAY_INFRA_UNAVAILABLE`, `RAY_INTERRUPTED`,
  `RAY_INTERNAL` — and, from the precheck and the capture, `RAY_POLICY_DENIED`
  (`unsupported-extension`), `RAY_DIGEST_MISMATCH` (`bundle-sha256`, `object-sha256`),
  `RAY_RUNTIME_UNSUPPORTED`, `RAY_TARGET_UNSUPPORTED` and `RAY_FENCE_MISMATCH`.
- **Exit:** `0` exported, `2` usage, an existing output, a limit or a digest, `3` external state,
  tenants, runtime or target, `4` owner recovery, an insecure state directory, policy or another
  epoch, `5` retryable (database, lock, drain deadline), `6` interrupted or schema drift, `7` internal
  error.

---

## `import`

```
rayspec import <migration.ray> --target <state-dir> --identity-file <file> --dry-run [--json]
rayspec import <migration.ray> --target <state-dir> --identity-file <file>
               --secrets-out <new-dir> [--bindings-file <file>] [--json]
rayspec import --target <state-dir> --discard-failed [--json]
rayspec import --target <state-dir> --cutover-token <token> [--json]
rayspec import --target <state-dir> --renew-cutover-token [--json]
```

Restores a migration bundle into a **new, empty** target — two databases and a blob root — as the
target's migration role, verifies it, and leaves it **fenced** until the cutover. The source stays
authoritative throughout. The operator guide is [Importing a deployment](./import.md).

- **Order.** The bundle through the reader (the ciphertext's size and SHA-256 before anything is
  decrypted); decryption with the identity file into a private scratch directory under
  `<target>/scratch/`, within the migration plaintext limit; the inner snapshot through the same
  reader; every clear hint of the bundle (application, runtime, target) against the authenticated
  metadata; the embedded application through the full reader pipeline for this runtime, which must
  be the runtime the snapshot was taken with; each dump's table of contents, read from its bytes,
  compared with `pg_restore --list`, and judged by the restore allowlist; then the target. The dry
  run stops there. The import goes on through `IMPORTING` (the runtime role's default write
  privileges withheld, then both databases restored under the shared schema lock, workflow system
  database first, then the objects), `VERIFYING` and `READY_FOR_CUTOVER`, or `BLOCKED`; the cutover
  (`--cutover-token`) through `CUTOVER` and `COMPLETE`.
- **The restore allowlist.** Restored: schemas (`drizzle` in the application database, `dbos` in the
  workflow system database), tables, sequences, defaults, constraints, foreign keys, indexes,
  triggers, row-level policies, functions in `sql` or `plpgsql`, table data, sequence values. Each
  entry must be exactly the statements its kind consists of. Refused (`RAY_POLICY_DENIED`): any
  extension in the application database and any but `uuid-ossp` in the workflow system database
  (`unsupported-extension`); an object of another owner, or a grant to a role the dump's default
  privileges do not name (`unmapped-owner`); everything else — a role, an event trigger, a view, a
  type, a language, a large object, a function in another language or `SECURITY DEFINER` (beyond
  the platform's two lookups, unchanged), `LEAKPROOF`, a setting other than the search path, data
  loaded by anything but `COPY … FROM stdin`, a call into the dump or a server function (SQL from
  text, files, large objects, advisory locks, notifications) from an expression the restore
  evaluates, an entry outside the section `pg_dump` puts its kind in, a Unicode-escape name or
  string (`U&"…"`, `U&'…'`, `UESCAPE`), a function search path not written as quoted names
  (`privileged-statement`). The
  restore list runs pre-data, data and post-data in that order whatever the archive's order, so no
  trigger of the dump exists while rows are copied in. Privileges, comments and the dump's owner are
  not restored: every object belongs to the target's migration role, and the target's runtime and
  snapshot roles get the grants the database roles setup gives — the runtime role's writes only at
  the cutover.
- **The catalogs.** After each restore, after the import's own writes and before the cutover, both
  databases must hold exactly what the restore plan creates: the plan's extensions, schemas,
  functions and triggers (plus the ones the import adds), each function with the language, security
  mode, search path and body its dump entry gives it, no view, type, rule, operator, text search
  object, publication or large object, no privilege for a role the target does not grant to, and
  default privileges and role settings unchanged (`RAY_POLICY_DENIED` `privileged-statement`).
- **The target** must be empty — no table, sequence, function, type, schema besides `public`,
  extension or large object in either database, nothing in the blob root, no deployment or import in
  the state directory (`RAY_TARGET_NOT_EMPTY`) — on the snapshot's server major
  (`RAY_TARGET_UNSUPPORTED`), with its roles prepared by the database roles setup and a workflow
  system database when the snapshot carries one (`RAY_USAGE`). The restoring role may not be a
  superuser or create roles (`RAY_POLICY_DENIED` `posture-refused`).
- **Verification.** The bytes restored hash to the inventory; the tables and their row counts are the
  snapshot's; every foreign key is there and validated; the schema head is the snapshot's; exactly one
  organization owns every tenant row and object (`RAY_MULTI_TENANT_UNSUPPORTED` otherwise, and a dump
  restoring two organizations is discarded at once); sessions, API keys, invites, OIDC artifacts and
  owner-recovery tokens are empty; the runtime role holds the isolated posture, reads every table,
  is owed its writes and can write none of them; every object read back has the index's size, header
  and both digests. The row counts are checked again after the import's own writes.
- **Identity.** After the verification each account's carried identity — user id, and password hash
  when it has one — is recorded in the target's `auth_audit` (event `identity_imported`, with the
  operation id and the bundle's digest). The target's own boot secrets are then minted into
  `--secrets-out`: `jwt-signing-key.pem` (RS256 PKCS#8), `api-key-pepper` and `media-signing-key`,
  directory 0700, files 0600, never printed. The source's secrets are never carried, so every API
  key, refresh session, invite, access token and playback URL of the source is refused by the target;
  passwords keep working.
- **Flags.**
  - `<migration.ray>`: the bundle `rayspec export` wrote.
  - `--target <state-dir>` (required): the target's state directory, created (mode 0700) when it does
    not exist. It must hold no deployment.
  - `--identity-file <file>` (required): the age identity file (`age-keygen`), with exactly one X25519
    identity. A protected file: a regular file of yours, mode 0600 (`RAY_BINDINGS_FILE_INSECURE`).
  - `--secrets-out <new-dir>` (import only, required): a new directory, under an existing one, for the
    target's own boot secrets. An existing path is refused (`RAY_USAGE`) before anything is
    decrypted.
  - `--bindings-file <file>` (import only): the target application's bindings, in the deploy's format.
    Reserved names are refused (`RAY_BINDING_RESERVED`), undeclared names `RAY_USAGE`, and a required
    binding neither the file nor the environment supplies is `RAY_BINDING_MISSING`. The values are
    checked, not kept: give them again when you deploy at the cutover.
  - `--dry-run`: the eligibility plan only.
  - `--discard-failed`: with `--target` alone. Removes what a failed or killed import restored — every
    object the migration role owns in both target databases, everything in the blob root, and the
    state directory's deployment and import records (its receipts stay) — and gives back the default
    privileges the import withheld. A target that is ready for its cutover, cut over, or that holds a
    deployment, is never discarded.
  - `--cutover-token <token>`: with `--target` alone. The cutover (below).
  - `--renew-cutover-token`: with `--target` alone. Replaces the cutover token of an import ready for
    its cutover with a new one of the same binding, valid 15 minutes; the old token stops working.
    Refused when the fence or the catalogs are no longer what the import left.
- **Environment** (explicit, never a `.env` file): `DATABASE_URL` (or `_FILE`; the target's runtime
  role), `RAYSPEC_MIGRATION_DATABASE_URL` (or `_FILE`; required: the restore runs as this role),
  `DBOS_SYSTEM_DATABASE_URL`, `RAYSPEC_BLOB_ROOT` (required when the snapshot carries objects; empty
  or absent), `RAYSPEC_PG_RESTORE` (an absolute path; default the first `pg_restore` on `PATH`, which
  must be of the server's major). No output carries a value.
- **Output:** the result envelope on stdout (operation `import.dry-run` or `import`), with or without
  `--json`. The dry run's `data`:
  `{ bundleSha256, eligible, applicationId, applicationVersion, sourceRuntime, schemaHead, fenceEpoch, workflowSystemDatabase, blockers }`
  (`fenceEpoch` is the source's, the snapshot was taken under it). A target finding is an error and
  also a blocker in `data`, with `eligible: false`. The import's `data`:

  ```json
  {
    "bundleSha256": "…",
    "deploymentId": "8c1f0a2b3c4d5e6f",
    "status": "ready-for-cutover",
    "applicationDigest": "…",
    "schemaHead": { "platform": "0015_tenant_row_security", "product": "…" },
    "verification": { "checksums": "match", "tableCounts": "match", "objects": "match", "referenceIntegrity": "match" },
    "credentialReset": { "sessions": "reset", "apiKeys": "reset", "invites": "reset", "oidcArtifacts": "reset", "passwordHashes": "preserved", "forcedLogin": true }
  }
  ```

  On stderr: the operation id, progress lines and, without `--json`, a summary with the counts, who
  signs in again with their password, which owner needs owner recovery (no password; see
  [`tenant recover-owner`](#tenant-recover-owner)) and which account has no way in, that every API key
  is reissued, the target's fence epoch, the cutover instruction naming the secret files and the
  cutover token (below). The receipt's summary keeps only the counts (`identity`) and
  `bootSecrets: "reissued"`.
- **Cutover.** The import holds the target's fence (epoch 1): the runtime role never held a write on
  what was restored, and the writes it is owed are recorded with the fence. The cutover token — the
  SHA-256 of `{migrationBundleSha256, applicationDigest, targetDeploymentId, sourceFenceEpoch,
  targetFenceEpoch, targetEnvironmentRevision, catalogSha256, issuedAt, expiresAt}` and a random
  value — is shown once in the summary; the fence and the receipts keep only its SHA-256. It works
  once, for 15 minutes. To cut over: keep the source fenced, run
  `rayspec import --target <target> --cutover-token <token>` in the target's environment, then
  deploy the application the source ran there (`rayspec deploy <file.ray> --state-dir <target>`),
  with the target's own boot secrets (`RAYSPEC_JWT_SIGNING_KEY_FILE=<new-dir>/jwt-signing-key.pem`,
  `RAYSPEC_API_KEY_PEPPER_FILE=<new-dir>/api-key-pepper`, and `RAYSPEC_MEDIA_SIGNING_KEY` from
  `<new-dir>/media-signing-key` when the application has a playback route). The cutover refuses
  another token, a used one, an expired one and one whose binding no longer holds (another bundle,
  deployment or source fence than `import.json`, or a moved target fence or environment revision)
  with `RAY_POLICY_DENIED`, and a target whose catalogs changed with `RAY_RECONCILIATION_REQUIRED`;
  otherwise it marks the token used (`CUTOVER`), releases the fence, grants the runtime role its
  writes and records `COMPLETE` (`data: null`, exit 0). `rayspec resume` never releases a fence an
  import holds.
- **Receipts.** `<target>/receipts/import-<operationId>.json` (mode 0600, shareable: no secret, path,
  record or table name) and, once the target is verified, rows of `runtime_control_receipts` of kind
  `import` in the target — one per transition `IMPORTING`, `VERIFYING`, `READY_FOR_CUTOVER` (again
  for a renewed token), `CUTOVER`, `COMPLETE` or `BLOCKED`, each with both fence epochs, the time,
  the digests and the recovery action.
  `<target>/import.json` says which import left the target in which state.
- **Interruption and failure.** SIGINT or SIGTERM stops the import at its next safe point and ends a
  running `pg_restore`, whose transaction rolls back (`RAY_INTERRUPTED`, exit 6). A failure after the
  target changed is `RAY_RECONCILIATION_REQUIRED` (exit 6) or the refusal that found it; the target is
  marked failed (`import.json` `BLOCKED`, and fenced as failed once its application database was
  restored: that fence is never resumed) until `--discard-failed`; so is a verified target whose
  `--secrets-out` could not be written. A process killed outright leaves
  its scratch data and `import.json` at `IMPORTING`; the next `import` of the target removes the
  scratch data (so does `resume`), closes the killed run's receipt and marks the target failed.
- **Codes.** The contract's lists for the two forms — `RAY_USAGE`, `RAY_INVALID_ARCHIVE`,
  `RAY_LIMIT_EXCEEDED`, `RAY_MANIFEST_INVALID`, `RAY_DIGEST_MISMATCH`, `RAY_DECRYPTION_FAILED`,
  `RAY_BINDINGS_FILE_INSECURE`, `RAY_RUNTIME_UNSUPPORTED`, `RAY_TARGET_UNSUPPORTED`,
  `RAY_TARGET_NOT_EMPTY`, `RAY_MULTI_TENANT_UNSUPPORTED`, `RAY_INFRA_UNAVAILABLE`, `RAY_INTERNAL`,
  and for the import also `RAY_BINDING_RESERVED`, `RAY_BINDING_MISSING`, `RAY_POLICY_DENIED`,
  `RAY_LOCK_TIMEOUT`, `RAY_RECONCILIATION_REQUIRED` and `RAY_INTERRUPTED` — and, from the embedded
  application's reader pipeline, its codes (`RAY_CAPABILITY_UNSUPPORTED`, `RAY_SPEC_INVALID`, …); the
  dry run also reports `RAY_POLICY_DENIED` for a dump the allowlist refuses.
- **Exit:** `0` eligible or ready for cutover, `2` usage, archive, manifest, digest, decryption or a
  limit, `3` runtime, target or tenants, `4` not empty, policy or an insecure file, `5` retryable
  (database, lock), `6` interrupted or a failed restore, `7` internal error.

---

## `resume`

```
rayspec resume --deployment <id> --fence-epoch <n> [--state-dir <dir>] [--json]
```

Releases the source fence an export took, only at the epoch it is held at, and grants the runtime
role back exactly the writes the barrier revoked. Every runtime process restarts its producers
within a second. It never releases a fence an import holds (`RAY_USAGE`): an imported target is
released by its cutover (`rayspec import --target <dir> --cutover-token <token>`), a failed one is
discarded.

- **Flags:** `--deployment <id>` (required; checked against the state directory and the database,
  else `RAY_USAGE`), `--fence-epoch <n>` (required; the epoch the export reported), `--state-dir`.
- **Environment:** as for `export`; only the database connections are used.
- **After a killed export.** Before anything else, `resume` removes what an export killed outright
  left in `<state-dir>/scratch/` (its plaintext capture), by the rule `export` applies: only when no
  live process holds the scratch lock, so a running export is left alone. It closes the killed
  export's receipt as interrupted, with the fence as the environment records it, and says on stderr
  what it removed. This happens even when the resume itself is refused.
- **Output:** the result envelope (operation `resume`) with
  `data: { deploymentId, fenceEpoch, released, environmentRevision }`. `released` is `false` when the
  fence was already open at that epoch; nothing changes then.
- **Exit:** `0` released or already open, `2` usage, `4` another epoch (`RAY_FENCE_MISMATCH`), `5`
  the database cannot be reached, `7` internal error.

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

- **[Packing an application](./packing.md)** — what `pack` puts in a bundle, what
  it leaves out, and how to fix each refusal.
- **[Deploying a bundle on your own server](./self-hosted-deployment.md)** — inspect,
  bind, review, apply, readiness, update and recovery of a `.ray` deployment.
- **[Runtime operations](./runtime-operations.md)** — what a deploy records, and how
  to recover from an interrupted one.
- **[Exporting a deployment](./export.md)** — planning the downtime, what an export
  carries and resets, and recovery when it is interrupted.
- **[Importing a deployment](./import.md)** — preparing an empty target, what a dump
  may contain, the cutover, and recovery when an import fails.
- **[Getting started](./getting-started.md)** — these commands in sequence.
- **[Spec reference](./spec-reference.md)** — the grammar `doctor`/`plan`/`openapi`
  check.
- **[Architecture](./ARCHITECTURE.md)** — how a deploy turns a spec into a running
  backend.
