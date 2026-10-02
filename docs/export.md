# Exporting a deployment

`rayspec export` takes a self-hosted deployment's complete state — the deployed application, its
application database, its workflow system database and every stored blob — under the source fence,
and writes it as **one encrypted migration bundle** (`.ray`). Only the holder of the age identity you
encrypt to can read it. The source stays fenced afterwards, so nothing written after the snapshot is
lost when the new environment takes over.

An export is offline and consistent: the deployment stops accepting writes for as long as it takes,
and the snapshot proves that nothing changed while it was taken. It is not a backup tool, not a
replication stream and not a way to merge two deployments; it moves one environment, with its one
organization, to a new and empty one.

This guide is for the operator. The reference for the command is in the
[CLI reference](./cli-reference.md#export); the library underneath it is described in
[Runtime operations](./runtime-operations.md#snapshots-of-a-fenced-source).

## Plan the downtime

From the moment the export fences the source until you release the fence, the deployment is
read-only:

| What | While fenced |
| --- | --- |
| HTTP mutations and uploads | refused with `503 SERVICE_UNAVAILABLE` and `Retry-After` |
| Reads | keep answering |
| Cron and webhook triggers, the on-demand trigger, the run queue, the tenant event bus | stopped (paused, not shut down) |
| Event streams | closed |
| Runs in flight | drained, up to `--quiesce-deadline` (default 300 seconds) |
| The database | a write barrier the platform's requests and jobs cannot pass (below) |
| Blob writes | refused |

The export itself takes about as long as `pg_dump` of both databases plus one read of every blob
and one pass of encryption over the result. **The source stays fenced after a successful export**:
plan the downtime to last until the new environment has taken over (or until you decide to bring the
source back with `rayspec resume`).

### The database write barrier

A fence that only the application respects is not enough: the database must refuse writes too. An
export holds one of two barriers, and refuses without one (`RAY_EXTERNAL_STATE_UNSUPPORTED`,
reason `database-barrier-unavailable`). Without role separation and without `--source-stopped` no
barrier can hold, and the export knows that before it fences: it refuses at the precheck and the
source stays as it was, unfenced. When a barrier could hold but does not (the runtime role's writes
could not be revoked, or a session is still connected to a source attested as stopped), the
refusal comes after the fence and leaves the source fenced:

- **Role separation** (recommended; [Database roles and row-level security](./database-isolation.md)).
  With `RAYSPEC_MIGRATION_DATABASE_URL` set, the export connects as the migration role and revokes
  the runtime role's `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` on every table of both databases
  until resume (barrier `database-write-role`). The deployment can keep running while you export.
  The barrier binds the runtime role, not the application's own code: the serving process also holds
  the migration role's connection, and code of the application can use it to write past the fence
  or open it. Before exporting an application whose code you do not trust, stop every runtime
  process of the source and keep it stopped until the target has taken over
  ([Threat model](./threat-model.md#accepted-residual-risks)).
- **A stopped source.** Without role separation, stop every runtime process of the deployment and
  pass `--source-stopped`. The export checks that no other session is connected to either database
  (barrier `database-stopped-source`).

The export's result says which barrier held and which did not apply, and so does its receipt.

### Checklist

- **The deployment was deployed from a bundle** (`rayspec deploy <file.ray>`), and you run the
  export with its state directory (`--state-dir`, default `.rayspec-state`).
- **One organization**, and at least one member of it with a password: after the import every API
  key, session and invite stops working, so someone must be able to sign in. An owner who holds only
  an API key regains access on the target through owner recovery
  ([Importing a deployment](./import.md#owner-recovery)); an organization in which nobody holds a
  password is still refused (`RAY_OWNER_RECOVERY_REQUIRED`).
- **`pg_dump` of the database server's major version** on `PATH`, or named by `RAYSPEC_PG_DUMP`
  (an absolute path). `pg_dump --version` must report the same major as the server.
- **The blob root** in `RAYSPEC_BLOB_ROOT`, when the application keeps blobs. Only the platform's fs
  blob store is exported. An application that loads extensions is exported like any other as long as
  no extension provides a blob backend of its own; one that does is refused
  ([Applications with extensions](#applications-with-extensions)).
- **Disk space** in the state directory for about twice the size of both databases, the blobs and
  the application. The plaintext snapshot is assembled there, in a private directory, and nowhere
  else.
- **Optional: the read-only snapshot role** (`RAYSPEC_SNAPSHOT_DATABASE_URL`), which reads every
  tenant's rows and can write nothing. Without it the dumps read as the migration role (or the one
  role), and the result says `single-role`.
- **An age key pair** for the recipient (below).

## Applications with extensions

An extension can contribute stores, routes, handlers, tools and agents, and one capability the
platform knows: a **blob backend** of its own (`capabilities.blobFactory` in its `defineExtension`
manifest). When an extension provides one and the application has a stream route, the runtime keeps
the uploaded bytes there instead of in the fs store under `RAYSPEC_BLOB_ROOT`. The export reads the
fs store only, so it must know which backend holds the blobs before it fences anything.

Whether an extension provides a backend is a value of its module: it is known only by importing
that code. The deployment's boot imports every extension anyway, and decides which blob backend it
builds. The export never loads application code in its own process. So the boot states what it
resolved — the platform's fs store, no blob backend, or the backend of the extension it names — and
the bundle deploy that activates the application records it in the environment database
(`runtime_control_state.blob_backend`) in the same transaction as the application's digest. Every
bundle deploy writes it again, a restart included. The export reads that record for the active
version:

| What the deployment's boot recorded | The export |
| --- | --- |
| the platform's fs store | exports the blobs under `RAYSPEC_BLOB_ROOT`; without the variable it refuses (`RAY_USAGE`), even when the application's own spec declares no stream route (an extension may contribute it) |
| no blob backend | exports the databases; a `RAYSPEC_BLOB_ROOT` that is set is read as usual |
| a backend an extension provides | refuses before the fence: `RAY_EXTERNAL_STATE_UNSUPPORTED`, reason `unsupported-blob-adapter`, naming the extension. Its bytes are wherever that extension put them, which the export can neither inventory nor freeze |
| nothing for the active version (deployed by an earlier runtime, or the record belongs to another version) | refuses the same way. Deploy the active bundle once with this runtime (`rayspec deploy <file.ray>`), which records it, and export again |

Reading the record rather than the extension's code is deliberate: deciding it in the export would
mean running the extensions' entry modules — application code, with its own imports and side effects
— in the operator's export process, on a source that may be stopped, and the result could still
differ from what the running deployment built (an extension can decide by its own configuration).
The record is what the boot actually built, written with the version it belongs to.

The decision belongs to the version it was read for. The precheck, and the capture again under the
fence, check that the active version is still that one; a deploy that activated another version
while the export ran (for example while the confirmation prompt waited) is refused with
`RAY_SOURCE_NOT_QUIESCENT`, before the fence when the precheck sees it, else with the source fenced.
Run the export again, which decides for the new version.

The extension itself, its compiled modules and the third-party packages it vendors travel inside the
application bundle the snapshot carries, byte for byte; the import restores the application like any
other, and the target serves the extension from that bundle. An extension's stores must be declared
in the application's spec (as the reference application `examples/asset-catalog` does): a table only
an extension's fragments create is neither a platform table nor a product store of the application,
and the export refuses it (`unknown-table`).

## Create the recipient

The bundle is encrypted with [age](https://age-encryption.org) to one X25519 recipient. Create the
key pair on the machine that will import, not on the source:

```bash
age-keygen -o migration-identity.txt   # keep this file private (mode 0600)
age-keygen -y migration-identity.txt   # prints the recipient: age1...
```

Only the recipient (`age1…`) goes to the source. There is no passphrase mode: a passphrase, an
identity (`AGE-SECRET-KEY-1…`) or a post-quantum or tag recipient is refused.

## Run it

With role separation, while the deployment runs:

```bash
export DATABASE_URL=postgresql://rayspec_runtime:…@db.internal:5432/app
export RAYSPEC_MIGRATION_DATABASE_URL=postgresql://rayspec_migrator:…@db.internal:5432/app
export RAYSPEC_SNAPSHOT_DATABASE_URL=postgresql://rayspec_snapshot:…@db.internal:5432/app
export RAYSPEC_BLOB_ROOT=/var/lib/app/blobs

rayspec export --deployment 3f9c0a1b2c3d4e5f \
  --recipient age1… \
  --output /srv/handover/app-migration.ray \
  --run-history included
```

On a stopped source without role separation: stop every runtime process, set `DATABASE_URL` (and
`RAYSPEC_BLOB_ROOT`), and add `--source-stopped`.

The configuration comes **from the process environment only**; no `.env` file is read, and no output
carries a value of any of these variables. `DATABASE_URL`, `RAYSPEC_MIGRATION_DATABASE_URL` and
`RAYSPEC_SNAPSHOT_DATABASE_URL` also accept a `<VAR>_FILE` variant naming a file that holds the value,
which wins over the plain variable.

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | the application database; the runtime role under role separation |
| `RAYSPEC_MIGRATION_DATABASE_URL` | role separation: the export's own connection, which revokes and restores the runtime role's writes |
| `RAYSPEC_SNAPSHOT_DATABASE_URL` | the read-only snapshot role the dumps read as |
| `DBOS_SYSTEM_DATABASE_URL` | the workflow system database; default `<application database>_dbos_sys` |
| `RAYSPEC_BLOB_ROOT` | the fs blob root |
| `RAYSPEC_PG_DUMP` | an absolute path to `pg_dump`; default the first on `PATH` |

Before it changes anything, the export runs a read-only precheck of the source (the checks are
listed in [Runtime operations](./runtime-operations.md#snapshots-of-a-fenced-source)); a refusal there
changes nothing. The precheck runs while the deployment is still open, so an upload being written at
that moment is normal: its temporary file in the blob root is counted (and its bytes count toward the
size and disk budgets), reported on stderr as `precheck: N upload(s) in flight in the blob root`, and
left to the fence, which drains every upload before the capture. Then the export prints the downtime
plan on the terminal and asks you to type `yes`. In a script, or with `--json`, pass
`--confirm-quiesce` instead.

`--run-history` has no default. `included` carries runs, run events, agent journals, conversation
items and workflow runs; `excluded` keeps their rows at the source (their tables arrive empty). The
workflow system database is carried whole whenever it exists, so the durable engine's own record of
workflow inputs and outputs travels either way.

The export ends with one result envelope on stdout:

```json
{
  "ok": true,
  "operation": "export",
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
  }
}
```

Keep `sha256` with the bundle: it is what the importer checks first. On stderr you see the progress,
the counts (tables, rows, objects) and the path of the receipt.

## What the bundle carries

| Carried | Not carried |
| --- | --- |
| the deployed application bundle, byte for byte | binding values and boot secrets (the signing key, the API-key pepper, the media key) |
| the organization, its users with their password hashes, memberships | API keys, refresh sessions, invites, OAuth/OIDC grants, codes and tokens |
| every product store row | idempotency (request replay) records |
| the platform and product migration ledgers | the authentication audit log |
| the tenant event bus | runtime-control state and receipts |
| run history, when `--run-history included` | run history, when `--run-history excluded` |
| the whole workflow system database, when it exists | external services (provider accounts, webhooks you registered elsewhere) |
| every blob of the fs blob store, with both digests | blobs in a backend an extension provides (the export refuses) |
| the application's extensions and their vendored packages, inside the application bundle | |

Tables whose rows stay behind are still in the dump, empty, so the target reaches the same schema.
`excludedDataCategories` lists every category whose rows were not exported.

## What the target resets

A new environment mints its own boot secrets, so everything keyed by the old ones stops working.
The bundle states this as its identity policy:

| Category | On import |
| --- | --- |
| user ids | preserved |
| password hashes | preserved (argon2id, independent of the pepper) |
| refresh sessions | reset: everyone signs in again |
| API keys | reset: owners mint new keys |
| invites | reset: owners invite again |
| OAuth/OIDC artifacts | reset |
| JWT signing key, API-key pepper, media signing key | reissued by the target |
| media playback tokens | invalidated |

Tell your users before the cutover that they will sign in again and that API keys must be reissued.

## After the export

Import the bundle into the new environment with `rayspec import` ([Importing a deployment](./import.md)):
it restores into an empty target, verifies it, and keeps the target fenced until you cut over.

The source stays fenced at the epoch the result names. While the bundle is imported and checked,
keep it that way: the source is the authority until the cutover, and a source that accepts writes
again makes the bundle stale. Once the new environment serves, keep the source fenced for the
recovery window (default seven days). Pointing DNS back at the source after the target accepted
writes is not a rollback: those writes would be lost.

To bring the source back instead — the import failed, or you decided not to move — release the fence
with the epoch the export reported:

```bash
rayspec resume --deployment 3f9c0a1b2c3d4e5f --fence-epoch 4
```

`resume` refuses any other epoch (`RAY_FENCE_MISMATCH`), so a fence someone else took is never
released by mistake. It grants the runtime role back exactly the writes the barrier revoked, and every
runtime process restarts its producers within a second.

Running the export again while the source is fenced reuses the fence at the same epoch; nothing new
is fenced and nothing is released.

## When an export is interrupted or fails

| What happened | The source | What to do |
| --- | --- | --- |
| A precheck refusal (wrong deployment id, drift, a second organization, a database extension, an extension that provides its own blob backend, no recorded blob backend, an unknown table, no `pg_dump` of the right major, …) | unchanged, not fenced | fix the cause and run the export again |
| You did not confirm the downtime | unchanged, not fenced | run it again and confirm, or pass `--confirm-quiesce` |
| The drain did not finish before `--quiesce-deadline` (`RAY_SOURCE_NOT_QUIESCENT`) | fenced | wait for the runs to end and run the export again, or `rayspec resume` |
| No role separation and no `--source-stopped`, so no database write barrier can hold (`database-barrier-unavailable`, at the precheck) | unchanged, not fenced | enable role separation, or stop every runtime process and run it again with `--source-stopped` |
| A database write barrier that could hold did not: the runtime role's writes could not be revoked, or a session is still connected to a source attested as stopped (`database-barrier-unavailable`, after the fence) | fenced | fix the cause (or stop the remaining process) and run it again; or `rayspec resume` |
| A session that could write is connected (`uncontrolled-writer`), or a run is still marked running (`unreconciled-effects`) | fenced | disconnect it or reconcile the run, then run the export again |
| The blob root still holds the temporary file of an upload after the drain (`unreconciled-effects`): an upload that never finished, such as one whose process was killed | fenced | with the source fenced no upload is running, so delete the leftover `<key>.tmp-<pid>-<ms>-<uuid>` file under the blob root (`find "$RAYSPEC_BLOB_ROOT" -name '*.tmp-*'`), then run the export again |
| Ctrl-C / SIGTERM (`RAY_INTERRUPTED`, exit 6) | fenced | the export stopped at a safe point, ended `pg_dump` and removed its scratch data; run it again, or `rayspec resume` |
| The process was killed outright | fenced, unless it was killed before quiesce took the fence | run the export again, or `rayspec resume`: either one first removes what the killed run left in `<state-dir>/scratch/` and records the killed run as interrupted |
| The database or the disk failed during the capture (`RAY_INFRA_UNAVAILABLE`) | fenced | fix it and run the export again, or `rayspec resume` |

Every refusal after the fence carries the exact `rayspec resume` command in its message. The export
never reports a snapshot as consistent unless the fence held at one epoch for the whole capture and
the blob root and the fence read the same after the dumps as before them.

A process killed outright cannot clean up after itself. Until the next `rayspec export` or
`rayspec resume` of the deployment runs, `<state-dir>/scratch/` holds its plaintext capture: the
database dumps (password hashes included), the blob bytes and the inner snapshot. Run one of them
promptly. If you do neither, make sure no export is running and delete everything in
`<state-dir>/scratch/` yourself (`rm -rf <state-dir>/scratch/*`; a directory in it that is not
writable needs `chmod -R u+w` first). Both verbs leave the scratch directory of a running export
alone.

A process killed while it wrote the bundle may leave a file named `.<output>.<hex>.tmp` beside the
output. It holds ciphertext only; delete it.

## Receipts

Every step of an export — `PRECHECK`, `QUIESCING`, `FROZEN`, `EXPORTING`, then `EXPORTED`, or
`BLOCKED` from any of them — is recorded with the operation id, the actor, the fence epoch and state,
the time, the digests known by then and the recovery action, in two places:

- **The local receipt**, `<state-dir>/receipts/export-<operationId>.json` (mode 0600). It is written to
  be shared, for example with whoever imports the bundle: it holds no secret, connection string, path,
  record or table name — the counts of tables, rows and objects, the digests, the barriers, and a
  refusal's code and reason (never its message).
- **The environment's receipts**, in `runtime_control_receipts` (kind `export`), once you have
  confirmed the downtime: the `PRECHECK` transition is written there then, followed by `QUIESCING`
  and the rest, while the source may still be open. A precheck that refuses, or a downtime you do not
  confirm, changes nothing at the source and is recorded in the local receipt only. The `quiesce` the
  export runs is recorded under the same operation id:

  ```sql
  SELECT operation_kind, event, step, outcome, digest, detail, recorded_at
    FROM runtime_control_receipts
   WHERE operation_id = '<operationId>'
   ORDER BY id;
  ```

## `pg_dump`

The dumps run the `pg_dump` your machine has: the first on `PATH`, or the one `RAYSPEC_PG_DUMP`
names. Its major version must equal the server's, because a custom-format dump restores only into a
server of the same or a newer major and `pg_dump` refuses a newer server. The connection reaches it
through the libpq environment, never its command line. The repository's test suites run the host's
`pg_dump` and `pg_restore` when their major matches the server's, and otherwise the ones of the
pinned `postgres` image `docker-compose.yml` runs, through `docker run`.

## Limits

- One organization per environment; more is refused (`RAY_MULTI_TENANT_UNSUPPORTED`).
- At most 500,000 objects, and a bundle of at most 2 GiB (`RAY_LIMIT_EXCEEDED`, `migration-size`).
- No database extension in the application database; in the workflow system database only the one
  the durable engine's own migrations create (`uuid-ossp`).
- Only the platform's fs blob store; an extension that provides its own blob backend is refused.
- No passphrase encryption, no partial export, no redaction mode.

## Compatibility notes

Where `rayspec export` differs from the bundle contract it implements (`1.0.0-draft.2`), recorded
here as an amendment for the contract's next revision:

- **A barrier that cannot hold is refused before the fence.** The contract's `quiesce` takes the
  fence and then reports the database barrier `unavailable`, and its `snapshot` refuses with
  `RAY_EXTERNAL_STATE_UNSUPPORTED` (`database-barrier-unavailable`) with the fence still held. Without
  role separation and without `--source-stopped`, `export` knows before quiescing that no database
  barrier can hold, so it refuses with the same code and reason at the precheck and does not fence
  the source at all: no downtime, no `QUIESCING` receipt, nothing to resume. A source already fenced
  with a database barrier an earlier attested export holds keeps that barrier and is exported as
  before. `quiesce()` and `captureSnapshot()` of the runtime operations behave as the contract
  states.
