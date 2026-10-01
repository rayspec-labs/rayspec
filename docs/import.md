# Importing a deployment

`rayspec import` takes a migration bundle that [`rayspec export`](./export.md) wrote and restores it
into a **new, empty** environment: the application database, the workflow system database and every
stored blob. It checks everything before it restores anything, restores as the target's own
migration role (never a superuser), verifies the result against the snapshot, and leaves the new
environment **fenced**, so it serves nothing until you cut over. The source stays the authority
until then.

The import never merges into a database that holds anything and never overwrites a file. It restores
the one organization the snapshot carries, and nothing it was not given.

This guide is for the operator. The reference for the command is in the
[CLI reference](./cli-reference.md#import).

## Prepare the target

You need, on the new host:

- **Two empty databases** on a PostgreSQL server of **the same major** as the source (the snapshot
  states it; an import never upgrades): the application database, and the workflow system database
  when the snapshot carries one (the dry run tells you). The import cannot create a database.
- **The database roles**, prepared on both databases with the database roles setup, as for any
  deployment with role separation ([Database roles and row-level security](./database-isolation.md)):

  ```bash
  psql -v ON_ERROR_STOP=1 -d app -f database-roles.sql
  psql -v ON_ERROR_STOP=1 -d app_dbos_sys \
       -c "SET rayspec.database_kind = 'workflow-system'" -f database-roles.sql
  ```

  The import restores as the **migration role** and refuses a role that is a superuser or may create
  roles. Everything it restores belongs to the migration role, and the migration role's default
  privileges, which the setup creates, give the runtime and snapshot roles their grants.
- **An empty blob root** (or a path whose parent exists), when the snapshot carries objects.
- **`pg_restore` of the server's major** on `PATH`, or named by `RAYSPEC_PG_RESTORE` (an absolute
  path).
- **The age identity file** whose recipient the export encrypted to (`age-keygen -o …`), mode 0600
  and yours. Its content is never printed.
- **The same RaySpec runtime** the source ran: the snapshot names it, and any other is refused
  (`RAY_RUNTIME_UNSUPPORTED`). Upgrade after the cutover, never during the import.

The configuration comes from the process environment only, never a `.env` file:

| Variable | Used for |
| --- | --- |
| `DATABASE_URL` | the target's application database, as the runtime role |
| `RAYSPEC_MIGRATION_DATABASE_URL` | the same database as the migration role: the restore runs as it (required) |
| `DBOS_SYSTEM_DATABASE_URL` | the workflow system database; default `<application database>_dbos_sys` |
| `RAYSPEC_BLOB_ROOT` | the target's fs blob root |
| `RAYSPEC_PG_RESTORE` | an absolute path to `pg_restore`; default the first on `PATH` |

Each database URL also accepts a `<VAR>_FILE` variant. No output carries a value of any of them.

## Check first

```bash
rayspec import /srv/handover/app-migration.ray \
  --target /srv/app/.rayspec-state \
  --identity-file migration-identity.txt \
  --dry-run
```

The dry run decrypts the bundle into a private directory under `<target>/scratch/`, checks it all,
removes the plaintext again and restores nothing:

1. the bundle through the reader every RaySpec tool uses: its structure, and the ciphertext's size
   and SHA-256 against the bundle's own inventory, **before** anything is decrypted;
2. the decryption with your identity, within the migration size limit; a wrong identity or a damaged
   bundle is `RAY_DECRYPTION_FAILED` and leaves no plaintext;
3. the snapshot inside, through the same reader: `snapshot.json`, every file against its digest, every
   object against both of its digests;
4. every clear label of the bundle (application, runtime, target) against the encrypted, authenticated
   snapshot (`RAY_DIGEST_MISMATCH` `inner-metadata` when they differ), and the application itself
   against this runtime;
5. each database dump against the restore allowlist (below);
6. the target: both databases and the blob root empty, the server major, the roles, `pg_restore`.

Its result says `eligible: true`, or lists what stands in the way.

## What a dump may contain

A snapshot is encrypted, not trusted: whoever holds the recipient can write one. So the import reads
each dump's table of contents itself, entry by entry, and checks it again against what `pg_restore`
reads from the same bytes. Only these are restored: schemas the platform uses, tables, sequences,
defaults, constraints, foreign keys, indexes, triggers, row-level policies, functions written in
`sql` or `plpgsql`, table data and sequence values — each exactly in the form `pg_dump` writes it.
Refused, before anything reaches the target (`RAY_POLICY_DENIED`):

- an extension (none in the application database; in the workflow system database only `uuid-ossp`,
  which the workflow engine's own migrations create): `unsupported-extension`;
- an object of another owner, or a privilege granted to a role the dump does not account for:
  `unmapped-owner`;
- a role, an event trigger, a view, a type, a language, a large object, a function in another
  language, a `SECURITY DEFINER` function (the platform's own two lookups excepted, unchanged), table
  data loaded by anything but `COPY … FROM stdin` (no `PROGRAM`), an expression the restore would
  evaluate that calls a function of the dump or a server function, or any statement beside the ones
  an entry may hold: `privileged-statement`.

Privileges, comments and the dump's owner are not restored. The target's runtime role ends up with
exactly the grants the roles setup gives it, the migration ledgers closed to it, and row-level
security enabled and forced on every tenant table; the import checks that posture before it reports
success.

## Import

```bash
rayspec import /srv/handover/app-migration.ray \
  --target /srv/app/.rayspec-state \
  --identity-file migration-identity.txt \
  --bindings-file bindings.json
```

`--bindings-file` (optional) is checked like a deploy's: no reserved name, only names the application
declares, every required binding supplied by it or the environment. The values are not kept; give
them again when you deploy at the cutover.

The import mints the target's own deployment id, then:

- **IMPORTING** — both databases restored with `pg_restore` as the migration role, the workflow
  system database first, each in one transaction, under the shared schema lock; then every stored
  blob file, unchanged.
- **VERIFYING** — the bytes restored hash to the snapshot's digests; the tables and their row counts
  are the snapshot's; every foreign key is in place and validated; the schema head is the snapshot's;
  exactly one organization owns every row and every object; sessions, API keys, invites and OIDC
  artifacts are empty; every blob file read back has its size, header and both digests.
- **READY_FOR_CUTOVER** — the target is fenced with its runtime role's writes revoked, so nothing can
  serve or change it until you release it.

Before it reports success the import also checks that the runtime role holds its grants on every
restored table (reads everywhere, writes in schema `public` but the migration ledgers, writes on the
whole workflow system database) and the isolated posture; a target whose roles were not prepared
with the database roles setup is refused there (`RAY_POLICY_DENIED` `posture-refused`).

A dump that restores more than one organization is refused (`RAY_MULTI_TENANT_UNSUPPORTED`) and its
restore removed at once.

The result:

```json
{
  "ok": true,
  "operation": "import",
  "data": {
    "bundleSha256": "…",
    "deploymentId": "8c1f0a2b3c4d5e6f",
    "status": "ready-for-cutover",
    "applicationDigest": "…",
    "schemaHead": { "platform": "0015_tenant_row_security", "product": "…" },
    "verification": { "checksums": "match", "tableCounts": "match", "objects": "match", "referenceIntegrity": "match" },
    "credentialReset": { "sessions": "reset", "apiKeys": "reset", "invites": "reset", "oidcArtifacts": "reset", "passwordHashes": "preserved", "forcedLogin": true }
  }
}
```

On stderr you also get the counts, the target's fence, the cutover instruction and the **cutover
token**: the SHA-256 of the migration bundle's digest, the application's digest, the target's
deployment id, the source's fence epoch (the one the snapshot was taken under), the target's fence
epoch and revision, and a 15-minute validity. It is recorded in the receipts, so the cutover can be
tied to exactly this import of exactly this snapshot.

## What carries over, and what is reset

The export left credentials behind, so everything keyed by the source's secrets starts empty:

| Category | After the import |
| --- | --- |
| organization, users, memberships, user ids | carried |
| password hashes | carried (argon2id, independent of the pepper): members sign in with the passwords they had |
| refresh sessions | none: everyone signs in again |
| API keys | none: owners mint new keys |
| invites | none: owners invite again |
| OAuth/OIDC grants, codes and tokens | none |
| tokens the source issued | refused: the target has its own signing key |

A snapshot that asks for password hashes to be reset is refused (`RAY_POLICY_DENIED`
`posture-refused`): this runtime carries out only the policy above.

## Cut over

The source is still fenced at the epoch the export reported; keep it so. Then, in the **target's**
environment:

```bash
rayspec resume --deployment 8c1f0a2b3c4d5e6f --fence-epoch 1 --state-dir /srv/app/.rayspec-state
rayspec deploy app.ray --dry-run --state-dir /srv/app/.rayspec-state --bindings-file bindings.json
rayspec deploy app.ray --plan-digest <planDigest> --state-dir /srv/app/.rayspec-state --bindings-file bindings.json
```

`resume` releases the fence the import took and gives the runtime role its writes back. `app.ray` is
the application the source ran — its SHA-256 is the `applicationDigest` of the result. Deploy it with
the target's **own** boot secrets (a new signing key, pepper and media key); the plan shows the schema
the import restored and no change to it. Point traffic at the target, then tell your users to sign
in again and to issue new API keys and invites.

Keep the source fenced for the recovery window (seven days by default). Once the target has accepted
writes, pointing traffic back at the source is not a rollback: those writes would be lost.

To give up instead, before the cutover: discard the target (below) and release the **source's**
fence with `rayspec resume` at the epoch the export reported.

## When an import fails

| What happened | The target | What to do |
| --- | --- | --- |
| A refusal before the restore (the bundle, the identity, a dump, the target, the runtime) | unchanged | fix the cause and run it again |
| A failure or refusal after the restore began (`RAY_RECONCILIATION_REQUIRED`, a verification) | marked failed: `import.json` says `BLOCKED`, and the target is fenced with its runtime role's writes revoked once its application database was restored | `rayspec import --target <dir> --discard-failed`, then import again |
| Ctrl-C / SIGTERM (`RAY_INTERRUPTED`, exit 6) | `pg_restore` ended and rolled back; marked failed if anything was restored | as above |
| The process was killed outright | possibly half restored; `import.json` says `IMPORTING`, the plaintext is in `<target>/scratch/` | run the import again: it removes the plaintext, closes the killed run's receipt and marks the target failed; then `--discard-failed` |

`--discard-failed` removes every object the migration role owns in both target databases (it owns
everything the import restored), everything in the blob root, and the deployment and import records
of the state directory; the receipts stay. It refuses a target that is ready for its cutover or holds
a deployment. The source is never touched by an import, whatever happens.

## Receipts

Every transition — `IMPORTING`, `VERIFYING`, `READY_FOR_CUTOVER`, or `BLOCKED` — is recorded with the
operation id, the actor, both fence epochs, the time, the digests and the recovery action:

- in `<target>/receipts/import-<operationId>.json` (mode 0600), written to be shared: no secret,
  connection string, path, record or table name;
- in the target's `runtime_control_receipts` (kind `import`), once the target is restored and
  verified; the fence the import took is recorded there as a `runtime.quiesce` under the same id.

## Limits

- One organization, and only the fs blob store, as for the export.
- The same runtime and the same database server major as the source.
- Only an empty target; no merge, no partial import.
- No passphrase identities; the identity file holds one X25519 identity.
