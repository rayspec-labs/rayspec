# Importing a deployment

`rayspec import` takes a migration bundle that [`rayspec export`](./export.md) wrote and restores it
into a **new, empty** environment: the application database, the workflow system database and every
stored blob. It checks everything before it restores anything, restores as the target's own
migration role (never a superuser), verifies the result against the snapshot, and leaves the new
environment **fenced**, so it serves nothing until you cut over. The source stays the authority
until then.

The import never merges into a database that holds anything and never overwrites a file. It restores
the one organization the snapshot carries, and nothing it was not given.

This guide is for the operator. It walks the whole move: [prepare the target](#prepare-the-target),
[check first](#check-first) with a dry run, [import](#import) (restore and verify),
[test privately](#test-privately), [cut over](#cut-over), and keep the source through
[the recovery window](#the-recovery-window). The reference for the command is in the
[CLI reference](./cli-reference.md#import).

An import is a **portability** move: it resets every credential, by design. To bring a database
back with its sessions and keys intact, restore a backup with the secrets it was taken under
instead ([Backup restore versus portability import](#backup-restore-versus-portability-import)).

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
  --secrets-out /srv/app/secrets \
  --bindings-file bindings.json
```

`--secrets-out` (required) names a **new** directory, under an existing one, for the target's own
boot secrets; an existing path is refused before anything is decrypted. `--bindings-file` (optional) is checked like a deploy's: no reserved name, only names the application
declares, every required binding supplied by it or the environment. The values are not kept; give
them again when you deploy at the cutover.

The import mints the target's own deployment id, then:

- **IMPORTING** — both databases restored with `pg_restore` as the migration role, the workflow
  system database first, each in one transaction, under the shared schema lock; then every stored
  blob file, unchanged.
- **VERIFYING** — the bytes restored hash to the snapshot's digests; the tables and their row counts
  are the snapshot's; every foreign key is in place and validated; the schema head is the snapshot's;
  exactly one organization owns every row and every object; sessions, API keys, invites and OIDC
  artifacts and owner-recovery tokens are empty; every blob file read back has its size, header and
  both digests.
- **The identity policy** — each account's carried identity (its user id, and its password hash
  when it has one) is recorded in the target's security audit (`auth_audit`, event
  `identity_imported`, naming the import's operation id and the bundle's digest); the credential
  tables are checked empty once more.
- **READY_FOR_CUTOVER** — the target is fenced with its runtime role's writes revoked, so nothing can
  serve or change it until you release it, and its own boot secrets are minted into `--secrets-out`:
  `jwt-signing-key.pem` (RS256, PKCS#8), `api-key-pepper` and `media-signing-key` (48 random bytes
  each, base64), directory mode 0700, files 0600. No output prints them.

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

On stderr you also get the counts, **who must do what** (below), the target's fence, the cutover
instruction with the secret files to deploy with, and the **cutover token**: the SHA-256 of the migration bundle's digest, the application's digest, the target's
deployment id, the source's fence epoch (the one the snapshot was taken under), the target's fence
epoch and revision, and a 15-minute validity. It is recorded in the receipts, so the cutover can be
tied to exactly this import of exactly this snapshot.

## What carries over, and what is reset

The export left credentials behind and the target mints its own secrets, so everything keyed by the
source's secrets stops working — twice over: the rows are not there, and the new secrets would not
verify them if they were.

| Category | After the import |
| --- | --- |
| organization, users, memberships, user ids | carried |
| password hashes | carried (argon2id, independent of every secret), and recorded in the target's audit: members sign in with the passwords they had |
| refresh sessions | none: everyone signs in again |
| API keys | none: owners mint new keys |
| invites | none: owners invite again |
| OAuth/OIDC grants, codes and tokens, owner-recovery tokens | none |
| access tokens the source signed | refused: the target has its own signing key |
| media playback URLs | refused: the target has its own media key |

A snapshot that asks for password hashes to be reset is refused (`RAY_POLICY_DENIED`
`posture-refused`): this runtime carries out only the policy above.

### Who must do what

Before you cut over, the import's stderr names every account and what it does next:

```text
sign in again with their password (2): ada@example.com (owner), lin@example.com (member)
owner recovery needed, no password (1): ops-bot@example.com (owner) — once the target serves, issue each a one-time token with `rayspec tenant recover-owner --email <address>`
API keys: none was carried, so every key of the source is reissued by an owner after the cutover; pending invites are issued again
```

The bundle carries no API key, so the import cannot name the keys; every key the source had is
reissued, by an owner, on the target. An account that is neither an owner nor holds a password is
listed as having no way in; an owner can invite that person again under another address. Tell your
users before the cutover. The receipt keeps only the counts.

### Owner recovery

An owner whose only credential was an API key holds no password, so after the import nothing lets
them in. Once the target serves (after `resume` and the deploy below), issue them a one-time token
against the **target's** database with the **target's** pepper:

```bash
DATABASE_URL=… RAYSPEC_API_KEY_PEPPER_FILE=/srv/app/secrets/api-key-pepper \
  rayspec tenant recover-owner --email ops-bot@example.com
```

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

The token is printed **once**, in that object on stdout, and nowhere else: the database keeps only
its HMAC under the pepper, and the audit (`owner_recovery_issued`) records who and until when, not
the token. Do not capture this command's output in a log. Hand the token to the owner over a channel
you trust; it is valid 30 minutes by default (`--ttl-seconds`, 5 minutes to 24 hours), and issuing
again replaces it. The owner redeems it once:

```bash
curl -sS https://app.example.com/v1/auth/owner-recovery \
  -H 'content-type: application/json' \
  -d '{"token": "<token>", "password": "<a new password>"}'
```

That sets their password, ends any session the account had, records `owner_recovery_redeemed` and
signs them in as the owner; they mint new API keys from there. A second redemption, an expired or a
replaced token is refused (`400`, the same answer for each). The command refuses an owner who holds a
password, an account that is not an active owner, and a fenced environment — so it can never write a
credential into the fenced source, or into the target before its cutover.

## Test privately

The source is still fenced at the epoch the export reported; keep it so. In the **target's**
environment, release the target's fence and deploy the application the source ran with the target's
**own** boot secrets, on an address only you reach:

```bash
export RAYSPEC_JWT_SIGNING_KEY_FILE=/srv/app/secrets/jwt-signing-key.pem
export RAYSPEC_API_KEY_PEPPER_FILE=/srv/app/secrets/api-key-pepper
# only when the application has a playback route:
export RAYSPEC_MEDIA_SIGNING_KEY="$(cat /srv/app/secrets/media-signing-key)"

rayspec resume --deployment 8c1f0a2b3c4d5e6f --fence-epoch 1 --state-dir /srv/app/.rayspec-state
rayspec deploy app.ray --dry-run --state-dir /srv/app/.rayspec-state --bindings-file bindings.json
rayspec deploy app.ray --plan-digest <planDigest> --state-dir /srv/app/.rayspec-state --bindings-file bindings.json
```

`resume` releases the fence the import took and gives the runtime role its writes back. `app.ray` is
the application the source ran — its SHA-256 is the `applicationDigest` of the result. The plan shows
the schema the import restored and no change to it. Move the secret files into your secret manager or
mount them where the deployment reads them; they are the target's only copy.

Then check it with synthetic requests, not with `/health` alone: sign in as a member with their
password, read the rows and files you know, recover a key-only owner if there is one, mint a test API
key and call a route with it, and see your bindings and workers do what they did at the source. A
token, key or invite from the source must be refused. Nothing points at the target yet, so whatever
you write while testing is yours to remove.

## Cut over

When the target passes: point traffic (DNS, the load balancer) at the target, update any outbound
callback URL or webhook you registered elsewhere, and tell your users to sign in again and to issue new
API keys and invites. Keep the source fenced: it must stay read-only.

To give up instead, before the cutover: discard the target (below) and release the **source's**
fence with `rayspec resume` at the epoch the export reported.

## The recovery window

Keep the source fenced, untouched, for the recovery window — seven days by default — so you can
still read what it held. It is not a way back: once the target has accepted a write, pointing traffic
back at the source is **not a rollback**. Every order, upload or member the target took since the
cutover exists only there; the source would serve the world as it was at the export and silently drop
all of it. To go back after that, reconcile or migrate the target's new data to the source first (an
export of the target and an import into a new environment is that move); never switch DNS back alone.

## Backup restore versus portability import

| | Backup restore | Portability import |
| --- | --- | --- |
| What moves | your own backup of the databases, credentials included | the migration bundle: no credential row, no secret |
| Secrets | the ones the backup was taken under, kept with it | the target mints its own |
| Sessions, refresh tokens, API keys, invites | keep working | reset: sign in again, reissue keys, invite again |
| Passwords | keep working | keep working |
| Use it for | bringing the same environment back | moving to a new environment or host |

A backup restore pairs every backup with the secret revision it needs: store the signing key, the
pepper and the media key with the backup (encrypted, as the backup is), and restore under exactly
those. Restored under fresh secrets, a backup is a credential reset like an import — every row
there, every credential refused. The import suite holds both: a backup of the source served under the
source's secrets keeps its access token, refresh session, API key and invite; served under new
secrets it refuses all four while passwords sign in. See also
[Restore, import and the boot secrets](./ARCHITECTURE.md#restore-import-and-the-boot-secrets).

## When an import fails

| What happened | The target | What to do |
| --- | --- | --- |
| A refusal before the restore (the bundle, the identity, a dump, the target, the runtime) | unchanged | fix the cause and run it again |
| A failure or refusal after the restore began (`RAY_RECONCILIATION_REQUIRED`, a verification) | marked failed: `import.json` says `BLOCKED`, and the target is fenced with its runtime role's writes revoked once its application database was restored | `rayspec import --target <dir> --discard-failed`, then import again |
| Ctrl-C / SIGTERM (`RAY_INTERRUPTED`, exit 6) | `pg_restore` ended and rolled back; marked failed if anything was restored | as above |
| The process was killed outright | possibly half restored; `import.json` says `IMPORTING`, the plaintext is in `<target>/scratch/` | run the import again: it removes the plaintext, closes the killed run's receipt and marks the target failed; then `--discard-failed` |
| The restore verified but `--secrets-out` could not be written | marked failed and fenced | `--discard-failed`, then import again with a new `--secrets-out` |

`--discard-failed` removes every object the migration role owns in both target databases (it owns
everything the import restored), everything in the blob root, and the deployment and import records
of the state directory; the receipts stay. It refuses a target that is ready for its cutover or holds
a deployment, and touches no database that does not record the failed import's deployment id (or,
when the restore failed before the application database, holds anything at all). The source is never touched by an import, whatever happens.

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
