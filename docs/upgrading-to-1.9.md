# Upgrading to 1.9

This guide takes a deployment from RaySpec 1.8.x to 1.9.0. It lists what changes when you only
upgrade, every behavior change in the [changelog](../CHANGELOG.md#190---2026-10-05) with what you do
about it, how to turn on the hardened posture this release adds, the new commands, the Node floor
and the migrations that run on the first boot. [From 1.9.0 to 1.9.1](#from-190-to-191) is the
section for a deployment that already runs 1.9.0, and for what 1.9.1 adds on the way from 1.8.x.

## The short version

An existing deployment needs nothing new. Upgrade Node if it is older than 22.21.0, take a backup,
install 1.9.1 and start the deployment the way you started it before
([From 1.9.0 to 1.9.1](#from-190-to-191) lists what the patch release asks for). Role separation,
row-level security, single-tenant mode, the managed posture and the execution bounds stay off until
you set them; a YAML deploy boots and prints as before; every existing command keeps exit codes 0,
1 and 2 for the outcomes it had.

The upgrade is checked with data before every release: deployments of three example applications
(one of them with a compiled extension) are created with 1.7.0 and with 1.8.0 (and, from 1.9.1 on,
with 1.9.0), written to and upgraded, and afterwards every row is compared, the passwords and API
keys made before the upgrade still work, and a bundle deploys onto the upgraded environment; one
more variant turns role separation on during the upgrade.

## Before you upgrade

1. **Node.** Every package now declares `engines.node` `>=22.21.0` (it was `>=22`). npm and pnpm
   only warn on a mismatch unless they run engine-strict, so check the host:

   ```bash
   node --version   # v22.21.0 or later on the 22 line
   ```

   CI and the [runtime image](./runtime-image.md) use 22.23.3. The 23 line is admitted by the range
   but lacks `NODE_USE_ENV_PROXY`; the server checks for it at run time, as in 1.8.0.

2. **Back up both databases**, the application database and, with a durable worker, its workflow
   system database. The first boot of 1.9.0 migrates the platform schema. A 1.8.x runtime does not
   detect a database that 1.9.0 has migrated and boots on it, so going back is unsupported and must
   start from that backup.

3. **Stop scripts from treating exit 2 as the only failure.** An unexpected internal error of the CLI
   now exits 7.

## The migrations that run

The first boot (`rayspec deploy <spec.yaml>`, `rayspec-serve`, a bundle deploy or
`rayspec tenant ensure`) runs the platform migrations `0012` to `0017`. Each one is additive:
no existing table is rewritten and no row is read or changed.

| Migration | What it adds |
| --- | --- |
| `0012_runtime_control` | `runtime_control_state` (one row: the environment revision, the source fence, the operation lease) and the append-only `runtime_control_receipts` |
| `0013_runtime_control_processes` | `runtime_control_processes`, one heartbeat row per running process |
| `0014_product_migration_ledger` | `product_migration_ledger`, the append-only record of every product schema change; an environment deployed before it starts with an empty ledger |
| `0015_tenant_row_security` | the row-level policies of the core tenant tables and three functions; it **enables nothing**, so with one database role the deployment behaves exactly as before |
| `0016_owner_recovery` | `owner_recovery_tokens`, for `rayspec tenant recover-owner` |
| `0017_runtime_control_blob_backend` | one nullable column on `runtime_control_state`, filled by the next bundle deploy |

The chain runs as a `runtime.apply` operation: under the operation lease, after settling any
interrupted apply, with receipts and the environment revision raised. A boot that refuses leaves the
database untouched. A restart with nothing to change takes no lease and writes nothing.

`owner_recovery_tokens` is now a reserved store name. A product that declared a store of that name
must rename it before upgrading.

## What changes without opting in

Each item applies to every deployment, hardened or not.

| What changes | What you do |
| --- | --- |
| A YAML deploy changes the schema through apply, so it has four new refusals: a schema change on a fenced environment (`RAY_POLICY_DENIED`, exit 4), a plan made stale by a concurrent change (`RAY_PLAN_STALE`, 3), another operation holding the lease past the wait (`RAY_LOCK_TIMEOUT`, 5), and an interrupted apply that needs reconciling (`RAY_RECONCILIATION_REQUIRED`, 6). `rayspec-serve` keeps exit 1. | Nothing for a single deploy at a time. A script that runs deploys should handle 3 to 6; a `5` is retried when the other operation has finished, a `6` is resolved as [Runtime operations](./runtime-operations.md#recovering-from-an-interrupted-operation) describes. |
| An unexpected internal failure of the CLI exits 7, not 2. | Treat 7 as a defect to report. On existing commands, 2 still means a usage error; the new bundle, pack, export and import verbs also use 2 for a refused input (see the [CLI reference](./cli-reference.md#conventions)). |
| Every existing command accepts `--json`, which wraps its usual result object in the contract's envelope. Without the flag the output is byte-identical. | Nothing; use `--json` where a script parses output. |
| Log lines, error envelopes, receipts and traces are redacted: a credential shape or a value the process holds as a secret is replaced by `[redacted]`. | A log parser that matched on such a value matches on the name around it instead. |
| Messages say "extension" where they said "pack" (for example `deploy --check-env`: "no extension is loaded", "declares N extension(s)"; the extension loader's errors). | Update alerting rules that match the old wording. |
| An async agent run reads `running` while it executes, not `enqueued`. | A client that waited for `enqueued` to change waits for a terminal state instead. |
| A run that throws, or hits `RAYSPEC_AGENT_RUN_MAX_MS`, is recorded terminal `error` with its class; it no longer reads `enqueued` or `running` for ever. A same-key retry of such a tainted run replays the recorded failure instead of answering `409`. | A client that retried on `409` reads the replayed `error` and starts a new run with a new key if it wants another attempt. |
| A cancelled run keeps the journal steps it wrote before it ended. | Nothing; the journal is more complete. |
| The durable worker no longer holds a database transaction for the length of a run; a tool's writes commit as they happen, as on the in-request path. | Nothing. A run waiting on a slow provider no longer holds a connection. |
| A codex child that ignores `SIGTERM` is killed after `RAYSPEC_AGENT_KILL_GRACE_MS` (default 5000 ms). | Raise the variable if a codex agent needs longer to shut down. |
| `RAYSPEC_AGENT_RUN_MAX_MS`, when set, aborts the run's provider call and records the run terminal. An unusable value of any execution-policy variable refuses the boot. | Check the values you set; [Bounded execution](./hardened-posture.md#bounded-execution) lists them. |
| The anthropic backend's child process no longer inherits the other providers' keys, any `_FILE` variant, the database URLs (`DATABASE_URL`, `SHADOW_DATABASE_URL`, `DBOS_…`, `PG…`) or any `RAYSPEC_…` and `CLOUD_…` setting. | A tool run by that child process that read one of those from its environment must be given it another way. |
| The openai backend no longer registers its key or client as the agent SDK's process-wide default. | Code outside RaySpec that relied on that default sets it itself. |
| Changing the API-key pepper invalidates API keys, refresh sessions, invite tokens and owner-recovery tokens (the documentation used to name only API keys). | Rotate with `RAYSPEC_API_KEY_PEPPER_PREVIOUS` set to the old pepper for an overlap window ([The API-key pepper](./hardened-posture.md#the-api-key-pepper)). |
| A shutdown no longer waits for ever on an open connection; it is bounded by `RAYSPEC_SHUTDOWN_DRAIN_MS` (default 10000). | Raise it if long requests must finish on shutdown. |
| `GET /health` has a time bound on its database round trip, and `GET /livez` is new. | Point a liveness probe at `/livez` and a readiness probe at `/health`. |

## The hardened posture

1.9.0 adds a hardened hosting posture for a runtime reachable by people you do not fully trust. It is
off until you turn it on, and each part can be turned on alone:

| Setting | Turns on |
| --- | --- |
| `RAYSPEC_MIGRATION_DATABASE_URL` with the roles of `database-roles.sql` | role separation and forced row-level security |
| `RAYSPEC_SINGLE_TENANT=true` | one organization per runtime; registration only creates the first |
| `RAYSPEC_HOSTING_POSTURE=managed` | default execution bounds, the supported-backend matrix, required handler rights, no agent trace export by default, cross-process run cancellation |
| `RAYSPEC_TRUSTED_PROXIES` | which proxies' forwarding headers are believed |

To turn it on for an existing deployment:

1. Take a backup.
2. Create the roles on the application database (and on the workflow system database, with
   `SET rayspec.database_kind = 'workflow-system'`) and set their passwords, as
   [Database roles and row-level security → Turning it on](./database-isolation.md#turning-it-on)
   shows. On a database that already holds a deployment the script hands the objects to the
   migration role and grants the runtime role its privileges; rows are not touched.
3. Point `DATABASE_URL` at the runtime role and `RAYSPEC_MIGRATION_DATABASE_URL` at the migration
   role (and `RAYSPEC_SNAPSHOT_DATABASE_URL` at the snapshot role if you will export). Pass these in
   the process environment, not as `_FILE` or in a `.env` file.
4. Settle the one organization if you set `RAYSPEC_SINGLE_TENANT=true`: a database that already
   holds more than one organization, soft-deleted ones included, refuses the boot.
5. Set `RAYSPEC_HOSTING_POSTURE=managed` last, after the checks below hold, and restart.

What changes once it is on, and what you do:

| With role separation or single-tenant mode on | What you do |
| --- | --- |
| `rayspec deploy` and `rayspec-serve` run as a supervisor that holds the migration role and a child that serves the application. | A process manager keeps starting, signalling and watching the one process it started. |
| Starting or cancelling an agent run rereads the membership; a queued durable run is re-checked when the worker starts it (a run enqueued before the upgrade runs as before). | Nothing; a removed or demoted member loses access at once instead of at token expiry. |
| A playback token stops working once its user is no longer a member. | Nothing. |
| A stream handler no longer receives `authorization`, `proxy-authorization`, `cookie` or a playback route's `?token=`. | A handler that read the caller from them reads `init.principal`. |
| The `error` frame of a streamed run carries a fixed message per class, and an agent definition its backend cannot run answers without the validator's detail. | Read the detail from the server log. |
| Every tenant-chokepoint statement runs under the tenant context, which costs a short transaction per standalone statement (measured locally at about 1.35 ms instead of 0.59 ms for a small read). | Nothing. |

| Under `RAYSPEC_HOSTING_POSTURE=managed` | What you do |
| --- | --- |
| Every handler declares `uses` (an empty list for one that uses no optional capability). | Add `uses` to each handler before turning the posture on. |
| The anthropic, codex and pi backends and a fake speech provider are refused at boot. | Move those agents to `openai`, or keep the posture off. |
| On Linux the boot refuses a host where the child could read the supervisor's memory or make it write a core file. | Set `kernel.yama.ptrace_scope` to 1 or more (Docker Desktop's VM has no Yama; RHEL/Fedora-style kernels default to 0), and keep `/bin/sh` in the image or start with `--ulimit core=0`. |
| A `_FILE` or `.env` file the supervisor reads must not be readable by the child. | Pass the privileged connections in the environment. |
| The execution policy's defaults bound every run. | Override a bound with its variable where a workload needs more. |

[Hosting in the hardened posture](./hardened-posture.md) is the full guide, including how to check
the posture from outside, the managed-posture receipt a release carries, and what the posture does
not protect against. The [threat model](./threat-model.md) lists every accepted residual risk.

## The new commands

| Command | What it does |
| --- | --- |
| `rayspec pack` | Builds a `.ray` application bundle from an application that is already built ([Packing an application](./packing.md)). |
| `rayspec bundle inspect <file.ray>` | Checks the archive and reports what the bundle is; runs and writes nothing. |
| `rayspec bundle verify <file.ray>` | Everything inspect checks, plus the runtime, target, capabilities, spec, secret scan and signature. |
| `rayspec bundle sign <file.ray> --key-file <pem>` | Writes the detached Ed25519 signature `bundle verify` and `deploy --require-signature` check. See [packing](./packing.md). |
| `rayspec deploy <file.ray>` | Deploys a bundle: a dry run that prints a plan digest, then the deploy of that digest ([Self-hosted deployment](./self-hosted-deployment.md)). |
| `rayspec export` | Moves a self-hosted deployment out as one encrypted migration bundle ([Exporting a deployment](./export.md)). |
| `rayspec import` | Restores a migration bundle into a new, empty target ([Importing a deployment](./import.md)). |
| `rayspec resume` | Lifts the source fence an interrupted export left. |
| `rayspec tenant recover-owner` | Issues a one-time recovery token for an organization owner who holds no password, redeemed at `POST /v1/auth/owner-recovery`. |

Each is described with its flags, output and exit codes in the [CLI reference](./cli-reference.md).

`rayspec deploy` of a file whose name ends in `.ray` (any case), or that starts with a ZIP
signature, now takes the bundle path. It used to read such a file as YAML. A bundle deploy reads no
`.env` file and needs `DATABASE_URL`, `RAYSPEC_API_KEY_PEPPER` and, for a schema change,
`SHADOW_DATABASE_URL` in the process environment. A YAML spec deploys exactly as before.

## If you deploy bundles

- **A bundle pins its runtime.** After upgrading the CLI, repack each application with the new
  release before deploying it; a bundle packed for another runtime version is refused with
  `RAY_RUNTIME_UNSUPPORTED`.
- **The bindings file supplies only names the bundle declares** (plus the selected speech provider's
  key); any other name is refused with `RAY_USAGE`. A provider key goes to its adapter alone, not
  into the process environment; the application's own names are written there and are available to
  handlers as `init.bindings.get(name)`.
- **The first bundle deploy onto an environment a YAML deploy created** plans against the product
  tables that deploy made. A bundle that only matches them, or only adds whole stores, deploys; one
  that carries a product delta is refused until one change through `rayspec deploy <spec.yaml>` has
  started the product migration ledger.
- **Version directories are read-only.** Remove one that is no longer active with
  `chmod -R u+w <dir> && rm -rf <dir>`.
- **`rayspec export` of an application that loads extensions** is refused
  (`unsupported-blob-adapter`) until the deployment has had one bundle deploy with 1.9.0, which
  records where its blobs live.

## For embedders and maintainers

- `@rayspec/server` exports the bundle deploy's, apply's, export's and import's building blocks; the
  [changelog](../CHANGELOG.md#190---2026-10-05) lists them.
- `isSensitive` in `@rayspec/auth-core` takes the posture as an optional second argument.
- The repository script `release:pack` is now `release:tarballs`.
- The bundle contract this release implements is revision `1.0.0-rc.2`; every envelope, receipt and
  runtime-control request states `contractVersion` `1.0.0-rc.2`.

## From 1.9.0 to 1.9.1

1.9.1 is a patch release: fixes, two opt-in additions and dependency updates, listed in the
[changelog](../CHANGELOG.md#191---2026-10-07). From 1.8.x, go straight to 1.9.1: everything above
applies, and so does this section.

**The short version.** Install 1.9.1 and start the deployment the way you started it before. No
platform migration runs: the chain ends at `0017`, as in 1.9.0, and no product table changes. If
you set `RAYSPEC_TRUSTED_PROXIES`, check the list first (below). If you serve a static mount at the
root, look at its `.well-known` directory first (below). If you deploy bundles, repack them with
1.9.1: one packed for 1.9.0 is refused with `RAY_RUNTIME_UNSUPPORTED`. An extension whose
`package.json` pins a `@rayspec/*` package to exactly `1.9.0` moves the pin to `1.9.1`, or to a
range that includes it, before repacking. A snapshot pins its runtime as a bundle does: an export
taken on 1.9.0 is [imported](./import.md) with 1.9.0, and the upgrade follows the import.

| What changes | What you do |
| --- | --- |
| An entry of `RAYSPEC_TRUSTED_PROXIES` that names no range refuses the boot, and the message names it: an address that does not parse, or a missing or malformed prefix length (`10.0.0.0/`, `10.0.0.0/8.0`, `10.0.0.0/33`). 1.9.0 read an empty prefix as `/0`, read `/8.0` as `/8`, and accepted an entry that matched nothing. | Correct or remove such an entry **before** upgrading. |
| An entry inside the IPv4-mapped block `::ffff:0:0/96` with a prefix of `/96` to `/128` matches the IPv4 range it carries, where it matched no dotted peer; `::ffff:0:0/96` itself is every IPv4 address. Every spelling of an IPv4-mapped address (`::ffff:a01:203`) is the IPv4 address it carries, in the rate-limit bucket, the address stored with a session and the audit log's address hash. | Review a list that carries such an entry. |
| An audio session reads `completed` once all its tracks are sealed, and `recording` again while a track that started later is uploading. 1.9.0 wrote `recording` and never changed it. | A client that treated `recording` as the only session status accepts `completed`. |
| Chunk 1 of a new track, sent while chunk 0 is still being stored, is answered `409` with `"error": "gap"` and `next_expected_index: 0`; 1.9.0 waited and answered `200`. A rejected chunk no longer creates a session or a track row. | A client that uploads a track's chunks in parallel resumes from the index the answer names. |
| A recording with a chunk that is not Ogg, or that ffmpeg cannot read, fails. 1.9.0 stitched it up to that chunk and treated the shortened result as the whole recording. | Nothing for recordings of intact Ogg-Opus chunks. |
| A static mount at `route: /` serves the `.well-known` directory of its `dir`. | Look at what a build already placed in that directory before upgrading. |
| `rayspec bundle verify` and the dry-run of a bundle deploy write `warning: media tools missing` to stderr when the bundle requires `audio_input` or `media_playback` and the host has no `ffmpeg` or `ffprobe`. The envelope and the exit code are unchanged. | Install both tools, or name them with `RAYSPEC_FFMPEG_BIN` and `RAYSPEC_FFPROBE_BIN`. |
| The [runtime image](./runtime-image.md#ffmpeg-and-ffprobe) carries ffmpeg and ffprobe and is larger: 1.75 GB unpacked where it was 1.30 GB, 572 MB as an archive where it was 402 MB. Its build also needs snapshot.debian.org. | Rebuild the image from the 1.9.1 tarballs and the Dockerfile at the `v1.9.1` tag ([Getting the image](./runtime-image.md#getting-the-image)); drop a layer of your own that added ffmpeg on 1.9.0. |
| `@rayspec/adapter-codex` pins `@modelcontextprotocol/sdk` `1.31.0`, the first version outside GHSA-6qxp-vccf-f47h. The pin is exact, so an install of 1.9.0 resolves `1.29.0`. | Upgrade; nothing else moves that copy. |

### Settling audio sessions and rows 1.9.0 left

Nothing here is needed for the runtime to work. It makes a session list right for a product that
declares `audio_input` and recorded on 1.9.0, where a finalized session kept `recording` and a
rejected chunk left an empty session and track behind. Run the three statements once, in this
order, on the application database, after the upgrade and at a moment when no recording is being
uploaded. With role separation, run them as the migration role, which sees every tenant's rows.

```sql
-- Track rows a rejected chunk left: a track at `recording` with no chunk never held one.
DELETE FROM audio_tracks WHERE status = 'recording' AND persisted_chunk_count = 0;

-- Sessions left with no track.
DELETE FROM audio_sessions s
 WHERE NOT EXISTS (SELECT 1 FROM audio_tracks t WHERE t.session_pk = s.id);

-- Sessions whose tracks are all sealed.
UPDATE audio_sessions s SET status = 'completed'
 WHERE status = 'recording'
   AND NOT EXISTS (SELECT 1 FROM audio_tracks t
                    WHERE t.session_pk = s.id AND t.status <> 'completed')
   AND EXISTS (SELECT 1 FROM audio_tracks t WHERE t.session_pk = s.id);
```

The order matters: an empty track left in place keeps its session at `recording`. Without the
statements, a session settles the next time one of its tracks is finalized again; a finalize with
the same `total_chunks` is idempotent.

### What you can turn on

| Setting | What it does |
| --- | --- |
| `span_granularity: sentence` on the `stt` capability of a product document | One transcript span per sentence instead of one per paragraph ([spec reference](./spec-reference.md#span_granularity-on-stt)). **Span ids change with it:** `<track>:s<index>` counts sentences, so evidence stored under one value does not match transcripts produced under the other, and nothing is migrated. Choose the value before a product stores evidence. Nothing caps the number of spans. |
| `RAYSPEC_STT_FAKE_FIXTURES`, `RAYSPEC_STT_FAKE_FALLBACK=fixed`, `RAYSPEC_EXTRACTION_DETERMINISTIC_STAND_IN=true` | A deployed product runs from upload to extracted rows with no provider key, for development and tests ([getting started](./getting-started.md)). `RAYSPEC_HOSTING_POSTURE=managed` refuses each of them at boot. |

## Going back

Downgrading a migrated database is not supported. A 1.8.x runtime does **not** detect a database
that 1.9.0 has migrated: it boots and serves on it without a warning, so nothing stops a rollback that
skips the backup. Only 1.9.0 and later refuse a database that a newer runtime migrated. To go back,
restore the backup you took before the upgrade, together with the boot secrets it was taken under,
and start 1.8.x on it.

Going from 1.9.1 back to 1.9.0 needs no restore: both run on the same platform schema. Take
`span_granularity` out of a product document that declares it, which 1.9.0 does not know, and
deploy the bundle packed for 1.9.0 again. Audio sessions 1.9.1 marked `completed` keep that status.
The upgrade check runs forward only, so this direction is not exercised before a release.
