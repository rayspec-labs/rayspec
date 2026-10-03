#!/usr/bin/env node
/**
 * The `rayspec` CLI — a READ-ONLY diagnostic floor PLUS a clearly-separated, LOCAL-DEV mutating `dev`
 * group. Each subcommand emits machine-parseable JSON to stdout:
 *
 * READ-ONLY DIAGNOSTIC FLOOR (never mutates a real/target DB; never prints secrets):
 *   rayspec doctor <spec.yaml>   STATIC validity (parseSpec; no Postgres).      exit 0 ok / 1 not.
 *   rayspec plan   <spec.yaml>   the deploy() FRONT-HALF, READ-ONLY dry-run.    exit 0 ok / 1 not.
 *      [--against <old-spec>]     Handles both profiles (backend + product). With --against,
 *      [--allowlist <file.json>]  diffs prior->new into a DELTA (destructive delta BLOCKED unless the
 *                                 --allowlist covers it). With SHADOW_DATABASE_URL set, shadow-applies
 *                                 to a THROWAWAY DB (never the real target). Mutates NOTHING on it.
 *   rayspec gen-handler …        Render ONE bounded-template handler (.ts or .js) from a holes contract.
 *
 * BUNDLE COMMANDS (the `bundle` group — read a `.ray` archive; never run it):
 *   rayspec bundle inspect <file.ray>   The structural checks and what the bundle declares.
 *   rayspec bundle verify <file.ray>    The same, then runtime, target, capability, spec, secret
 *                                        and signature checks against the running CLI.
 *   rayspec bundle sign <file.ray> --key-file <pem>
 *                                        The structural checks, then write and verify the detached
 *                                        Ed25519 signature file (see bundle-sign.ts). The one bundle
 *                                        command that writes: the signature file, nothing else.
 *   Each always writes ONE result envelope to stdout (see envelope.ts) and exits with the class of
 *   its first error (0 ok, 1 negative verdict, 2 invalid input, 3 incompatible, 4 policy refusal,
 *   6 interrupted, 7 internal).
 *
 * PACKAGING (writes one file; never builds, imports or runs application code):
 *   rayspec pack --spec <path> --output <file.ray>   Write an application bundle from an application
 *                                                    that is already built. One result envelope on
 *                                                    stdout, like the bundle commands (see pack.ts).
 *
 * MIGRATION (fences a self-hosted deployment and writes its encrypted snapshot; releases the fence):
 *   rayspec export --deployment <id> --recipient <age1…> --output <migration.ray>
 *                  --run-history <included|excluded>     Preflight, fence under the operator's
 *                                                        confirmation, capture both databases and the
 *                                                        blobs, encrypt with age, write a migration
 *                                                        .ray. The source stays fenced (see export.ts).
 *   rayspec resume --deployment <id> --fence-epoch <n>   Release that fence, at its epoch only.
 *   rayspec import <migration.ray> --target <state-dir> --identity-file <file>
 *                  (--dry-run | --secrets-out <new-dir>)
 *                                                        Decrypt and check a migration bundle, then
 *                                                        restore it into a new, empty target as its
 *                                                        migration role, verify it, mint the target's
 *                                                        own boot secrets and leave it fenced until
 *                                                        the cutover (see import.ts);
 *                                                        `--cutover-token` releases it, once;
 *                                                        `--discard-failed` removes a failed import.
 *   rayspec tenant recover-owner --email <address>       Issue a one-time owner-recovery token for an
 *                                                        owner who holds no password; printed once.
 *   Each writes ONE result envelope to stdout, like the bundle commands.
 *
 * PRODUCTION-MUTATING (`tenant` group — writes to the database DATABASE_URL names):
 *   rayspec tenant ensure …      Idempotently create OR resolve one organization under a chosen id,
 *                                 speaking to the database directly (no running server, no HTTP
 *                                 route). Applies the committed migration chain. Emits ONE JSON
 *                                 object carrying no secret material; an owner-invite token, when one
 *                                 is minted, is written to a mode-600 file and printed nowhere.
 *
 * LOCAL-DEV, MUTATING (`dev` group — deliberately creates a dev DB / writes secret files; distinct
 * from the diagnostic floor above):
 *   rayspec dev gen-secrets …    Mint the 3 platform boot secrets into a `.env` (idempotent; never
 *                                 overwrites an existing key; NEVER echoes a value). chmod 600.
 *   rayspec dev db …             Create the dev database if absent (idempotent; never destructive);
 *                                 --reset --yes DROPs + re-creates a clean one.
 *   rayspec dev bootstrap-tenant Create the first tenant+owner via the shipped auth API; emit the
 *                                 org id + the org-scoped token (a deliberate operator credential).
 *
 * TOP-LEVEL FLAGS:
 *   rayspec --version | -v       Print the CLI's own version (read from its package manifest at
 *                                 runtime) as a single JSON object on stdout. Exit 0.
 *   rayspec --help | -h          Print the usage text on stdout as PLAIN TEXT — the one exception to
 *                                 the JSON-only rule below. Exit 0. Named after a command
 *                                 (`rayspec deploy --help`) it prints THAT command's help alone.
 *
 * The diagnostic-floor commands wrap already-shipped functions — NO new platform mechanism. Output is
 * JSON only (stdout); a usage/CLI error prints a short JSON error to stderr + exit 2. The read-only
 * floor never echoes env vars / DB URLs / credentials; `dev gen-secrets`/`dev db` never echo a secret
 * VALUE (only a written/present summary), while `dev bootstrap-tenant` emits a freshly-minted org token
 * as its deliberate, documented output. `tenant ensure` is the one mutating command that emits NO
 * credential at all: a minted invite token reaches a mode-600 file and nothing else. The ONE exception
 * to "JSON only" is `--help`, which prints plain help text on stdout and exits 0.
 *
 * `--json` is accepted on every command. On an existing command it wraps that command's own result
 * object, unchanged, in the result envelope (warning `RAY_W_LEGACY_OUTPUT`) and keeps its exit code;
 * without it the output is what it has always been. An unexpected internal failure exits 7.
 *
 * Every command module is imported on its own path only, so a command loads nothing another command
 * needs: `bundle inspect`/`verify`/`sign` and `pack` in particular never load the server, the database
 * layer or a handler loader (`pack --against` alone loads the product schema planner).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ResultOperation } from '@rayspec/bundle-contract';
import {
  envelopeExitCode,
  internalEnvelope,
  interruptedEnvelope,
  interruptible,
  legacyEnvelope,
  newOperationId,
  reserveStdout,
  usageEnvelope,
  workAbandoned,
  writeEnvelope,
} from './envelope.js';
import { loadLocalDotenvIfPresent } from './read-env.js';

/**
 * The usage text, split ONE BLOCK PER COMMAND under the section headings the general usage prints.
 *
 * A block is both the unit of EDIT and the unit of OUTPUT: a command's flags are described in exactly
 * ONE place, which `rayspec <command> --help` prints on its own and the general usage below composes
 * back into the full manual in declaration order. A block's lines start at column 0 in this file
 * because a template literal keeps its own whitespace — the leading two spaces are the printed layout,
 * not source indentation.
 */
interface HelpSection {
  readonly heading: string;
  /** The commands under that heading, in the order the general usage lists them. A `dev`/`tenant`
   *  group member is named by its FULL path (`dev db`), which is also how a scoped help asks for it. */
  readonly commands: readonly { readonly name: string; readonly block: string }[];
}

const HELP_SECTIONS: readonly HelpSection[] = [
  {
    heading: 'GET STARTED:',
    commands: [
      {
        name: 'init',
        block: `  rayspec init [dir] [--force]  Scaffold a new project: write a minimal, valid starter rayspec.yaml
                                (one store + its CRUD routes) into [dir] (default: the current
                                directory). Product-neutral, no custom code. Refuses to overwrite an
                                existing rayspec.yaml unless --force. Then validate it with
                                \`rayspec doctor ./rayspec.yaml\` and preview a deploy with
                                \`rayspec plan ./rayspec.yaml\`.`,
      },
    ],
  },
  {
    heading: 'READ-ONLY diagnostic floor (never mutates a real/target DB; never prints secrets):',
    commands: [
      {
        name: 'doctor',
        block: `  rayspec doctor <spec.yaml>   Static spec validation (parseSpec). Exit 0 if valid, 1 otherwise.`,
      },
      {
        name: 'plan',
        block: `  rayspec plan   <spec.yaml> [--against <old-spec>] [--allowlist <file.json>]
                             [--reconcile-injected-columns]
                                Read-only deploy front-half (validate -> diff -> gate [-> shadow]).
                                Handles both spec profiles (backend + product). With --against, diffs
                                the prior spec FILE -> new spec into a DELTA migration (a destructive
                                delta is BLOCKED unless covered by the reviewed --allowlist JSON). Set
                                SHADOW_DATABASE_URL to also apply the SQL to a throwaway DB (in update
                                mode: baseline -> delta -> assert drift-clean). Add
                                --reconcile-injected-columns (update mode only) when the target DB
                                predates the platform tenancy columns and genuinely lacks
                                created_by / idempotency_key: the delta then also carries their
                                idempotent ADD COLUMN IF NOT EXISTS + idempotency index. Never mutates
                                the real/target DB. Exit 0/1.`,
      },
      {
        name: 'gen-handler',
        block: `  rayspec gen-handler --holes <holes.json> --out <dir> [--emit <ts|js>] [--file <name>]
                                Render ONE bounded-template handler from a holes contract.
                                Deterministic; type-only SDK import; zero npm deps. --emit ts (the
                                default) writes TypeScript source, which needs a build step before
                                deploy; --emit js writes the same program as plain ESM JavaScript,
                                deployable as it stands. The JSON envelope carries the next steps.`,
      },
      {
        name: 'openapi',
        block: `  rayspec openapi <spec.yaml>  Emit the OpenAPI 3.1 document for a product-profile doc's declared
                                VIEW surface (read routes → paths/params/response schemas). Product profile only.`,
      },
    ],
  },
  {
    heading:
      'BUNDLE commands (the `bundle` group — read a .ray archive; never run it; only sign writes, and only the signature file):',
    commands: [
      {
        name: 'bundle inspect',
        block: `  rayspec bundle inspect <file.ray> [--json]
                                Check the archive, its manifest and every entry against the
                                inventory, and report what the bundle is: application id and version,
                                runtime and target it pins, required capabilities, binding names,
                                execution level, egress hosts, size, SHA-256, entry count, and whether
                                a <file.ray>.sig lies next to it. Runtime, target, capability, spec and
                                signature checks are NOT run. Nothing in the archive is extracted,
                                imported or run. Writes ONE result envelope to stdout (verdict
                                structurally-valid, or ok:false with the first failing check); the
                                operation id and, without --json, a short description go to stderr.
                                Exit 0 structurally valid / 2 invalid archive, manifest or inventory /
                                7 internal error.`,
      },
      {
        name: 'bundle verify',
        block: `  rayspec bundle verify <file.ray> [--runtime <exact-version>] [--signature <file.ray.sig>]
                        [--trusted-key <ed25519-public-key.pem>]... [--require-signature] [--json]
                                Everything inspect checks, then against the runtime (default: this
                                CLI's version; --runtime names another exact version): the pinned
                                runtime version, the target, each required capability (an id the
                                vocabulary does not know is refused), reserved binding names, the spec
                                parsed from the payload, the requires / execution / egress fields the
                                spec derives, the secret scan, and the detached signature — the file
                                --signature names, else <file.ray>.sig when present — against the
                                --trusted-key public keys. --require-signature refuses an unsigned
                                bundle; an unsigned bundle otherwise passes with warning
                                RAY_W_UNSIGNED. Nothing is run or written. Writes ONE result envelope
                                (verdict deployable / not-deployable). Exit 0 deployable / 1 spec
                                invalid / 2 invalid input / 3 incompatible runtime, target or
                                capability / 4 reserved binding, secret or signature refusal /
                                7 internal error.`,
      },
      {
        name: 'bundle sign',
        block: `  rayspec bundle sign <file.ray> --key-file <ed25519-private-key.pem> [--output <file.ray.sig>]
                      [--force] [--json]
                                Sign the bundle with an Ed25519 private key: run the structural checks
                                inspect runs, then write the detached signature file over the
                                archive's SHA-256 to <file.ray>.sig (the file verify and deploy read)
                                or to --output, and verify it against the key's public half before
                                reporting success. The key file must be a regular file, not a link,
                                owned by you and unreadable by group and others (chmod 600), holding
                                one unencrypted Ed25519 private key in PEM form (openssl genpkey
                                -algorithm ed25519); a public key or another algorithm is refused.
                                The file is written beside its destination and moved into place in
                                one step; an existing file is refused unless --force. Nothing in the
                                archive is extracted or run. Writes ONE result envelope (the archive
                                SHA-256, the signature path and the public key's SHA-256, never key
                                material). A signature says who signed the archive; it does not vouch
                                for the code inside. Exit 0 signed / 2 usage, refused archive or an
                                existing signature file / 4 an unprotected key file / 6 interrupted /
                                7 internal error.`,
      },
    ],
  },
  {
    heading:
      'PACKAGING (the `pack` command — writes one .ray application bundle from files already built; runs none of them):',
    commands: [
      {
        name: 'pack',
        block: `  rayspec pack --spec <path> --output <file.ray> [--id <application-id>] [--version <semver>]
               [--runtime <exact-version>] [--include <path>]... [--against <old-spec>
               [--allowlist <file.json>]] [--source-maps] [--preview] [--force] [--json]
                                Write an application bundle from an application that is ALREADY
                                BUILT: the spec, the compiled handler and extension modules and what
                                they import, the built frontend, the third-party packages they need
                                (never @rayspec/*, which the runtime provides), the dependency lock,
                                an SBOM and the license notices. Nothing is built, imported or run.
                                The id and version come from the spec's metadata.id / metadata.version
                                (product: product.metadata); --id / --version override them, and pack
                                refuses when neither gives one. The bundle pins this CLI's version
                                unless --runtime names another exact version. --include adds a file or
                                directory relative to the spec; --source-maps carries source maps
                                (*.map files, and scripts that inline theirs).
                                --against <old-spec> carries the product delta from the stores of the
                                spec the environment runs to this spec's, the product schema digests
                                it migrates between (computed on a throwaway database on the server
                                SHADOW_DATABASE_URL names, read from the environment, never a .env
                                file) and, with --allowlist, the reviewed allowlist; a destructive
                                delta the allowlist does not clear is refused. The target regenerates
                                the delta from its own product migration ledger and refuses any
                                difference. Review a destructive delta with \`rayspec plan <spec>
                                --against <old-spec>\` first.
                                --preview prints the inclusion list and writes nothing. The archive is
                                written to a temporary file beside the output, read back, and moved
                                into place; an existing output is refused unless --force. Writes ONE
                                result envelope to stdout; the operation id and, without --json, the
                                inclusion summary and the output SHA-256 go to stderr. Packing is not
                                deploying: check the result with \`rayspec bundle verify\`. Exit 0
                                written / 1 spec invalid / 2 usage, identity, closure, limit or an
                                existing output / 3 a @rayspec/* range that excludes the runtime /
                                4 a secret or reserved binding / 6 interrupted / 7 internal error.`,
      },
    ],
  },
  {
    heading: 'PRODUCTION-MUTATING (boots + serves a real deployment; mutates the target DB):',
    commands: [
      {
        name: 'deploy',
        block: `  rayspec deploy <spec.yaml> [--port <n>] [--host <addr>] [--apply-migration <delta.sql> [--allowlist <file.json>]]
                                Assemble the platform from the ambient env, register the product
                                stores through the SANCTIONED validating registrar, apply the committed
                                migration chain + roll out the declared product, and SERVE on PORT
                                (default 8080) until SIGINT/SIGTERM. Binds LOOPBACK (127.0.0.1) by
                                default; --host <addr> (e.g. 0.0.0.0) is an explicit opt-in to another
                                interface — the banner logs the ACTUAL bound address. Reads config from
                                env (see the @rayspec/server package README); fails closed on a missing
                                secret.
                                With --apply-migration, boot in UPDATE mode: apply the reviewed FORWARD
                                delta <delta.sql> to the EXISTING schema in place (existing rows
                                survive). A DESTRUCTIVE statement is BLOCKED unless covered by the
                                reviewed --allowlist JSON. Author the delta with
                                \`rayspec plan <new-spec> --against <old-spec>\`. Drop --apply-migration
                                from the NEXT deploy once the delta has landed (a delta is not
                                idempotent).
  rayspec deploy <file.ray> --dry-run [--bindings-file <file>] [--state-dir <dir>]
                 [--trusted-key <pem>]... [--require-signature]
                                Plan a bundle deploy: read and verify the bundle with the one bundle
                                reader, prepare the plan against the live database (DATABASE_URL,
                                RAYSPEC_API_KEY_PEPPER; SHADOW_DATABASE_URL for a schema change) and
                                print it — binding names, schema impact, permission changes,
                                warnings, blockers and the plan digest, valid 30 minutes. Writes only
                                the plan record to the state directory (default .rayspec-state); no
                                SQL changes anything and nothing from the bundle runs. A file that
                                starts with a ZIP signature or is named .ray takes this path; no
                                .env file is loaded on it.
  rayspec deploy <file.ray> [--bindings-file <file>] [--plan-digest <sha256>] [--state-dir <dir>]
                 [--port <n>] [--host <addr>] [--trusted-key <pem>]... [--require-signature]
                                Deploy the bundle and serve it. A plan that changes the schema or the
                                grants must be the reviewed one: pass the planDigest the dry-run
                                printed. Bindings come only from --bindings-file (JSON, mode 0600,
                                owned by you; never printed; only names the bundle declares) and
                                the process environment, never into it: provider keys go to their
                                adapters, the application's own to init.bindings. The bundle
                                is staged into an immutable version directory, the boot validates
                                everything, then the apply runs the platform chain and the product
                                delta and switches the active version; a failed deploy leaves the
                                previous version active and never reverses a schema change. Writes
                                ONE envelope to stdout when it refuses or stops. Exit 0 stopped /
                                1 the boot refused its configuration (RAY_CHECK_FAILED; nothing
                                applied) / 2 usage, archive, digest or a missing binding /
                                3 runtime, target, capability, a stale plan or a schema change the
                                plan does not approve / 4 policy, signature, reserved binding, an
                                insecure file / 5 lock or database unavailable / 6 drift,
                                interrupted, or reconciliation required / 7 internal error.
  rayspec deploy --dry-run <spec.yaml>
                                One-shot: validate the document with the grammar of the profile it
                                boots — a product doc is also COMPOSED against a stubbed rollout, a
                                backend doc reports its declarations, a frontend-only doc its mounts.
                                NO DB, NO network. Emits a JSON verdict. Does NOT prove: the
                                migration, boot-env sufficiency, any provider credential, live-schema
                                drift, or that the app serves — the verdict's notProven lists what
                                each profile leaves open. Exit 0 ok / 1 not.
  rayspec deploy --check-env <spec.yaml>
                                One-shot: the environment variables THIS document's boot will
                                require, each with its <VAR>_FILE equivalent, why the document (or
                                the environment) demands it, and whether it is currently set — the
                                answer a refused deploy used to be the only way to get. Reads the
                                document AND the environment: a selected STT_PROVIDER/TTS_PROVIDER
                                makes that provider's credential a demand no document could have
                                predicted, while an UNSET selector is never a boot error on a BACKEND
                                document (on a product document STT_PROVIDER IS demanded, but only
                                when the document declares an stt.* step alongside the audio
                                capability whose chunks it transcribes). Opens no socket, no
                                database and no credential, and loads NO extension — so every demand
                                an extension changes is invisible: an extension REMOVES one by
                                supplying a blob backend, and ADDS one by contributing a
                                stream/playback route or an agent. The verdict's notChecked states
                                that, names the extensions the document declares, and carries the
                                rest of the boundary. Prints no
                                value, only set/unset. Exit 0 when every demand is met and no refusal
                                is already visible / 1 otherwise — missing lists the unmet demands,
                                errors names a refusal that is not an unset variable.`,
      },
    ],
  },
  {
    heading:
      'MIGRATION (fences a self-hosted deployment, writes its encrypted snapshot, restores it into a new target, releases a fence):',
    commands: [
      {
        name: 'export',
        block: `  rayspec export --deployment <id> --recipient <age1...> --output <migration.ray>
                 --run-history <included|excluded> [--confirm-quiesce] [--source-stopped]
                 [--quiesce-deadline <seconds>] [--state-dir <dir>] [--json]
                                Write the deployment's complete snapshot as a migration bundle,
                                encrypted with age to the X25519 recipient (only the holder of the
                                matching identity can read it; there is no passphrase mode). In order:
                                a read-only precheck of the source (application, schema head, blob
                                root, budgets, extensions, one organization, a password-holding
                                member, unknown tables); the operator's confirmation of the downtime
                                (--confirm-quiesce, required with --json or without a terminal;
                                otherwise asked on the terminal); the source fence — writes, uploads,
                                triggers and the run queue stopped, runs drained until
                                --quiesce-deadline (default 300) — with a database write barrier: the
                                runtime role's writes revoked (role separation,
                                RAYSPEC_MIGRATION_DATABASE_URL), or every runtime process stopped and
                                attested with --source-stopped (with neither, refused at the precheck,
                                before the fence); then both databases and the blobs captured under
                                that fence epoch, verified, encrypted in a
                                private scratch directory under the state directory, and the bundle
                                written to --output (refused if it exists). Plaintext is never written
                                anywhere else. --run-history has no default: excluded keeps runs, run
                                events, journals and workflow runs at the source. The source STAYS
                                FENCED afterwards; release it with \`rayspec resume\`. Reads DATABASE_URL,
                                RAYSPEC_MIGRATION_DATABASE_URL, RAYSPEC_SNAPSHOT_DATABASE_URL (the
                                read-only snapshot role), DBOS_SYSTEM_DATABASE_URL, RAYSPEC_BLOB_ROOT and
                                RAYSPEC_PG_DUMP (absolute path; default pg_dump on PATH, of the server's
                                major) from the process environment only, never a .env file. Writes ONE
                                result envelope to stdout and a local receipt to
                                <state-dir>/receipts/. Exit 0 exported / 2 usage, an existing output or
                                a size limit / 3 tenants, external state, no database barrier /
                                4 owner recovery, policy / 5 lock, database or quiesce deadline,
                                retryable / 6 schema drift or interrupted (the fence stays) /
                                7 internal error.`,
      },
      {
        name: 'import',
        block: `  rayspec import <migration.ray> --target <state-dir> --identity-file <file> --dry-run [--json]
  rayspec import <migration.ray> --target <state-dir> --identity-file <file>
                 --secrets-out <new-dir> [--bindings-file <file>] [--json]
  rayspec import --target <state-dir> --discard-failed [--json]
  rayspec import --target <state-dir> --cutover-token <token> [--json]
  rayspec import --target <state-dir> --renew-cutover-token [--json]
                                Restore a migration bundle into a NEW, EMPTY target and leave it
                                fenced until the cutover; the source stays authoritative. In order:
                                the bundle through the one reader (the ciphertext's size and SHA-256
                                before decryption); decryption with the age X25519 identity file (a
                                protected file: yours, mode 0600) into a private scratch directory
                                under the target state directory, within the plaintext limit; the
                                inner snapshot through the same reader; every clear hint against the
                                authenticated metadata; the embedded application against this runtime
                                (it must be the exact runtime the source ran); each dump's table of
                                contents against the restore allowlist (no extension but uuid-ossp in
                                the workflow system database, one owner, no grant to an unknown role,
                                no role, event trigger, untrusted language, SECURITY DEFINER function
                                beyond the platform's two, COPY ... PROGRAM, call into the dump or a
                                server function at restore time, entry outside its section); the
                                target: both databases and the blob root empty,
                                the snapshot's server major, roles prepared. --dry-run stops there
                                and restores nothing. Otherwise the runtime role's default write
                                privileges are withheld (it writes nothing restored until the
                                cutover), both databases are restored with pg_restore as the target's
                                migration role, never a superuser, under the shared schema lock,
                                pre-data, data, post-data, each catalog checked to hold exactly what
                                the restore plan creates, the objects written unchanged, and
                                everything verified (row counts, foreign keys, schema head, one
                                organization, empty credential tables, object digests, the runtime
                                role's posture); each account's carried identity is recorded in the
                                target's security audit; the import then holds the target's fence,
                                its own signing key, API-key pepper and media key are minted into
                                the new directory --secrets-out names (mode 0700, files 0600, never
                                printed), and stderr gives the cutover instruction, the cutover
                                token (shown once; works once, for 15 minutes; the receipts keep its
                                SHA-256), who signs in again, which owner needs owner recovery and
                                that every API key is reissued. --cutover-token checks and consumes
                                the token against what it binds (bundle, target, both fence epochs,
                                environment revision, catalogs) and only then releases the fence and
                                grants the runtime role its writes; --renew-cutover-token replaces an
                                expired or spent token. A failure leaves a changed target marked
                                failed; --discard-failed removes what it restored. Reads DATABASE_URL (the
                                runtime role), RAYSPEC_MIGRATION_DATABASE_URL (required),
                                DBOS_SYSTEM_DATABASE_URL, RAYSPEC_BLOB_ROOT and RAYSPEC_PG_RESTORE
                                (absolute path; default pg_restore on PATH, of the server's major) from
                                the process environment only, never a .env file. Writes ONE result
                                envelope to stdout and a local receipt to <state-dir>/receipts/. Exit 0
                                / 2 usage, archive, digest, decryption, limits / 3 runtime, target,
                                tenants / 4 not empty, policy, insecure file / 5 lock or database,
                                retryable / 6 interrupted or a failed restore (the target is marked
                                failed) / 7 internal error.`,
      },
      {
        name: 'resume',
        block: `  rayspec resume --deployment <id> --fence-epoch <n> [--state-dir <dir>] [--json]
                                Release the source fence an export took, only at the epoch it
                                reported, and give the runtime role back the writes the barrier
                                revoked; runtime processes restart their producers within a second.
                                A fence already open at that epoch is left alone (released: false).
                                A fence an import holds is never released here (RAY_USAGE): the
                                import's --cutover-token does. Same configuration as export. Writes ONE result envelope. Exit 0 /
                                2 usage / 4 another epoch (RAY_FENCE_MISMATCH) / 5 database
                                unavailable / 7 internal error.`,
      },
    ],
  },
  {
    heading:
      'PRODUCTION-MUTATING (the `tenant` group — writes to the database DATABASE_URL names):',
    commands: [
      {
        name: 'tenant ensure',
        block: `  rayspec tenant ensure --org-id <uuid> --name <n> [--owner-email <e>] [--owner-invite-out <path>]
                        [--invite-ttl-seconds <n>] [--reissue-owner-invite]
                                Create OR resolve the organization under <uuid>, idempotently — run it
                                twice with the same id and you get the same org and no second row. Use
                                it to settle RAYSPEC_PRODUCT_TENANT_ID before the deployment exists.
                                Talks to DATABASE_URL directly (no running server, no HTTP route), and
                                APPLIES THE COMMITTED MIGRATION CHAIN to that database on the way — so
                                point it only at a database you mean to migrate. Reads DATABASE_URL and
                                RAYSPEC_API_KEY_PEPPER, each also honouring its <VAR>_FILE variant.
                                With --owner-email it mints ONE owner invite and writes the token to
                                --owner-invite-out (required with it) as a mode-600 file it will never
                                overwrite; the token is NEVER printed, returned or logged. A human
                                redeems it at POST /v1/invites/accept, which provisions THEIR account
                                with THEIR password — the command creates no user. Whoever can read
                                that file can take the tenant, so treat it as a credential: it defaults
                                to a 1-hour lifetime (--invite-ttl-seconds overrides, clamped to
                                5min-30d). --reissue-owner-invite revokes the outstanding invite and
                                mints a replacement (for a lost token). With RAYSPEC_SINGLE_TENANT=true
                                it resolves the one organization and refuses to create a second
                                (SINGLE_TENANT_LIMIT). Emits ONE JSON object.`,
      },
      {
        name: 'tenant recover-owner',
        block: `  rayspec tenant recover-owner --email <address> [--org-id <uuid>] [--ttl-seconds <n>]
                                Issue a one-time owner-recovery token for an active OWNER who holds no
                                password (whose only credential was an API key, which a new API-key
                                pepper breaks — after an import, for example). The owner redeems it
                                once at POST /v1/auth/owner-recovery with a new password and is signed
                                in. The token is printed ONCE, in the JSON object on stdout, and is in
                                no log, audit row or receipt; only its HMAC under the pepper is stored.
                                Issuing again replaces a token still outstanding for that owner. It
                                refuses an owner who holds a password, an account that is not an
                                active owner, and a fenced environment (an exported source, or an
                                import target before its cutover). Valid 30 minutes by default
                                (--ttl-seconds, clamped to 5min-24h). Reads DATABASE_URL (or
                                RAYSPEC_MIGRATION_DATABASE_URL) and RAYSPEC_API_KEY_PEPPER — the pepper
                                the deployment runs with — each honouring its <VAR>_FILE variant. Runs
                                no migration. Emits ONE JSON object; --json is not available for it.`,
      },
    ],
  },
  {
    heading: 'LOCAL-DEV, MUTATING (the `dev` group — creates a dev DB / writes secret files):',
    commands: [
      {
        name: 'dev gen-secrets',
        block: `  rayspec dev gen-secrets [--out <path>]
                                Mint the 3 platform boot secrets (RS256 JWT PEM, api-key pepper,
                                media key) into a .env (default ./.env). Idempotent: never overwrites
                                an existing key; NEVER echoes a value (prints a written/present
                                summary only). chmod 600.`,
      },
      {
        name: 'dev db',
        block: `  rayspec dev db [--database-url <url>] [--name <db>] [--reset --yes]
                                Create the dev database if absent (idempotent; never destructive).
                                Base URL from --database-url or DATABASE_URL. With --reset --yes,
                                DROP + re-create a CLEAN database (destroys all data; --reset alone
                                refuses without --yes).`,
      },
      {
        name: 'dev bootstrap-tenant',
        block: `  rayspec dev bootstrap-tenant --base-url <url> [--email <e>] [--password <p>] [--org-name <n>] [--org-id <uuid>]
                                Create the first tenant+owner via the shipped auth API; emit ORG_ID
                                + the org-scoped token (a deliberate operator credential). With
                                --org-id, the org is created under THAT id (for
                                RAYSPEC_PRODUCT_TENANT_ID); the target server must be running with
                                RAYSPEC_TENANT_BOOTSTRAP_ENABLED=true.`,
      },
    ],
  },
];

/** The two flags that stand OUTSIDE the subcommand grammar, listed at the foot of the general usage. */
const TOP_LEVEL_FLAGS = `TOP-LEVEL FLAGS:
  rayspec --version | -v        Print the CLI's own version as a single JSON object. Exit 0.
  rayspec --help | -h           Print this usage text on stdout as plain text. Exit 0. Named after a
                                command (\`rayspec deploy --help\`) it prints THAT command's help.
  --json                        Accepted on every command: wrap its result in the result envelope
                                ({contractVersion, ok, operation, operationId, data, errors,
                                warnings}); an existing command's own result is carried unchanged in
                                data and its exit code is kept.`;

/** The output/exit contract, printed at the foot of every help text. */
const OUTPUT_CONTRACT = `Output: a single JSON object on stdout — \`--help\` is the one exception and prints plain text.
Exit 1 = not-ok; exit 2 = a CLI/usage error.`;

/** Every command block, flattened with its section heading — the lookup a scoped `--help` resolves. */
const HELP_COMMANDS = HELP_SECTIONS.flatMap((section) =>
  section.commands.map((command) => ({ ...command, heading: section.heading })),
);

/** The GENERAL usage — the full manual, re-composed from the per-command blocks above. */
const USAGE = [
  'rayspec — RaySpec CLI',
  ...HELP_SECTIONS.flatMap((section) => [
    '',
    section.heading,
    ...section.commands.map((command) => command.block),
  ]),
  '',
  TOP_LEVEL_FLAGS,
  '',
  OUTPUT_CONTRACT,
].join('\n');

/**
 * A CLI error: a usage/argument problem (exit 2 — distinct from a not-ok spec, which is exit 1).
 * Thrown by `main` and caught at the top level so `main` can RETURN an exit code (testable in-process)
 * rather than calling `process.exit` mid-flight (which truncates a not-yet-drained stdout).
 */
class CliError extends Error {}

/**
 * Write a string to a stream and RESOLVE only once the chunk is flushed (the write callback fired).
 * This is the drain-safe pattern: we must not `process.exit` while a large JSON payload is
 * still buffered in stdout, or it gets truncated. Awaiting the callback lets the chunk drain first.
 */
function writeDrained(stream: NodeJS.WriteStream, s: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(s, (err) => (err ? reject(err) : resolve()));
  });
}

/** Pretty-print a JSON object to stdout (drain-safe), followed by a newline. */
function emit(obj: unknown): Promise<void> {
  return writeDrained(process.stdout, `${JSON.stringify(obj, null, 2)}\n`);
}

/**
 * The CLI's OWN version, read at runtime from the package manifest that ships beside this entrypoint.
 *
 * Resolved against `import.meta.url`, never against the cwd: the manifest sits one directory above
 * both the source entrypoint (`src/index.ts`) and the built one (`dist/index.js`), and npm puts
 * `package.json` at the tarball root next to `dist/`, so the same relative step lands on the right
 * manifest in the workspace and in a published install alike. Nothing here depends on the workspace
 * layout being present.
 */
function readCliVersion(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const version = (manifest as { version?: unknown }).version;
  if (typeof version !== 'string' || version === '') {
    throw new CliError('the CLI package manifest carries no "version"');
  }
  return version;
}

/**
 * The help text for ONE command path — a command (`deploy`), a group member (`dev db`), or a GROUP
 * name (`dev`, `tenant`). `undefined` when nothing by that name exists, so the caller falls through to
 * the normal dispatch and an unknown name keeps the usage error it has always been (exit 2).
 *
 * A group is not a command of its own: it is answered with every member's block under the group's
 * heading, derived from the names, so a new member is carried without a second registration.
 */
function helpForCommand(path: string): string | undefined {
  const exact = HELP_COMMANDS.find((command) => command.name === path);
  const members =
    exact === undefined
      ? HELP_COMMANDS.filter((command) => command.name.startsWith(`${path} `))
      : [exact];
  const first = members[0];
  if (first === undefined) return undefined;
  return [
    `rayspec ${path} — RaySpec CLI`,
    '',
    first.heading,
    ...members.map((command) => command.block),
    '',
    OUTPUT_CONTRACT,
    'Run `rayspec --help` for the full command list.',
  ].join('\n');
}

/** `--help` and its short spelling — a help REQUEST, never a usage error. */
function isHelpFlag(token: string | undefined): boolean {
  return token === '--help' || token === '-h';
}

/**
 * Resolve a `--help`/`-h` request in the full argument vector to the text it asks for; `undefined`
 * when the vector carries no help request and dispatch should proceed normally.
 *
 * The flag is honoured only where a command NAME sits — `rayspec --help`, `rayspec <cmd> --help`,
 * `rayspec <group> <sub> --help`. Everything past the command path is that command's OWN argument
 * grammar, which the top level deliberately hands over unparsed (see `main`); reading a token out of
 * it here would be the top level second-guessing a grammar it does not own.
 */
function resolveHelpRequest(args: readonly string[]): string | undefined {
  const at = args.findIndex((token) => isHelpFlag(token));
  const flag = at === -1 ? undefined : args[at];
  if (flag === undefined || at > 2) return undefined;
  const path = args.slice(0, at).join(' ');
  const text = path === '' ? USAGE : helpForCommand(path);
  if (text === undefined) return undefined;
  // Like `--version`, it answers the flag and nothing else, so a trailing token is REFUSED rather than
  // ignored — otherwise `rayspec doctor --help --nope` would report success.
  if (at < args.length - 1) {
    throw new CliError(`\`${flag}\` takes no arguments, got ${args.slice(at + 1).join(' ')}`);
  }
  return text;
}

/**
 * `--json` is a flag of EVERY command, so it is taken off the vector here, before any subcommand's
 * own strict parser sees it; everything after a `--` terminator is left alone. The rest of the vector
 * reaches the subcommand exactly as it would without the flag.
 */
function takeJsonFlag(args: readonly string[]): { json: boolean; vector: string[] } {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  const tail = end === -1 ? [] : args.slice(end);
  const kept = head.filter((token) => token !== '--json');
  return { json: kept.length !== head.length, vector: [...kept, ...tail] };
}

/** The operation name an existing command reports in its envelope; `help` when there is none. */
function legacyOperation(vector: readonly string[]): ResultOperation {
  const [command, sub] = vector;
  if (resolveHelpRequestQuietly(vector)) return 'help';
  switch (command) {
    case '--version':
    case '-v':
      return 'version';
    case 'init':
    case 'doctor':
    case 'plan':
    case 'openapi':
    case 'gen-handler':
      return command;
    case 'deploy':
      return 'deploy.legacy';
    case 'tenant':
      return sub === 'ensure' ? 'tenant.ensure' : 'help';
    case 'dev':
      return sub === 'gen-secrets' || sub === 'db' || sub === 'bootstrap-tenant'
        ? `dev.${sub}`
        : 'help';
    default:
      return 'help';
  }
}

/** Whether the vector is a help request, without raising the usage error a malformed one is. */
function resolveHelpRequestQuietly(vector: readonly string[]): boolean {
  try {
    return resolveHelpRequest(vector) !== undefined;
  } catch {
    return false;
  }
}

/** What an existing command answered, before it is printed. */
type Answer =
  | { readonly kind: 'result'; readonly result: { readonly ok: boolean } }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'served' };

/** How the invocation reports: plain, as today, or one envelope under this operation id. */
type Reporting = { readonly json: false } | { readonly json: true; readonly operationId: string };

/**
 * The CLI body. RETURNS the numeric exit code instead of calling `process.exit`, so it is testable
 * in-process and the top-level can drain stdout before exiting. Without `--json` an existing command
 * answers as it always has: its JSON result on stdout, exit 0 ok · 1 not-ok · 2 CLI/usage error (a
 * usage/argument problem is raised as a `CliError` and mapped to exit 2 by the top-level handler,
 * which prints it to stderr). With `--json` the same answer is wrapped in the result envelope; the
 * `bundle` verbs always answer with an envelope.
 *
 * `args` is the subcommand+positionals slice (defaults to `process.argv.slice(2)` — the real CLI
 * path). It is a parameter (not parseArgs's auto-stripping default) so a test can drive `main` with an
 * EXPLICIT arg vector and get the same behavior the CLI does, without depending on how `node -e` /
 * vitest shape `process.argv`.
 */
export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const { json, vector } = takeJsonFlag(args);
  // A help request on the group (`rayspec bundle verify --help`) is answered like any other below.
  if (vector[0] === 'bundle' && !vector.slice(0, 3).some((token) => isHelpFlag(token))) {
    return runBundleVerb(vector.slice(1), json);
  }
  if (vector[0] === 'pack' && !isHelpFlag(vector[1])) {
    return runPackVerb(vector.slice(1), json);
  }
  if ((vector[0] === 'export' || vector[0] === 'resume') && !isHelpFlag(vector[1])) {
    return runMigrationVerb(vector[0], vector.slice(1), json);
  }
  if (vector[0] === 'import' && !vector.slice(1).some((token) => isHelpFlag(token))) {
    return runImportVerb(vector.slice(1), json);
  }
  // `deploy <file.ray>`: a file that starts with a ZIP signature or is named `.ray` takes the bundle
  // path, decided on at most four bytes and before any configuration or `.env` file is read.
  if (vector[0] === 'deploy' && !vector.slice(1).some((token) => isHelpFlag(token))) {
    const { isBundleDeploy } = await import('./deploy-bundle.js');
    if (await isBundleDeploy(vector.slice(1))) return runDeployBundleVerb(vector.slice(1), json);
  }
  // The one command whose answer carries a secret, printed once in its own JSON object; the result
  // envelope has no operation for it, so it is not wrapped.
  if (json && vector[0] === 'tenant' && vector[1] === 'recover-owner') {
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: '--json is not available for tenant recover-owner: it writes its own JSON object, once' })}\n`,
    );
    return 2;
  }
  if (!json) return printAnswer(await answer(vector, { json: false }));

  const operation = legacyOperation(vector);
  const operationId = newOperationId();
  await writeDrained(process.stderr, `operationId: ${operationId}\n`);
  try {
    const answered = await answer(vector, { json: true, operationId });
    if (answered.kind === 'served') return 0; // deploy writes its own envelope when it stops
    const result =
      answered.kind === 'text'
        ? legacyEnvelope(operation, operationId, { text: answered.text }, true)
        : legacyEnvelope(operation, operationId, answered.result, answered.result.ok);
    await writeEnvelope(process.stdout, result);
    return answered.kind === 'result' && !answered.result.ok ? 1 : 0;
  } catch (err) {
    if (err instanceof CliError) {
      await writeEnvelope(process.stdout, usageEnvelope(operation, operationId, err.message));
      return 2;
    }
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: errMessage(err) })}\n`,
    );
    await writeEnvelope(process.stdout, internalEnvelope(operation, operationId));
    return 7;
  }
}

/** Print an existing command's answer the way it has always been printed, and map its exit code. */
async function printAnswer(answered: Answer): Promise<number> {
  if (answered.kind === 'text') {
    await writeDrained(process.stdout, `${answered.text}\n`);
    return 0;
  }
  if (answered.kind === 'served') return 0;
  await emit(answered.result);
  return answered.result.ok ? 0 : 1;
}

/**
 * `rayspec bundle inspect|verify|sign`. The verbs are new, so they write one envelope on stdout
 * whether or not `--json` was given, and the operation id on stderr; without `--json` a short
 * description of the result follows it there. They read no environment, so the `.env` auto-load
 * below is skipped.
 */
async function runBundleVerb(rest: readonly string[], json: boolean): Promise<number> {
  if (rest[0] === 'sign') return runBundleSignVerb(rest.slice(1), json);
  const operation: ResultOperation = rest[0] === 'verify' ? 'bundle.verify' : 'bundle.inspect';
  const operationId = newOperationId();
  await writeDrained(process.stderr, `operationId: ${operationId}\n`);
  const { BundleCliError, runBundle } = await import('./bundle.js');
  try {
    const run = await interruptible(
      runBundle(rest, { operationId, cliVersion: readCliVersion(), json }),
    );
    if (run.interrupted) {
      const stopped = interruptedEnvelope(
        operation,
        operationId,
        'nothing was written or changed, so run the command again',
      );
      await writeEnvelope(process.stdout, stopped);
      return envelopeExitCode(stopped);
    }
    const outcome = run.value;
    if (!outcome.json && outcome.summary.length > 0) {
      await writeDrained(process.stderr, `${outcome.summary.join('\n')}\n`);
    }
    await writeEnvelope(process.stdout, outcome.envelope);
    return envelopeExitCode(outcome.envelope);
  } catch (err) {
    if (err instanceof BundleCliError) {
      // No verb was named, so there is no verb envelope: the group's usage error, as for any other
      // command, or its envelope under `help` with --json.
      if (!json) throw new CliError(err.message);
      await writeEnvelope(process.stdout, usageEnvelope('help', operationId, err.message));
      return 2;
    }
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: errMessage(err) })}\n`,
    );
    const failed = internalEnvelope(operation, operationId);
    await writeEnvelope(process.stdout, failed);
    return envelopeExitCode(failed);
  }
}

/**
 * `rayspec bundle sign`. It writes a file, so it is not abandoned on a signal like the passive
 * verbs: SIGINT and SIGTERM are answered before the signature file is placed, where the verb removes
 * its temporary file and reports `RAY_INTERRUPTED`.
 */
async function runBundleSignVerb(rest: readonly string[], json: boolean): Promise<number> {
  const operationId = newOperationId();
  await writeDrained(process.stderr, `operationId: ${operationId}\n`);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const { runSign } = await import('./bundle-sign.js');
    const outcome = await runSign(rest, { operationId, json, signal: controller.signal });
    if (!outcome.json && outcome.summary.length > 0) {
      await writeDrained(process.stderr, `${outcome.summary.join('\n')}\n`);
    }
    await writeEnvelope(process.stdout, outcome.envelope);
    return envelopeExitCode(outcome.envelope);
  } catch (err) {
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: errMessage(err) })}\n`,
    );
    const failed = internalEnvelope('bundle.sign', operationId);
    await writeEnvelope(process.stdout, failed);
    return envelopeExitCode(failed);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/**
 * `rayspec pack`. A new verb, so it writes one envelope on stdout whether or not `--json` was given,
 * and the operation id on stderr; without `--json` the inclusion summary follows it there. The
 * `.env` auto-load is skipped: the one value pack reads, `SHADOW_DATABASE_URL` for `--against`,
 * comes from the process environment. SIGINT and SIGTERM are answered at pack's
 * next safe point, where it removes what it wrote and reports `RAY_INTERRUPTED`.
 */
async function runPackVerb(rest: readonly string[], json: boolean): Promise<number> {
  const operationId = newOperationId();
  await writeDrained(process.stderr, `operationId: ${operationId}\n`);
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const { runPack } = await import('./pack.js');
    const outcome = await runPack(rest, {
      operationId,
      cliVersion: readCliVersion(),
      json,
      signal: controller.signal,
    });
    if (!outcome.json && outcome.summary.length > 0) {
      await writeDrained(process.stderr, `${outcome.summary.join('\n')}\n`);
    }
    await writeEnvelope(process.stdout, outcome.envelope);
    return envelopeExitCode(outcome.envelope);
  } catch (err) {
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: errMessage(err) })}\n`,
    );
    const failed = internalEnvelope('pack', operationId);
    await writeEnvelope(process.stdout, failed);
    return envelopeExitCode(failed);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/**
 * `rayspec export` and `rayspec resume`. New verbs: one envelope on stdout with or without `--json`,
 * the operation id on stderr and, without `--json`, a short description of the result there. No
 * `.env` file is loaded: the configuration comes from the process environment. SIGINT and SIGTERM
 * stop an export at its next safe point; any fence it took stays, and the envelope says how to
 * release it.
 */
async function runMigrationVerb(
  verb: 'export' | 'resume',
  rest: readonly string[],
  json: boolean,
): Promise<number> {
  const operationId = newOperationId();
  await writeDrained(process.stderr, `operationId: ${operationId}\n`);
  // Library output while the verb runs goes to stderr; stdout carries the one envelope.
  const stdout = reserveStdout();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const outcome =
      verb === 'export'
        ? await (await import('./export.js')).runExport(rest, {
            operationId,
            json,
            signal: controller.signal,
            terminal:
              process.stdin.isTTY === true && process.stderr.isTTY === true
                ? { input: process.stdin, output: process.stderr }
                : null,
          })
        : await (await import('./resume.js')).runResume(rest, { operationId, json });
    if (!json && outcome.summary.length > 0) {
      await writeDrained(process.stderr, `${outcome.summary.join('\n')}\n`);
    }
    await writeEnvelope(stdout.sink, outcome.envelope);
    return envelopeExitCode(outcome.envelope);
  } catch (err) {
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: errMessage(err) })}\n`,
    );
    const failed = internalEnvelope(verb, operationId);
    await writeEnvelope(stdout.sink, failed);
    return envelopeExitCode(failed);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    stdout.release();
  }
}

/**
 * `rayspec import`. A new verb: one `import` or `import.dry-run` envelope on stdout, with or without
 * `--json`, the operation id on stderr and, without `--json`, a short description of the result
 * there. No `.env` file is loaded. SIGINT and SIGTERM stop it at its next safe point.
 */
async function runImportVerb(rest: readonly string[], json: boolean): Promise<number> {
  const operationId = newOperationId();
  const operation: ResultOperation = rest.includes('--dry-run') ? 'import.dry-run' : 'import';
  await writeDrained(process.stderr, `operationId: ${operationId}\n`);
  const stdout = reserveStdout();
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const { runImport } = await import('./import.js');
    const outcome = await runImport(rest, { operationId, json, signal: controller.signal });
    if (!json && outcome.summary.length > 0) {
      await writeDrained(process.stderr, `${outcome.summary.join('\n')}\n`);
    }
    await writeEnvelope(stdout.sink, outcome.envelope);
    return envelopeExitCode(outcome.envelope);
  } catch (err) {
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: errMessage(err) })}\n`,
    );
    const failed = internalEnvelope(operation, operationId);
    await writeEnvelope(stdout.sink, failed);
    return envelopeExitCode(failed);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    stdout.release();
  }
}

/**
 * `rayspec deploy <file.ray>`. A new verb: one `deploy` or `deploy.dry-run` envelope on stdout,
 * with or without `--json`, and the operation id on stderr; without `--json` a short description of
 * the plan or the refusal follows it there. A deploy that serves writes its envelope when it stops.
 * No `.env` file is loaded: the bindings come from `--bindings-file` and the process environment.
 */
async function runDeployBundleVerb(rest: readonly string[], json: boolean): Promise<number> {
  const operationId = newOperationId();
  const operation: ResultOperation = rest.includes('--dry-run') ? 'deploy.dry-run' : 'deploy';
  await writeDrained(process.stderr, `operationId: ${operationId}\n`);
  // The deploy serves the application in this process: whatever the runtime or a library prints
  // while it runs goes to stderr, and stdout carries the one envelope.
  const stdout = reserveStdout();
  let served = false;
  try {
    const { runDeployBundle } = await import('./deploy-bundle.js');
    const outcome = await runDeployBundle(rest, { operationId, json, envelopeOut: stdout.sink });
    if (outcome.kind === 'served') {
      served = true;
      return 0;
    }
    if (!json && outcome.summary.length > 0) {
      await writeDrained(process.stderr, `${outcome.summary.join('\n')}\n`);
    }
    await writeEnvelope(stdout.sink, outcome.envelope);
    return envelopeExitCode(outcome.envelope);
  } catch (err) {
    await writeDrained(
      process.stderr,
      `${JSON.stringify({ ok: false, cliError: errMessage(err) })}\n`,
    );
    const failed = internalEnvelope(operation, operationId);
    await writeEnvelope(stdout.sink, failed);
    return envelopeExitCode(failed);
  } finally {
    // A served deploy keeps stdout reserved until the process leaves and writes its envelope.
    if (!served) stdout.release();
  }
}

/**
 * Resolve an existing command to its answer. Each command module is imported here, on its own path,
 * so one command never loads another's dependencies.
 */
async function answer(args: readonly string[], reporting: Reporting): Promise<Answer> {
  // The subcommand is the FIRST raw token; the rest is handed to that subcommand UNPARSED (each owns
  // its own arg grammar). `gen-handler` carries its own `--holes/--out/--emit/--file` flags, so the top-level
  // must NOT strict-parse them; `doctor`/`plan` take a single positional path. (A leading `--flag` other
  // than the `--version`/`-v` answered just below — no subcommand — is a usage error.)
  const command = args[0];
  const rest = args.slice(1);
  if (command === undefined) {
    throw new CliError(
      'missing command (expected `init`, `doctor`, `plan`, `openapi`, `gen-handler`, `bundle`, `pack`, `deploy`, `export`, `import`, `resume`, `tenant`, or `dev`)',
    );
  }
  // `--version`/`-v` is the one TOP-LEVEL flag, answered BEFORE the leading-dash check below —
  // otherwise it is rejected as "expected a subcommand" (exit 2) and an installed CLI cannot be asked
  // which version it is. It emits the ordinary single-JSON-object envelope on stdout and exits 0.
  if (command === '--version' || command === '-v') {
    // It answers the flag and nothing else, so a trailing token is refused rather than ignored: this
    // branch sits BEFORE the leading-dash check, and swallowing what follows would make it a hole in
    // the very grammar that check enforces (`rayspec --version --nope` would report success).
    if (rest.length > 0) {
      throw new CliError(`\`${command}\` takes no arguments, got ${rest.join(' ')}`);
    }
    const result = { ok: true, version: readCliVersion() };
    return { kind: 'result', result };
  }
  // `--help`/`-h` is a HELP REQUEST, not a usage error. It is answered at the SAME interception point
  // as `--version` — before the leading-dash check below, and before the vector reaches a subcommand's
  // strict parser or a group dispatcher, each of which would otherwise reject the flag as an unknown
  // option / unknown sub-subcommand (exit 2). Named after a command it prints THAT command's block
  // rather than the whole manual. It is the one exception to the single-JSON-object-per-invocation
  // rule: PLAIN TEXT on stdout, exit 0 (documented as such in docs/cli-reference.md).
  const help = resolveHelpRequest(args);
  if (help !== undefined) return { kind: 'text', text: help };
  if (command.startsWith('-')) {
    throw new CliError(
      `expected a subcommand (\`init\`, \`doctor\`, \`plan\`, \`openapi\`, \`gen-handler\`, \`bundle\`, \`pack\`, \`deploy\`, \`export\`, \`import\`, \`resume\`, \`tenant\`, or \`dev\`), got ${command}`,
    );
  }

  // DEV-DX: auto-load a local `.env` — `$PWD/.env` first, then the install-root `.env` (no-override
  // per key, opt-out via RAYSPEC_SKIP_DOTENV=1) — ONCE at startup so `plan`'s optional shadow-apply
  // picks up SHADOW_DATABASE_URL + DATABASE_URL out of the box (matching the server boot). Harmless to
  // `doctor` (needs no env); does NOT change plan's read-only guarantee — it only makes DATABASE_URL
  // readable so the read-only guard has a compare target.
  loadLocalDotenvIfPresent();

  switch (command) {
    case 'init': {
      // GET-STARTED: scaffold a starter project. A usage problem (unknown flag, extra positional,
      // `..`-escape) is an InitCliError → re-thrown as a CliError → exit 2; an existing-spec-without
      // --force is a normal ok:false → exit 1.
      const { InitCliError, runInit } = await import('./init.js');
      try {
        return { kind: 'result', result: await runInit(rest) };
      } catch (e) {
        if (e instanceof InitCliError) throw new CliError(e.message);
        throw e;
      }
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      return { kind: 'result', result: await runDoctor(parsePositionals(rest)) };
    }
    case 'plan': {
      const { positionals, against, allowlist, reconcileInjectedColumns } = parsePlanArgs(rest);
      const { runPlan } = await import('./plan.js');
      return {
        kind: 'result',
        result: await runPlan(positionals, { against, allowlist, reconcileInjectedColumns }),
      };
    }
    case 'openapi': {
      const { runOpenapi } = await import('./openapi.js');
      return { kind: 'result', result: await runOpenapi(parsePositionals(rest)) };
    }
    case 'gen-handler': {
      // gen-handler raises a GenHandlerCliError on a usage problem (missing flag / bad path); re-throw
      // it as a CliError so the top-level maps it to exit 2 (a malformed hole-set is ok:false → exit 1).
      const { GenHandlerCliError, runGenHandler } = await import('./gen-handler.js');
      try {
        return { kind: 'result', result: await runGenHandler(rest) };
      } catch (e) {
        if (e instanceof GenHandlerCliError) throw new CliError(e.message);
        throw e;
      }
    }
    case 'deploy': {
      // PRODUCTION-MUTATING: `--dry-run` is a one-shot JSON verdict (mapped to 0/1 like the floor); a
      // bare `deploy` is LONG-RUNNING — it boots + serves until SIGINT/SIGTERM, so it does not return a
      // JSON result (the open port + signal handlers keep the process alive). A usage problem is a
      // DeployCliError → exit 2; a fail-closed boot error is handled inside runDeploy (prints + exit 1).
      const { DeployCliError, runDeploy } = await import('./deploy.js');
      let outcome: Awaited<ReturnType<typeof runDeploy>>;
      try {
        outcome = await runDeploy(rest, reporting);
      } catch (e) {
        if (e instanceof DeployCliError) throw new CliError(e.message);
        throw e;
      }
      if (outcome.kind === 'dry-run' || outcome.kind === 'check-env') {
        return { kind: 'result', result: outcome.result };
      }
      // 'served' — the listener has been CREATED, with the bind possibly still pending (`serve()`
      // does not wait for it), so a taken port is refused by that listener's own 'error' handler and
      // never surfaces here; the open port + signal handlers keep the process alive until shutdown.
      return { kind: 'served' };
    }
    case 'tenant': {
      // PRODUCTION-MUTATING: the `tenant` group provisions organizations against the database
      // `DATABASE_URL` names, applying the committed migration chain on the way. It is a TOP-LEVEL
      // group rather than a `dev` member because `dev` is documented as local-only, which is precisely
      // why a production deployment had no supported provisioning path. A usage problem inside it is a
      // TenantCliError; re-throw it as a CliError so the top level maps it to exit 2 (an operational
      // failure is returned ok:false → exit 1).
      const { runTenant, TenantCliError } = await import('./tenant.js');
      try {
        return { kind: 'result', result: await runTenant(rest) };
      } catch (e) {
        if (e instanceof TenantCliError) throw new CliError(e.message);
        throw e;
      }
    }
    case 'dev': {
      // The `dev` group is LOCAL-DEV + MUTATING (creates a dev DB / writes secret files) — distinct
      // from the read-only diagnostic floor. A usage problem inside `dev` is a DevCliError; re-throw it
      // as a CliError so the top level maps it to exit 2 (an operational failure is returned ok:false).
      const { DevCliError, runDev } = await import('./dev.js');
      try {
        return { kind: 'result', result: await runDev(rest) };
      } catch (e) {
        if (e instanceof DevCliError) throw new CliError(e.message);
        throw e;
      }
    }
    default:
      throw new CliError(
        `unknown command ${JSON.stringify(command)} (expected \`init\`, \`doctor\`, \`plan\`, \`openapi\`, \`gen-handler\`, \`bundle\`, \`pack\`, \`deploy\`, \`export\`, \`import\`, \`resume\`, \`tenant\`, or \`dev\`)`,
      );
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse the positional path args for `doctor` (which takes exactly one positional, no flags). An
 * unknown `--flag` is a strict CLI error — preserving the original "doctor rejects unknown flags"
 * behaviour now that the top level no longer pre-parses the whole vector.
 */
function parsePositionals(args: readonly string[]): string[] {
  try {
    const { positionals } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {},
    });
    return positionals;
  } catch (e) {
    throw new CliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Parse `plan`'s args: exactly one positional spec path, plus the OPTIONAL update-mode flags
 * `--against <old-spec>`, `--allowlist <file.json>`, and the boolean `--reconcile-injected-columns`.
 * Unknown flags are a strict CLI error. The positional-count check stays in `resolveSpecPath` (a
 * missing/extra positional there is a clean plan error), so a bare `plan` with no positional still
 * routes through the normal channel.
 */
function parsePlanArgs(args: readonly string[]): {
  positionals: string[];
  against?: string;
  allowlist?: string;
  reconcileInjectedColumns?: boolean;
} {
  try {
    const { positionals, values } = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: {
        against: { type: 'string' },
        allowlist: { type: 'string' },
        'reconcile-injected-columns': { type: 'boolean' },
      },
    });
    return {
      positionals,
      against: values.against,
      allowlist: values.allowlist,
      reconcileInjectedColumns: values['reconcile-injected-columns'],
    };
  } catch (e) {
    throw new CliError(`invalid arguments: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Whether the command line serves: `deploy` without `--dry-run`, `--check-env` or a help request,
 * for a spec document or a bundle alike.
 */
export function isServingInvocation(args: readonly string[]): boolean {
  const { vector } = takeJsonFlag(args);
  if (vector[0] !== 'deploy') return false;
  const rest = vector.slice(1);
  return !rest.some(
    (token) => isHelpFlag(token) || token === '--dry-run' || token === '--check-env',
  );
}

/**
 * Top-level runner: invoke `main`, set `process.exitCode` (NOT `process.exit` — let the event loop
 * drain stdout), and route CLI/unexpected errors to stderr. A `CliError` is a clean usage error
 * (prints the message + USAGE, exit 2); any other throw is an UNEXPECTED failure (secret-free message
 * only, exit 7). All error output is drained before the process exits.
 *
 * Exported so the CliError → exit-2 mapping is directly TESTABLE in-process: a test drives
 * `run([...])` and asserts `process.exitCode` (2 for a usage/CLI error, 0/1 for the ok/not-ok spec
 * paths) — covering the exit-2 branch that `main` only THROWS into. `args` defaults to the real CLI
 * vector so the production call site (`run()`) is unchanged.
 */
export async function run(args?: readonly string[]): Promise<void> {
  // The process the operator started, before it reads anything: a serving deploy with a privileged
  // connection in its environment re-executes itself without it (and does not return here), and the
  // re-executed image takes the connections from its handoff (supervisor-handoff.ts). Only for the
  // real command line: a test driving `run([...])` in process is never re-executed.
  // Only the real command line, and only a serving deploy (or a stray handoff variable, which is
  // refused): a non-serving verb never loads the supervisor module, so `bundle`/`pack` stay free of
  // the server. The module imports only Node built-ins; it is dynamic here so the gate that proves
  // those verbs load no server module keeps holding.
  if (args === undefined) {
    const serving = isServingInvocation(process.argv.slice(2));
    if (serving || process.env.RAYSPEC_SUPERVISOR_HANDOFF !== undefined) {
      const { reexecWithoutPrivilegedConnections, SupervisorHandoffError, takeSupervisorHandoff } =
        await import('@rayspec/server/supervisor-handoff');
      try {
        if (serving) reexecWithoutPrivilegedConnections();
        takeSupervisorHandoff({ serving });
      } catch (err) {
        if (!(err instanceof SupervisorHandoffError)) throw err;
        await writeDrained(process.stderr, `[rayspec] ${err.message}\n`);
        process.exitCode = 1;
        return;
      }
    }
  }
  try {
    process.exitCode = args === undefined ? await main() : await main(args);
  } catch (err) {
    const message = errMessage(err);
    if (err instanceof CliError) {
      await writeDrained(
        process.stderr,
        `${JSON.stringify({ ok: false, cliError: message })}\n${USAGE}\n`,
      );
      process.exitCode = 2;
    } else {
      // An UNEXPECTED failure (not a handled spec/plan error — those are returned as ok:false).
      await writeDrained(process.stderr, `${JSON.stringify({ ok: false, cliError: message })}\n`);
      process.exitCode = 7;
    }
  }
}

// Run ONLY when executed as the CLI entrypoint (not when imported by a test). `argv[1]` is the script
// path Node was launched with (possibly a symlinked bin); realpath both sides before comparing so a
// symlinked `rayspec` bin still runs, while importing `main` stays side-effect free (the test drives
// `main()` directly and asserts the returned exit code).
function isMainEntry(): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const here = fileURLToPath(import.meta.url);
  try {
    return realpathSync(here) === realpathSync(entry);
  } catch {
    return here === entry;
  }
}

if (isMainEntry()) {
  // An interrupted bundle verb has already written its envelope; the read it abandoned must not keep
  // the process alive until it finishes.
  run().then(() => {
    if (workAbandoned()) process.exit();
  });
}
