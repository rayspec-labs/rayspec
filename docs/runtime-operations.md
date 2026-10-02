# Runtime operations

This page is for the operator of a RaySpec environment: what the runtime records when it
changes the environment, how the lifecycle operations fit together, and what to do when one of
them was interrupted. The design behind it is in
[Architecture → Runtime control](./ARCHITECTURE.md#runtime-control).

An **environment** is one application database (with its workflow system database and blob root)
and every runtime process that serves it. Its runtime-control state lives in platform tables of
the application database:

| Table | Holds |
| --- | --- |
| `runtime_control_state` | one row: the environment revision, the source fence and its epoch, the operation lease (holder, fencing epoch, expiry), the binding revision key, the product schema digest the last apply left, the active application and the blob backend its boot resolved |
| `runtime_control_receipts` | append-only receipts of every operation that changed the environment: who, what, each step's start and finish, the outcome |
| `product_migration_ledger` | append-only, one row per applied product schema change: the DDL and its SHA-256, the product schema digest before and after, the schema description after, the declared stores, the operation that applied it |

The two runtime-control tables are never exported in a snapshot; the ledger is, like the platform
migration ledger, because it describes the product tables the snapshot carries. No receipt or
ledger row holds a secret, a binding value or a connection string.

## The operations

The operations are a typed library in `@rayspec/server` (`createRuntimeControl`, `runApply`). They
add no HTTP route: a caller holds the environment's database connection. `rayspec deploy` and
`rayspec-serve` use them for every schema change a boot makes.

| Operation | Changes the environment | What it does |
| --- | --- | --- |
| `inspect()` | no | The runtime version and target, capabilities, the two-part schema head, the active application, the fence and the environment revision. |
| `inspectHosting()` | no | The hosting posture, whether cross-process run cancellation is on, the application tenant limit (`applicationTenants`: `singleTenantMode` and `maxApplicationTenants`, read from `RAYSPEC_SINGLE_TENANT`), the execution policy, the supported-backend matrix, and who enforces egress (`egress`: the host network policy; [Egress](./hardened-posture.md#egress)). |
| `inspectDatabaseIsolation()` | no | With `runtimeRole` set, whether the runtime role holds the isolated database posture, and each check it fails ([Database roles and row-level security](./database-isolation.md)). `inspect()` reports the managed posture as supported only when it does, the release carries a capability receipt and single-tenant mode is on ([Hosting in the hardened posture](./hardened-posture.md)). |
| `prepare()` | no | Plans a `.ray` bundle against the live schema: a plan with its digest, valid for 30 minutes. |
| apply (`runApply`) | yes | Runs a plan's steps under the operation lease with receipts; see below. |
| `quiesce()` | yes | Takes the source fence: mutations answer 503, producers stop, in-flight work drains. With role separation (`runtimeRole`, over a connection as the migration role) it also revokes the runtime role's writes until `resume()`. |
| `resume()` | yes | Releases the fence held at the epoch `quiesce()` returned. |
| `health()` | no | Liveness and readiness with each failing check's cause. |

Only one operation that changes the environment runs at a time: each takes the **operation
lease** in `runtime_control_state` first. A second one is refused with `RAY_LOCK_TIMEOUT`
(retryable) or, when its caller waits, runs after the first has finished. An apply's lease lives
60 seconds and is renewed while the apply runs, so the lease of a process that died expires within
a minute (a boot waits that long, plus the schema lock wait, before it gives up); a holder that
stalled past its expiry and was replaced can no longer write anything. A live lease is never taken
over, not even by a retry under the same operation id: the earlier attempt may still be running a
step, so the retry is refused with `RAY_LOCK_TIMEOUT` until that lease has expired.

## Apply

An apply checks, in this order, before it changes anything:

| Check | Refusal | Exit class |
| --- | --- | --- |
| The idempotency key names an earlier apply of another plan | `RAY_IDEMPOTENCY_CONFLICT` | 4 |
| The expected environment revision is not the live one, the plan expired, or the plan digest recomputed from the live state differs | `RAY_PLAN_STALE` | 3 |
| The plan has blockers | `RAY_POLICY_DENIED` (`plan-has-blockers`) | 4 |
| The environment is fenced | `RAY_POLICY_DENIED` (`fenced`) | 4 |
| Another operation holds the lease | `RAY_LOCK_TIMEOUT` (retryable) | 5 |
| An earlier apply left a step whose outcome is unknown | `RAY_RECONCILIATION_REQUIRED` | 6 |

A refused apply changed nothing. Then it runs its steps, each between a `step-started` and a
`step-finished` receipt (`step-skipped` when there was nothing to do), and records the outcome.
When a step ran, the environment revision rises by one in the same transaction as the outcome,
which makes every plan prepared before it stale.

Replaying an apply with the **same idempotency key** and the same plan returns the recorded result
(`already-applied`, with the original receipts) and runs nothing again. A key whose apply was
refused before it changed anything can be retried, and so can one whose apply was interrupted —
also after another apply or a boot closed it as interrupted (`interrupted: true` below): the
retry continues that operation under its own operation id, through the same checks, and does not
run a step it already finished. One whose apply failed returns the recorded failure — use a new
key with a new plan. Two retries of one interrupted apply at once do not both continue it: the
second is refused with `RAY_LOCK_TIMEOUT`.

## What a deploy records

`rayspec deploy <spec.yaml>` and `rayspec-serve` make at most two kinds of schema change, each
as its own apply with the actor `runtime-boot`:

- **`platform-migrations`**: the platform migration chain, when the database's ledger is behind
  this runtime (an upgrade). All pending migrations run in one transaction.
- **`product-ddl`**: each product-store migration — the first materialization of a spec's stores,
  or a reviewed delta from `--apply-migration`. The DDL, its row in the product migration
  ledger, the product schema digest the environment now has and the step's finish receipt commit
  in one transaction. Before any DDL runs, the step refuses with `RAY_SCHEMA_DRIFT` a live product
  schema the ledger's latest row does not describe, and a ledger row a newer runtime wrote.

A restart that has nothing to change takes no lease and writes nothing; if an earlier apply was
interrupted and its receipts and the live state settle it, the restart settles it first (below).
On a blocked environment it writes nothing at all. Two replicas starting at
once serialize on the lease; the platform chain of the second finds nothing left to do. A deploy
that would change the schema of a fenced environment is refused, and `resume()` has to release
the fence first. The chain that first creates the two tables above, on a database from before
they existed, runs outside apply (under the shared schema lock, as before), because there is
nowhere to record it yet.

`rayspec deploy <file.ray>` makes its change as ONE apply with the actor `rayspec-deploy`, whose
idempotency key is the plan digest the operator accepted, so running the same deploy again after
an interruption continues that operation while the plan is valid (30 minutes from the dry-run);
after that the plan is refused as `RAY_PLAN_STALE`, and a new dry-run and its digest finish the
deploy. Its steps, in order:

| Step | What it does | After a crash |
| --- | --- | --- |
| `stage-bundle` | verifies the version directory the bundle was extracted into against the manifest's inventory | re-runnable |
| `platform-migrations` | the platform migration chain, when the database is behind this runtime | read from the platform ledger |
| `product-ddl` | the product change regenerated from the ledger and the bundled spec, its ledger row and the finish receipt in one transaction | rolled back with its transaction unless its finish receipt committed |
| `record-application` | the deployment id, the application, its digest, its grants and the blob backend the boot resolved for it (the platform's fs store, none, or the extension that provides one) in `runtime_control_state` | committed with its finish receipt |
| `activate` | replaces `active.json` in the state directory in one rename | re-runnable |

The active version switches last, so a deploy that stops before it leaves the previous version
active. A schema change that committed is not reversed; the deploy is finished forward (see
[Deploying a bundle → Recovery](./self-hosted-deployment.md#recovery)). On a database without the
runtime-control tables the platform chain that creates them runs first, outside apply, once the plan
is accepted.

To read what happened:

```sql
SELECT operation_id, event, step, outcome, detail, recorded_at
  FROM runtime_control_receipts
 ORDER BY id DESC
 LIMIT 50;
```

## Product schema changes

Product stores are generated from the spec, so their tables have no migration files of their own.
The **product migration ledger** is their record. Its latest row is what the live product schema
must be, and it holds the declared stores the schema implements, so the next change can be
generated from it. `prepare()` plans a bundle's product change from the live database and the
ledger, never from what the bundle says about itself:

| Finding | Blocker | Exit class |
| --- | --- | --- |
| The live product schema differs from the ledger's latest row (the message names each table and column), or the ledger's changes, regenerated from the stores each row records, do not reproduce it on a throwaway database | `RAY_SCHEMA_DRIFT` | 6 |
| A ledger row has a format this runtime does not read: a newer runtime changed the product schema | `RAY_SCHEMA_DRIFT` | 6 |
| The bundle changes the stores but carries no delta (pack it `--against` the running spec) | `RAY_MIGRATION_REQUIRED` | 3 |
| The bundle's delta migrates from a product schema digest that is not the live one | `RAY_MIGRATION_REQUIRED` | 3 |
| The bundle's delta differs by one byte from the delta regenerated from the ledger and the bundled spec, or its digest after is not the one the delta produces | `RAY_MIGRATION_MISMATCH` | 3 |
| The regenerated delta is destructive and the bundle's reviewed allowlist does not clear every statement (the message names each store and column and the review step) | `RAY_MIGRATION_REQUIRED` | 3 |
| The product schema changes and no shadow database is configured | `RAY_MIGRATION_REQUIRED` | 3 |

The digest after a delta is computed on a throwaway database on the shadow server: the platform
chain, then every ledger row's change regenerated from the declared stores it records (the DDL
text a row holds is never run again), then the delta. The bundle's own `destructive` flag
is advisory; the runtime's destructive-statement scanner reads the regenerated delta. The plan's
`schemaImpact` says whether the delta is destructive and whether the allowlist cleared it.

The apply step (`productDdlStep`) checks the ledger again under the shared schema lock, runs the
DDL, writes the ledger row, and refuses a result other than the head the plan computed; any refusal
rolls the DDL back with it.

**An environment deployed before the ledger existed** has product tables and no ledger rows. Its
product schema head is introspected (warning `RAY_W_PRODUCT_SCHEMA_UNLEDGERED`), a bundle whose
stores match it or only add whole tables is planned as before, and a bundle that carries a delta is
refused, because there is no record to regenerate it from. Deploying a product change once through
`rayspec deploy <spec.yaml>` (a first materialization or `--apply-migration`) starts the ledger.

**When drift is reported**, undo the change by hand until the live schema is the one the ledger
describes (the message names what differs), then make the change you wanted through a reviewed
product change: a bundle packed `--against` the running spec, or `rayspec deploy --apply-migration`.
Every product DDL step refuses to run on a drifted schema. The ledger is append-only: a trigger
refuses UPDATE, DELETE and TRUNCATE, and no runtime rewrites a row.

To read it:

```sql
SELECT id, migration_name, product_schema_before, product_schema_after, operation_id, applied_at
  FROM product_migration_ledger
 ORDER BY id;
```

## Recovering from an interrupted operation

A process can die anywhere: a crash, an out-of-memory kill, a lost host. The next apply, and the
next boot, first read the receipts of every apply that has no outcome or has a step with a start
and no finish, and settle each from what its receipts prove and what the live state shows:

| The process died | What the next apply or boot finds | What happens |
| --- | --- | --- |
| after taking the lease, before any step | an intent and nothing else | the operation is closed as interrupted (`outcome: failed`, `interrupted: true`); the new apply proceeds |
| after a step started, before its effect | a start; the step's observer reads the state from before | the step is closed as not applied (`step-skipped`); a new plan runs it |
| after a step's effect, before its finish receipt | a start; the observer reads the state the step expected | the step is closed as applied (`step-finished`) and is not run again |
| in the middle of product DDL | a start without a finish — the DDL and its receipt commit together, so the DDL was rolled back | closed as not applied; the schema is as before and the next deploy applies it |
| after the platform chain committed, before its receipt | a start; the ledger is at the head the step expected | closed as applied |
| during a step nothing can read back | a start; no observer, or a state that is neither before nor after | **blocked**: `RAY_RECONCILIATION_REQUIRED` |

Reconciliation receipts are added to the interrupted operation's own record, with
`reconciledBy` naming the operation that settled it; a boot also prints one line per settled
operation on stderr. Nothing is replayed blindly, and no schema change is ever reversed
automatically — recovery from a schema change you do not want is a reviewed forward migration.

### A blocked environment

While a step's outcome is unknown, every apply, and every boot that has a schema change to make,
is refused with `RAY_RECONCILIATION_REQUIRED`, and `rayspec deploy` exits `6`. A boot with nothing
to change prints a warning and serves the schema it finds. The refusal names the operation and
the step. To clear it:

1. Read the operation's receipts. The `step-started` receipt's `detail` says what the step
   expected; the `intent` says who ran it and when.

   ```sql
   SELECT event, step, outcome, detail, recorded_at
     FROM runtime_control_receipts
    WHERE operation_id = '<operation id from the refusal>'
    ORDER BY id;
   ```

2. Establish, outside RaySpec, what the step actually did: whether the external system received
   the call, whether the object exists.
3. Record it. `resolveInterruptedStep` closes the step as `applied` or `not-applied` on the
   interrupted operation's record, with `manual: true` and your actor, under the operation lease:

   ```ts
   import { randomUUID } from 'node:crypto';
   import { makeDb } from '@rayspec/db';
   import { resolveInterruptedStep } from '@rayspec/server';

   const db = makeDb(process.env.DATABASE_URL as string, 2);
   const result = await resolveInterruptedStep(db, {
     operationId: randomUUID(),
     actor: 'operator@example.com',
     interruptedOperationId: '<operation id from the refusal>',
     step: '<step name from the refusal>',
     outcome: 'applied', // or 'not-applied'
   });
   console.log(result);
   await db.$client.end();
   ```

4. Deploy or apply again. A step recorded as not applied runs again only through a new plan.

Recording an outcome repeats nothing and reverses nothing; it only tells the next apply what you
found.

## Snapshots of a fenced source

An export carries the environment to another host as one encrypted snapshot. `rayspec export` runs
it ([Exporting a deployment](./export.md) is the operator guide); underneath it is a typed library
in `@rayspec/server`, like the operations above: `preflightSnapshot` checks the source,
`captureSnapshot` takes the plaintext inner snapshot archive under the fence, and `exportSnapshot`
encrypts that archive with age to one X25519 recipient and writes the migration bundle
(`writeMigrationBundle`). Nothing is written outside a private scratch directory but the bundle.

### What preflight checks

`preflightSnapshot` reads, writes nothing, and takes no fence. Every finding is a blocker, in this
order:

| Check | Blocker |
| --- | --- |
| The state directory's active bundle, rebuilt byte for byte with the one bundle writer, is the application the database records, built for this runtime; the deployment id is the state directory's and the database's | `RAY_USAGE`, `RAY_DIGEST_MISMATCH` (`bundle-sha256`), `RAY_RUNTIME_UNSUPPORTED` |
| The platform head is one this runtime ships; the product schema is the one the product ledger recorded | `RAY_SCHEMA_DRIFT` (warning `RAY_W_PRODUCT_SCHEMA_UNLEDGERED` without ledger rows) |
| The server major is 14 or later, and the `pg_dump` found has the same major | `RAY_TARGET_UNSUPPORTED`, `RAY_USAGE` |
| The role the dumps read as can read every table of both databases past row-level security | `RAY_USAGE` |
| The blobs are in the fs blob store, and its root holds nothing the store would not have written: no stray entry, link, malformed file or key a snapshot cannot carry. `rayspec export` passes an application that loads any extension as an unsupported blob source, with or without `RAYSPEC_BLOB_ROOT`, because an extension's blob backend comes before the fs store | `RAY_EXTERNAL_STATE_UNSUPPORTED` (`unsupported-blob-adapter`); an unreadable root: `RAY_INFRA_UNAVAILABLE`. The temporary file of an upload depends on the phase: before the fence (`live`, `preflightSnapshot`'s default) it is an upload in flight, counted in `uploadsInFlight` and in the budgets, not a blocker; under the fence (`quiesced`, the capture's preflight, after the drain) it is an upload that never finished: `unreconciled-effects`, and the fence stays |
| At most 500,000 objects, and the objects and the application within the migration archive limit (2 GiB); free space in the scratch directory for about twice the databases, objects and application | `RAY_LIMIT_EXCEEDED` (`object-index-size`, `migration-size`); `RAY_INFRA_UNAVAILABLE` |
| No database extension other than `plpgsql` in the application database, and none but `uuid-ossp` (which the durable engine's own migrations create) in the workflow system database | `RAY_POLICY_DENIED` (`unsupported-extension`) |
| Exactly one organization, and no blob of another tenant | `RAY_MULTI_TENANT_UNSUPPORTED` |
| A member of the organization holds a password, so someone can sign in after the import resets every API key, session and invite | `RAY_OWNER_RECOVERY_REQUIRED` |
| Every table is a platform table or a product store of the application, with a name `snapshot.json` can state; state the caller names that the snapshot cannot carry | `RAY_EXTERNAL_STATE_UNSUPPORTED` (`unknown-table`, or the reason the caller gives) |

### What the capture does

`captureSnapshot` takes the fence epoch `quiesce()` returned and the run-history policy (`included`
or `excluded`; there is no default). Before it reads anything for the snapshot it requires:

- the fence held at exactly that epoch (`RAY_FENCE_MISMATCH`; `RAY_SOURCE_NOT_QUIESCENT` when it was
  released);
- the database write barrier recorded with the fence held — the runtime role's writes revoked
  (role separation), or a stopped source the operator attested and quiesce checked. Without either
  it refuses with `RAY_EXTERNAL_STATE_UNSUPPORTED` (`database-barrier-unavailable`), and the fence
  stays held; object writes fenced, else `RAY_SOURCE_NOT_QUIESCENT`;
- every preflight check passing again;
- no session that could write: with the role barrier only the fenced runtime role's sessions may be
  connected, with a stopped source none but the export's own (`uncontrolled-writer`);
- no run, workflow run or workflow node still marked running (`unreconciled-effects`).

Then, in a directory of mode 0700 under the scratch parent, it rebuilds the deployed application,
copies every stored blob file into `objects.bin` in the order of the object index (hashing each
stored file, and the logical bytes against the digest its header states), and dumps each database
in custom format inside one `REPEATABLE READ READ ONLY` transaction whose snapshot `pg_dump` reads
(`--snapshot`), counting the rows of every table in that same snapshot. The workflow system database
is dumped whole whenever it exists at that moment. It then lists the blob root and reads the fence
again: a changed object or a released fence refuses the capture (`RAY_SOURCE_NOT_QUIESCENT`).
Finally it writes the inner archive (`snapshot.json`, `payload/application.ray`,
`payload/database.dump`, `payload/workflow-system.dump` when that database exists,
`payload/object-index.json`, `payload/objects.bin`) with the one snapshot writer, which reads it back
before it keeps it. Only the archive stays in the scratch directory; the caller removes the
directory once it has encrypted the archive. Any refusal or failure removes it at once, and so does
a stop request: an abort signal (`signal`) ends a running `pg_dump` and reports `RAY_INTERRUPTED`.

`exportSnapshot` runs the capture, encrypts the archive into the same directory with age to the
recipient (the age authors' implementation, `age-encryption`, tested against the official age test
vectors), and writes the migration bundle — `ray.json` of kind `migration` and the one payload file
`payload/migration.age` — beside the output, reads it back through the bundle reader and links it
into place with mode 0600. It removes the scratch directory on every path. A recipient that is not an
X25519 recipient (`age1…`) is refused; there is no passphrase mode.

The result says who read and which barriers held:

| Field | Values |
| --- | --- |
| `reader` | `snapshot-role` when a read-only snapshot role is configured; `single-role` when the dumps read with the one database role |
| `barriers` | `database-write-role`, `database-stopped-source` and `object-writes`, each `held`, `unavailable`, or `not-applied` for the form of the database barrier the fence did not use |

### What a snapshot carries

| Data category | Rows in the snapshot |
| --- | --- |
| identity and tenancy (organization, users with their password hashes, memberships), product stores, the tenant event bus, the platform and product migration ledgers, the whole workflow system database, every blob | yes |
| run history (runs, run events, journal steps, conversation items, workflow runs, nodes and artifacts) | as the run-history policy says |
| credential state (API keys, sessions, invites, OAuth artifacts), idempotency replay state, the authentication audit log, runtime-control state | never |

Tables whose rows stay at the source are dumped with their schema only, so the target reaches the
same schema head with them empty; their row count in `snapshot.json` is 0, the count they restore
with. `excludedDataCategories` lists every category whose rows were not exported, and the result's
`excludedTables` names each such table. The identity policy in `snapshot.json` states what the
target keeps (user ids, password hashes unless `passwordHashes: 'reset'` is asked for), resets
(sessions, API keys, invites, OAuth artifacts), reissues (the signing key, the API-key pepper, the
media signing key) and invalidates (media playback tokens).

### `pg_dump`

The dumps run the operator's `pg_dump`: the one named by an absolute path, or the first on `PATH`.
Its major version must be the server's. The connection reaches it through the libpq environment
(`PGHOST`, `PGUSER`, `PGPASSWORD`, …), never its arguments, and an inherited `PG*` variable is
dropped first. The suite that proves the capture (`snapshot-capture.db.test.ts`) uses the host's
`pg_dump` and `pg_restore` when their major is the server's; on a host without them it runs both
from the same pinned `postgres` image `docker-compose.yml` runs, through `docker run`.

## Importing a snapshot

`rayspec import` ([Importing a deployment](./import.md) is the operator guide) is built on a typed
library in `@rayspec/server` too, in four steps, each refusing with a contract code:

- `openMigrationBundle` reads the migration bundle with the one reader (the ciphertext's size and
  SHA-256 against the inventory before anything is decrypted), decrypts it with the operator's age
  X25519 identity into a private scratch directory within the migration plaintext limit
  (`decryptFile`), reads the inner snapshot archive with the same reader, compares every clear hint
  with the authenticated metadata, and reads the embedded application through the full reader
  pipeline for this runtime.
- `planDumps` reads each dump's table of contents from the archive bytes (`readDumpToc`), refuses one
  that `pg_restore --list` reads differently (`listDump`), and judges it by the restore allowlist
  (`planDumpRestore`): the kinds of object restored, the exact statements of each, one owner, no grant
  to an unknown role, no extension but the workflow engine's `uuid-ossp`, no role, event trigger,
  untrusted language, definer function beyond the platform's two, `COPY … PROGRAM`, or call into the
  dump from an expression the restore evaluates, and each entry in the section `pg_dump` puts its
  kind in. Its result is the list of entries to restore, ordered pre-data, data, post-data.
- `inspectImportTarget` checks, read-only, that the target's databases and blob root are empty, the
  server is the snapshot's major, the migration role is not privileged and the roles are prepared.
- `restoreImport` takes the shared schema lock on the target's application database and holds it
  while it withholds the migration role's default privileges that would give the runtime role writes,
  and `pg_restore` restores the approved entries of each dump in one transaction, as the migration
  role, with no owner, privilege, comment or tablespace from the dump (`restoreDump`), after which
  the catalog must hold exactly what the plan creates (`readCatalog`, `catalogDifference`); writes the
  stored blob files unchanged; brings the runtime role's posture in force (`applyTenantIsolation`)
  and checks it; verifies the row counts, foreign keys, schema head, the one organization, the empty
  credential tables and every object's digests; records each account's carried identity in the
  target's `auth_audit` (`applyIdentityPolicy`); checks the row counts and the catalogs again;
  records the target's own deployment id; and fences the target (`quiesce`), turning the fence into
  the import's hold (`import` in the barrier record) with the writes the runtime role is owed
  recorded for the cutover, then gives the default privileges back. A `resume` never releases a fence
  an import holds; `consumeCutoverToken` checks the cutover token (`issueCutoverToken`,
  `renewCutoverToken`) against its binding and the catalogs, marks it used, and only then does
  `resume`, given that cutover (`cutoverBy`), release it and grant the writes.
  `discardImportTarget` drops what the migration role owns in both databases, empties the blob root
  and gives back the withheld default privileges, for a target a failed import left.

The CLI then mints the target's own boot secrets (`mintBootSecrets`) into the directory
`--secrets-out` names. Each transition — `IMPORTING`, `VERIFYING`, `READY_FOR_CUTOVER`, `CUTOVER`,
`COMPLETE`, `BLOCKED` — is recorded by
`ImportReceiptLog` in the target state directory's local receipt and, once the target is verified, in
its `runtime_control_receipts` (kind `import`).

## Cross-process run cancellation

`POST /v1/runs/{id}/cancel` always records the cancellation, and a run that has not started never
starts. Whether it also stops a run that is already executing in **another** worker process
depends on the poll interval:

| Setting | Cross-process cancellation |
| --- | --- |
| `RAYSPEC_RUN_CANCEL_POLL_MS=<ms>` | on, at that interval |
| `RAYSPEC_HOSTING_POSTURE=managed`, no interval | on, every 2000 ms |
| neither | off: the run stops when it returns on its own |

`inspectHosting()` reports which applies to a process, together with the whole execution policy
and the supported-backend matrix ([Hosting in the hardened posture](./hardened-posture.md#bounded-execution)).

What the run's record says is what the process executing it observed: the cancellation step states
whether the provider call had not started (`before-call`), was stopped (`call-aborted`), had already
finished (`after-call`), or did not settle within the kill grace (`outcome-unknown`). The cancel
surface records `outcome-unknown` for a run it finds executing; the executing process replaces it
when it stops, so a record that still says `outcome-unknown` after the run ended means that process
could not report. `executor-cross-process-cancel.db.test.ts` in `@rayspec/durable-dbos` drives this
against a second, real worker process.

## Limits

- Receipts are never pruned; the table grows by a few rows per schema change.
- There is no CLI verb for `resolveInterruptedStep` yet; call it as above.
- `rayspec import` is not available yet: a migration bundle is written and verified, and restoring
  it into a new environment is the importer's part.
