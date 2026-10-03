# Deploying a bundle on your own server

This guide is for the operator who runs a RaySpec application on a server they control, from an
application bundle (`.ray`) that someone packed with [`rayspec pack`](./packing.md). It takes one
bundle from inspection to a served, updated and recovered deployment:

1. [Inspect](#inspect) what the bundle is and whether this runtime can run it.
2. [Bind](#bind) the values the application needs, without writing them anywhere else.
3. [Review](#review) the plan: what the deploy will change, before anything changes.
4. [Apply](#apply) the reviewed plan and serve.
5. [Check readiness](#readiness).
6. [Update](#update) to a new version of the application.
7. [Recover](#recovery) when a deploy is refused or stopped.

The flags, envelopes and exit codes are in the
[CLI reference](./cli-reference.md#deploying-a-bundle). What the runtime records while it changes the
environment is in [Runtime operations](./runtime-operations.md).

## What you need

- **The RaySpec CLI of the release the bundle pins.** A bundle names one exact runtime version
  (`runtime.version` in its manifest); a different CLI refuses it with `RAY_RUNTIME_UNSUPPORTED`.
  Install that release (`npm install -g rayspec@<version>`), run it with `npx rayspec@<version>`, or
  run the release's linux/amd64 [runtime image](./runtime-image.md) by the digest its signed release
  manifest names.
  You do not need the application's source tree: the bundle carries everything the application
  runs, and the runtime provides the `@rayspec/*` packages.
- **A PostgreSQL database** for the deployment, and a server where a throwaway database may be
  created and dropped for planning schema changes (`SHADOW_DATABASE_URL`; the same server is fine,
  the shadow database is created and dropped within one plan).
- **The boot secrets**: `RAYSPEC_JWT_SIGNING_KEY` (an RS256 private key in PKCS#8 PEM form) and
  `RAYSPEC_API_KEY_PEPPER`, as for any RaySpec deployment. Each also accepts a `<VAR>_FILE`
  variant naming a file.
- **Optionally, separate database roles.** With `RAYSPEC_MIGRATION_DATABASE_URL` set, the deploy
  changes the schema as a migration role and the application is served as a runtime role under
  row-level security; `DATABASE_URL` then names the runtime role. Set the roles up first with
  [Database roles and row-level security](./database-isolation.md). Without it, one role migrates
  and serves, as before.
- **Optionally, single-tenant mode** (`RAYSPEC_SINGLE_TENANT=true`), which holds the runtime to
  one organization; with role separation and `RAYSPEC_HOSTING_POSTURE=managed` it makes up the
  [hardened posture](./hardened-posture.md).

Everything the deploy reads comes from the **explicit process environment** and from the files
you name on the command line. A `.env` file in the working directory is **not** read on this path,
whatever `RAYSPEC_SKIP_DOTENV` says, so a stray `.env` cannot change what a production deploy
connects to or which keys it uses.

```bash
export DATABASE_URL=postgresql://app:…@db.internal:5432/app
export SHADOW_DATABASE_URL=postgresql://app:…@db.internal:5432/app_shadow
export RAYSPEC_JWT_SIGNING_KEY_FILE=/etc/rayspec/jwt.pem
export RAYSPEC_API_KEY_PEPPER_FILE=/etc/rayspec/pepper
```

## Inspect

Read what the bundle is before you run anything from it:

```bash
rayspec bundle inspect app.ray
rayspec bundle verify app.ray --trusted-key /etc/rayspec/publisher.pub.pem
```

`inspect` reports the application id and version, the runtime it pins, the capabilities it requires,
the binding names it declares, whether it runs code (`execution`: `none` or `in-process`), the hosts
it intends to call, and its SHA-256. `verify` runs every check a deploy runs on the bundle itself —
the archive, the manifest, the runtime, target and capabilities, the reserved binding names, the
spec, the fields derived from it, the secret scan and the signature — and says whether this runtime
can deploy it. Neither extracts, imports or runs anything. An unsigned bundle is accepted with the
warning `RAY_W_UNSIGNED`; `--require-signature` refuses it.

The signature is the `<file>.ray.sig` the publisher wrote with `rayspec bundle sign` (see
[Signing a bundle](./packing.md#signing-a-bundle)), and `--trusted-key` is the publisher's
**public** key; the private key never leaves the publisher. Get the public key from the publisher
through a channel you already trust, not from beside the bundle, and compare its SHA-256 with the
one the publisher states: `verify` prints it as `signature.publicKeySha256`. To deploy only signed bundles, pass the same two flags to the deploy:

```bash
rayspec deploy app.ray --dry-run --trusted-key /etc/rayspec/publisher.pub.pem --require-signature
```

A verified signature shows that the bundle is the file the key's holder signed. It does not show
that its code is safe; the checks above and your own review of what it declares do that part.

## Bind

A binding is a value the application reads from its environment: a provider key the bundle declares
(`OPENAI_API_KEY` for an agent on the `openai` backend, for example), or a name of the application's
own. The plan lists the names the bundle declares and whether each has a value; it never shows a
value.

Values come from exactly two places:

- a **bindings file** named with `--bindings-file`, and
- the **explicit process environment** of the deploy.

The bindings file is JSON:

```json
{
  "bindingsFormatVersion": 1,
  "bindings": [
    { "name": "OPENAI_API_KEY", "value": "sk-…" },
    { "name": "INVOICE_WEBHOOK_TOKEN", "value": "…" }
  ]
}
```

It must be a regular file (not a link), owned by the user who runs the deploy, and closed to group
and others (`chmod 600`); otherwise it is refused with `RAY_BINDINGS_FILE_INSECURE` before it is
read. A name is capital letters, digits and underscores, and appears once. Names the operator
controls are **reserved** and are refused in a bindings file with `RAY_BINDING_RESERVED`: the
database and platform settings (`DATABASE_URL`, every `RAYSPEC_…`, `DBOS_…`, `PG…`, `NODE_…`
name), the process environment (`PATH`, `HOME`, the proxy variables) and the `_FILE` variants of the
provider keys, which name host paths. Set those in the process environment. The contents of the
bindings file never appear in any output, log, plan or receipt.

The file may supply only the names the bundle declares, plus the speech provider key of the
provider the operator selected (`DEEPGRAM_API_KEY` with `STT_PROVIDER=deepgram`, `OPENAI_API_KEY`
with `TTS_PROVIDER=openai`); any other name is refused with `RAY_USAGE`, naming it. A provider key
may also come from `<NAME>_FILE` in the process environment (a private file of the deploying user),
but not from both places at once. None of these values is put into the process environment: a
provider key goes to the adapter that uses it, and the application's own bindings reach its
handlers as `init.bindings` ([Spec reference](./spec-reference.md#initbindings--application-bindings)).

## Review

A dry-run reads the bundle, checks the bindings, and plans the deploy against the live database —
without changing it:

```bash
rayspec deploy app.ray --dry-run --bindings-file /etc/rayspec/app-bindings.json
```

It prints one result envelope (`operation: deploy.dry-run`) on stdout and a short summary on
stderr. The plan says:

| Member | What it tells you |
| --- | --- |
| `requiredBindings` | each binding the bundle declares, whether it is required, and whether a value is set |
| `schemaImpact` | the schema head before and after — `from` is `null` for an empty database — whether the product schema changes (`productDeltaSha256`), whether that change is destructive and whether the bundle's reviewed allowlist covers it |
| `permissionChanges` | the execution level, egress hosts and capabilities before and after |
| `storageRequirements` | the bundle's size and its extracted size |
| `blockers` | everything that stops this plan: a missing binding, drift, a schema change the bundle does not carry or does not have reviewed, a stale head |
| `warnings` | for example `RAY_W_UNSIGNED` |
| `planDigest`, `preparedAt`, `expiresAt` | the plan's identity and its 30-minute lifetime |

Nothing is written except the plan record, `<state-dir>/plans/<planDigest>.json` — the inputs the
digest covers, with binding **revision ids** (HMACs under a key only the environment holds), never
values. No SQL changes anything and nothing from the bundle runs. A plan whose schema changes needs
`SHADOW_DATABASE_URL`: the head after the change is computed on a throwaway database there, never
on the live one.

## Apply

Deploy the plan you reviewed, by its digest:

```bash
rayspec deploy app.ray --bindings-file /etc/rayspec/app-bindings.json \
  --plan-digest 57e8f2d0cceeaefb893ff2064923a867c4448679094bca443fd05348d09f258a \
  --host 0.0.0.0 --port 8080
```

A deploy that changes the schema or the grants (a first deploy always does) must name the reviewed
plan with `--plan-digest`; without it the deploy is refused with `RAY_PLAN_STALE`. A deploy of a new
version with the same schema and grants needs no digest. The deploy then:

1. checks everything the dry-run checked, recomputes the plan at the time the dry-run prepared it
   and refuses it if anything it covers changed since (`RAY_PLAN_STALE`: the bundle, a binding value,
   the schema, the environment revision) or if it has blockers;
2. extracts the bundle into its **version directory**, `<state-dir>/versions/<bundleSha256>/`,
   with the one bundle reader, checks every file against the manifest's inventory and makes the
   files read-only;
3. boots the runtime from that directory, which validates the signing key, the spec and everything
   the boot checks before it changes anything;
4. applies the plan as one operation with receipts: the platform migration chain when the database
   is behind this runtime, the product schema change (the DDL and its ledger row in one transaction),
   the application and its grants in the environment's state, and last the switch of the
   **active version** (`<state-dir>/active.json`, replaced in one rename);
5. serves the application from the active version directory until `SIGINT` or `SIGTERM`, then prints
   one envelope (`operation: deploy`, `status: stopped`).

The application runs from the version directory only: its handlers and extensions import
`@rayspec/*` from the installed runtime and every other package from the bundle, whether they use
`import` or CommonJS `require()`. A copy of a `@rayspec/*` package inside the bundle is never loaded.
A package the bundle does not carry is not found, even if a `node_modules` above the state directory
has it.

### The state directory

`--state-dir` (default `.rayspec-state` in the working directory) holds one deployment:

| Path | Content |
| --- | --- |
| `deployment.json` | the deployment id (16 hex characters), when it was created, the application id |
| `active.json` | the bundle SHA-256 the deployment serves, when it was activated, the environment revision |
| `versions/<bundleSha256>/` | one read-only directory per staged bundle |
| `plans/<planDigest>.json` | the plan records of your dry-runs |

It is created with mode 0700 and must stay owned by you and closed to others, or it is refused
(`RAY_BINDINGS_FILE_INSECURE`). It never holds a secret, a connection string or a key. The same
deployment id is recorded in the database by the first deploy; a state directory of another
deployment is refused (`RAY_USAGE`). Plan records past their `expiresAt` and version directories no
longer active may be removed; a version directory is read-only, so remove it with
`chmod -R u+w <dir> && rm -rf <dir>`.

## Readiness

The served application answers:

- `GET /livez` — 200 while the process is alive;
- `GET /health` — 200 when it is ready: the database answers, the schema is the one this runtime
  expects, the required bindings are present and, when the deployment runs one, the durable worker
  is up.

Wait for `/health` before you route traffic to a new deployment. A failing `/health` is not a reason
to recreate the database; read the failing check's name in the response.

## Update

A new version of the application arrives as a new bundle. When it changes the product stores, it
must carry the change: the author packs it against the spec the environment runs,

```bash
rayspec pack --spec new/rayspec.yaml --against running/rayspec.yaml --output app-1.1.0.ray \
  [--allowlist reviewed-allowlist.json]
```

and you review and apply it like the first one:

```bash
rayspec deploy app-1.1.0.ray --dry-run --bindings-file …
rayspec deploy app-1.1.0.ray --bindings-file … --plan-digest <planDigest>
```

The runtime regenerates the product change from its own ledger and the new spec and refuses a
bundle whose change differs from it; an additive change (a new store, a nullable column) applies in
place and keeps every row. A **destructive** change (a dropped column, a type change) is refused
(`RAY_MIGRATION_REQUIRED`, naming each store and column) unless the bundle carries a reviewed
allowlist entry for each destructive statement — the review happens when the bundle is packed, with
`rayspec plan <new-spec> --against <running-spec>`. A change made by hand to the live schema is
**drift** and blocks every plan (`RAY_SCHEMA_DRIFT`, naming what differs) until the schema is back
to what the ledger records.

Restarting the same version — after a host reboot, for example — is the same command without a
digest: nothing changes, so nothing needs review.

### Upgrading the runtime

A new RaySpec release runs its platform migration chain on the existing database the first time it
deploys; rows, users, password hashes and API keys are kept (the repository's upgrade-with-data
check deploys an example with the previous release, writes data, upgrades and compares every row;
with `--roles` it turns role separation on with the upgrade, as [database isolation](database-isolation.md)
describes, and checks that the new release serves under its supervisor with only the runtime role
connected).
A bundle pins its runtime, so after upgrading the CLI, repack the application for the new release
(the same source, the new `rayspec pack`) and deploy that bundle. An older runtime refuses a
database a newer one has migrated. [Upgrading to 1.9](./upgrading-to-1.9.md) lists what changes from 1.8.x.

## Recovery

A deploy that refuses changes nothing: the previous version stays active, and the envelope names
the cause.

| Refusal | Exit | What to do |
| --- | --- | --- |
| `RAY_PLAN_STALE` | 3 | Something the plan covers changed, or it expired, or the state directory has no record for the digest. Run the dry-run again and deploy the new digest. |
| `RAY_BINDING_MISSING` | 2 | Supply the named binding in the bindings file or the process environment. |
| `RAY_BINDING_RESERVED`, `RAY_BINDINGS_FILE_INSECURE` | 4 | Move the name to the process environment; fix the file's owner or mode. |
| `RAY_MIGRATION_REQUIRED`, `RAY_MIGRATION_MISMATCH` | 3 | Have the bundle packed `--against` the spec the environment runs, with a reviewed allowlist for a destructive change. |
| `RAY_SCHEMA_DRIFT` | 6 | Undo the hand-made change the message names, then deploy again. |
| `RAY_LOCK_TIMEOUT` | 5 | Another deploy or operation holds the environment; retry when it has finished. |
| `RAY_RECONCILIATION_REQUIRED` | 6 | An earlier operation left a step whose outcome is unknown; see [Runtime operations → Recovering from an interrupted operation](./runtime-operations.md#recovering-from-an-interrupted-operation). |

**A deploy that stopped part way** — killed, out of memory, the host lost — is continued by running
the same command again while its plan is valid (30 minutes from the dry-run, its `expiresAt`): its
idempotency key is the plan digest, so the second run continues the interrupted operation instead of
starting another. Its finished steps are not repeated, and a product schema change that had not
committed was rolled back with its transaction and runs again. While the dead process's operation
lease lives (up to a minute) the retry is refused with `RAY_LOCK_TIMEOUT`; retry after it. Once the
plan has expired the same command is refused with `RAY_PLAN_STALE`: run the dry-run again and
deploy the new digest. The interrupted operation is settled first, as every apply settles an
interrupted one before it starts.

**A deploy that stopped after its schema change committed** is never reversed: the runtime does not
drop what it added or restore what it changed. The previous version stays active and nothing
serves — the environment is in maintenance — until you finish the deploy forward: run the dry-run of
the same bundle again (it plans no further schema change, because the change is already there) and
deploy the new digest. The refusal says so in its message. If the new version cannot run at all,
the way back to the previous one is a new, reviewed forward change, or a restore of the database
backup you took before the deploy, with the data loss that implies stated and accepted.
