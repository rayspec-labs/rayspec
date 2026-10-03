# Packing an application

`rayspec pack` turns an application that is already built into one file, an
application bundle (`.ray`): the spec, the compiled code and static files it
needs at run time, the third-party packages that code imports, a dependency
lock, an SBOM and the license notices. It carries no secret value, no database
row and no cloud account. This page covers what goes in, what never does, and
how to fix each refusal. The flags, the output and the exit codes are in the
[CLI reference](./cli-reference.md#pack).

Packing is not deploying. `pack` writes a file and nothing else; check the file
with [`rayspec bundle verify`](./cli-reference.md#bundle-verify), which tells
you whether this runtime can deploy it, and deploy it with
`rayspec deploy <file.ray>` — see
[Deploying a bundle on your own server](./self-hosted-deployment.md).

## Before you pack

Pack packages what is already built and never runs a build, an install or any
code of the application. Build first:

- **Handlers written in TypeScript** — compile them to JavaScript ES modules and
  pack the spec of the built output. The backend examples ship a build step:
  `node examples/acme-notes-backend/build.mjs` writes `dist/rayspec.yaml`, which
  is the spec to pack.
- **Extensions** — compile each one and point its `module:` at the built
  directory (for example `./packs/stream-pack/dist`). The entry `index.js` and
  every module under its `handlers/` directory must be compiled JavaScript.
- **Frontends** — build each `frontend[].dir`; pack carries the directory as it
  finds it.
- **Native modules** — a package with a compiled addon must be built for
  linux/x64 and Node 22 (or Node-API) in an isolated Linux build, and that tree
  packed. A build made on macOS or another platform is refused, never copied:
  pack reads the header of every file of every package it carries, whatever its
  name, and refuses a Mach-O, Windows or non-x64 binary. It also refuses a
  package whose `os` or `cpu` field in its `package.json` excludes linux/x64,
  such as the `@esbuild/darwin-arm64` a Mac installs; install the dependencies
  for linux/x64 instead (`npm install --os=linux --cpu=x64`).

A `.js` module must be an ES module: an `.mjs` file, or a `.js` file under a
`package.json` with `"type": "module"`.

## The application id and version

A bundle names its application by an id and a version:

```yaml
# backend profile
metadata:
  name: Notes
  id: notes            # a lowercase letter, then up to 62 lowercase letters, digits or hyphens
  version: '1.4.0'     # an exact semantic version, no build metadata

# product profile
product:
  metadata:
    id: notes
    version: '1.4.0'
```

`--id` and `--version` override the spec. Pack refuses when neither gives a
value: it never takes the id from `metadata.name` or the product id, and never
takes the version from the runtime.

## Running it

```sh
# See what would go in, and write nothing.
rayspec pack --spec dist/rayspec.yaml --output notes-1.4.0.ray --preview

# Write the bundle, then check it.
rayspec pack --spec dist/rayspec.yaml --output notes-1.4.0.ray
rayspec bundle verify notes-1.4.0.ray
```

The bundle pins the version of the CLI that packs it as its runtime;
`--runtime <exact-version>` pins another one, and `bundle verify` then holds the
bundle to that version. Pack writes the archive to a temporary file beside the
output, reads it back, and moves it into place only when every check passed.
An existing output is refused unless you pass `--force`.

On stderr pack prints the inclusion summary: the application, the runtime and
target it pins, the capabilities it requires, the binding names a deployer
supplies (never values), the execution level, the egress hosts, the number of
files and bytes, what it left out and why, warnings, and the SHA-256 of the
written file. `--preview` also lists every file with its size, SHA-256 and
source. Stdout carries one JSON result envelope, with or without `--json`.

The capabilities a bundle requires do not include the extraction provider its extractors
select. A product whose extraction config selects the
[deterministic extraction provider](./spec-reference.md#the-deterministic-extraction-provider)
(`"backend": "deterministic"`, for development and tests only) packs with no requirement that
says so, and `inspect` does not show it; the deployment's boot refuses that provider under
`RAYSPEC_HOSTING_POSTURE=managed`.

## What goes in

Pack starts from the spec and follows what it names; it never zips the
directory as a whole. The directory of the spec is the application root, and a
file keeps its path under it: `handlers/h.js` is `payload/handlers/h.js` in the
bundle.

- The spec.
- **Backend profile:** each `handlers[].module`; each extension's entry module
  and the modules under its `handlers/` directory; every module those import,
  read by a lexer and never run; each `frontend[].dir` with its files.
- **Product profile:** the extraction, responder and normalizer configuration
  files the runtime reads next to the spec, and the prompt and schema files they
  and `instructions_ref` name.
- The `package.json` that makes each module an ES module, and the `package.json`
  and lock file of every directory whose `node_modules` supplies a package.
- Every third-party package the modules import, and the packages those depend
  on, placed so that each import resolves to the version it resolves to on
  your machine, and a package several others share (a peer dependency such as
  `react`) is one copy, as it is one module instance on your machine. A package
  keeps its path under `node_modules` when Node finds it there from its
  dependent; a pnpm layout is flattened into a hoisted one. When a shared peer
  would have to be copied under each dependent, pack refuses instead.
- A package that a vendored package imports without declaring it in its
  `package.json` (npm's hoisting lets that work on your machine). Pack reads the
  literal `import`, `import()` and `require()` calls of every vendored module,
  carries each such package it finds installed, and notes it in the summary.
- Each `--include` path, a file or directory relative to the spec.
- Generated: `payload/sbom.cdx.json` (CycloneDX 1.5) and
  `payload/THIRD-PARTY-NOTICES.txt`, from the packages the bundle carries.

## What never goes in

- **`@rayspec/*` packages.** The runtime that deploys the bundle provides them.
  The range a `package.json` declares for one must include the runtime the bundle
  pins, or pack refuses.
- **Anything outside the application root**, any symbolic link, and any file
  of the application with a second name on disk (a hard link), which may be a
  file outside the root: a bundle holds regular files only. Files of vendored
  packages are exempt from the hard-link rule, since pnpm links them from its
  store.
- In a directory it walks (a frontend, an extension's `handlers/`, an
  `--include` directory), pack leaves out version-control metadata (`.git`,
  `.hg`, `.svn`), caches, `logs/` and `*.log`, environment files (`.env`,
  `.env.*`, `*.env`, `.envrc`), credentials (`id_rsa` and its kin, `.aws/`,
  `.ssh/` and other credential directories, `credentials`, `.pgpass`, `.netrc`,
  `.npmrc`, service-account and `client_secret` JSON files, `*.pem`, `*.key`,
  `*.p8`, keystores), database dumps (`*.sql`, `*.dump`, `*.sqlite`, `*.db`,
  `*.bak` and others), local `node_modules` directories, operating-system files
  and, without `--source-maps`, source maps. Names match in any letter case. The
  summary lists each with its reason. A SQL file your application needs, such as
  a migration it reads, goes in when you name it with `--include`.
- **A database dump, whatever its name.** A file whose first bytes are those of
  a dump (the banner pg_dump, pg_dumpall, mysqldump or mariadb-dump write at
  the top of plain-text output, or the start of a pg_dump archive or an SQLite
  database) is left out of a walked directory, and refused with
  `excluded-file` when the spec or `--include` names it. Move the dump out of
  the application directory.
- Inside a vendored package, pack leaves out only environment and credential
  files by their exact name (`.env`, `.envrc`, `id_rsa`, `.npmrc` and the like),
  version-control and credential directories and, without `--source-maps`,
  source maps. The package's other files, a `*.pem` certificate bundle or a
  `*.db` data file among them, may be read at run time and go in; a private key
  among them is still found by its content.
- **A source map inlined in a script or style sheet** (a `sourceMappingURL`
  with a `data:` URL, which may carry the original source) without
  `--source-maps`: pack refuses the file rather than carry it.
- **A private key or a secret file**, wherever it is: every file, the generated
  ones included, goes through the bundle's secret rules.
- **A timestamp, your user name, your host name or an absolute path.** The same
  prepared files and flags give the same bytes, from any directory and at any
  time.

## A product schema change

When the new release changes the stores, pack it against the spec the
environment runs:

```bash
SHADOW_DATABASE_URL=postgresql://user:pass@localhost:5432/scratch \
  rayspec pack --spec build/rayspec.yaml --output app-1.1.0.ray \
    --against deployed/rayspec.yaml [--allowlist reviewed-allowlist.json]
```

The bundle then carries, under `payload/migrations/`:

| File | Content |
| --- | --- |
| `product-delta.sql` | the forward delta from the previous spec's stores to the new spec's, generated as `rayspec plan --against` generates it |
| `product-allowlist.json` | the `--allowlist` file, byte for byte, when one was given |

and the manifest's `productMigration` names both files, the product schema
digests the delta migrates between and whether the delta is destructive. Pack
computes the digests on a throwaway database it creates and drops on the server
`SHADOW_DATABASE_URL` names: the platform migrations and the previous spec's
stores give the digest before, the delta the digest after. `SHADOW_DATABASE_URL`
is read from the environment only, never from a `.env` file, and nothing else on
that server is touched. When the stores did not change, the bundle carries no
delta and the summary says so.

A **destructive** delta (a dropped store or column, a tightened type or
constraint, a non-nullable column without a default) is refused unless every
statement is cleared by an entry of the `--allowlist` file. The refusal names each
store and column. To review it:

1. Run `rayspec plan build/rayspec.yaml --against deployed/rayspec.yaml`. Its
   `proposedAllowlist` lists one entry per destructive statement.
2. Copy the entries you approve into a JSON file, each with the reason you
   accepted it: `[{"kind": "drop-column", "match": "ALTER TABLE \"notes\" DROP COLUMN \"body\"", "reason": "…"}]`.
3. Pack again with `--allowlist <that file>`.

The target runtime trusts none of this. Its plan regenerates the delta from its
own product migration ledger and the bundled spec, and refuses a bundle whose
delta differs (`RAY_MIGRATION_MISMATCH`), whose digest before is not the live
one (`RAY_MIGRATION_REQUIRED`), or whose digest after is not the one the delta
produces there (`RAY_MIGRATION_MISMATCH`). The manifest's `destructive` flag is
advisory: the runtime scans the delta itself, and only the allowlist the bundle
carries clears a finding. See
[Runtime operations → Product schema changes](./runtime-operations.md#product-schema-changes).

## Refusals and how to fix them

Pack checks everything before it writes anything, and a refusal leaves no file
behind. The first error in the envelope is the first check that failed; its
message names the file and the fix.

| Code (reason) | Exit | What happened | Fix |
| --- | --- | --- | --- |
| `RAY_USAGE` | 2 | A flag is missing, unknown or malformed; the output is a directory or its directory does not exist; `--build` was given, or `--allowlist` without `--against`; a file changed while pack ran. With `--against`: the previous spec cannot be read or is of the other profile; the allowlist is malformed or has no delta to cover; a destructive delta the allowlist does not clear (the message names each store and column and the review step); `SHADOW_DATABASE_URL` is missing or cannot be used. | Fix the command line. For a changed file, run pack again once the build has finished. For a destructive delta, review it as described under [A product schema change](#a-product-schema-change). |
| `RAY_SPEC_INVALID` | 1 | The spec does not validate; the `SPEC_` errors that follow say where. | Fix the spec; `rayspec doctor <spec>` shows the same errors. |
| `RAY_APPLICATION_IDENTITY_MISSING` (`id`, `version`) | 2 | Neither the spec nor the flag gives the id or version, or the value does not match its pattern. | Add `metadata.id` and `metadata.version`, or pass `--id` and `--version`. |
| `RAY_CLOSURE_INVALID` (`unresolved-import`) | 2 | A module, frontend directory or import is missing; a module is TypeScript or CommonJS; a dynamic `import()` names a computed module; a module imports `node:module`; a peer dependency several packages share would need two copies. | Build the application and pack the built spec; install the missing package; import modules by a literal name; import the shared peer from the application, or install one version of it (`npm dedupe`). |
| `RAY_CLOSURE_INVALID` (`escaping-link`) | 2 | A path is absolute or leads outside the application root, or is a symbolic link or a hard link. | Name paths relative to the spec; copy the file into the application, or build into a directory without links. |
| `RAY_CLOSURE_INVALID` (`excluded-file`) | 2 | A file of an excluded class was named explicitly (by the spec, an import or `--include`), or a file name a bundle path cannot carry (only `A-Z a-z 0-9 _ . - @ +`, no two names that differ only in case). | Leave the file out, or rename it. |
| `RAY_CLOSURE_INVALID` (`native-module`) | 2 | A native addon is not a linux/x64 build for Node 22 or Node-API; a package file is a binary for another platform; a package's `os` or `cpu` field excludes linux/x64; or a native package has no compiled addon. | Install and build the dependencies for linux/x64 in an isolated Linux build and pack that tree. |
| `RAY_CLOSURE_INVALID` (`source-map-not-opted-in`) | 2 | A source map was named, or a script or style sheet inlines one, without `--source-maps`. | Pass `--source-maps`, or build without inline source maps. |
| `RAY_RUNTIME_UNSUPPORTED` | 3 | A `package.json` declares a `@rayspec/*` range that excludes the pinned runtime, or a value that is no range (`workspace:*`, a path). | Declare a range that includes the runtime, or pin the matching runtime with `--runtime`. |
| `RAY_SECRET_DETECTED` | 4 | A file that would go in carries a PEM private-key header, or has a secret file name (`.env`, `id_rsa`, `.pgpass` and the like) where pack does not leave it out. The message names the path, never the content. | Remove the key or the file; supply secrets as bindings at deploy time. |
| `RAY_BINDING_RESERVED` | 4 | A binding name the bundle would declare is reserved for the operator. | Use another name. |
| `RAY_LIMIT_EXCEEDED` | 2 | More than 9,999 files, a path longer than 4,096 bytes, or more than 512 MiB. | Leave out what the application does not need at run time. |
| `RAY_OUTPUT_EXISTS` | 2 | The output file exists. | Choose another path, or pass `--force` to replace it. |
| `RAY_INTERRUPTED` | 6 | SIGINT or SIGTERM arrived; nothing was written. | Run pack again. |
| `RAY_INTERNAL` | 7 | A defect in pack. | Report it with the operation id. |

The manifest's `permissions.egressHosts` are the hosts the spec declares in
`deployment.egressHosts` (backend profile) or `deployment_overrides.egress_hosts`
(product profile), in code-point order. The declaration is what a host network
policy is programmed from; the runtime itself blocks nothing. A spec that uses
an agent backend but declares no egress hosts is packed with the warning
`RAY_W_EGRESS_UNDECLARED`: a host network policy that enforces the declared
hosts would deny its calls.

## Signing a bundle

A signature lets whoever deploys a bundle check that it is the file you
published, byte for byte, and that you published it. It is a small detached
file next to the bundle: Ed25519 over the bundle's SHA-256, naming the SHA-256
of your public key. The bundle itself is not changed.

**1. Make a signing key once**, and keep it to yourself:

```sh
openssl genpkey -algorithm ed25519 -out publisher.pem
chmod 600 publisher.pem
openssl pkey -in publisher.pem -pubout -out publisher.pub.pem
```

`publisher.pem` is the private key. `bundle sign` refuses it unless it is a
regular file (not a link), owned by you, and readable by nobody else (mode
`0600` or `0400`), and unless it holds one unencrypted Ed25519 private key in
PEM form; a public key, an RSA or EC key, or an encrypted key is refused. If
you pass `publisher.pub.pem` by mistake, the refusal says it holds a public
key, whatever its mode.
Store it like any other credential: never in the repository, never in the
application directory you pack.

**2. Sign each bundle** after you pack it:

```sh
rayspec pack --spec dist/rayspec.yaml --output notes-1.4.0.ray
rayspec bundle sign notes-1.4.0.ray --key-file publisher.pem
```

This writes `notes-1.4.0.ray.sig`, the name `bundle verify` and `deploy` look
for. Sign runs the same structural checks `bundle inspect` runs, so a damaged
or hostile archive is refused before anything is written; it does not run the
runtime, capability or spec checks, so check the bundle with `bundle verify`
too. It verifies the signature it wrote against the public half of your key
before it reports success, and prints the bundle's SHA-256, the signature path
and your public key's SHA-256 — never the key. `--output` writes the
signature elsewhere; an existing signature file is refused unless you pass
`--force`. `bundle verify` reads a signature written elsewhere only when you
give it `--signature <path>`, and `deploy` reads only `<file.ray>.sig`, so a
signature you hand out with a bundle goes next to it under that name.

**3. Hand out the public key** — `publisher.pub.pem` — through a channel
the deployer already trusts (your repository's release page, a key published
on your own domain, or in person), separately from the bundle. A key that
travels with the bundle proves nothing: whoever could swap the bundle could
swap the key. Tell the deployer its SHA-256 too
(`openssl pkey -pubin -in publisher.pub.pem -outform DER | sha256sum`); sign
and verify both print it.

**4. The deployer verifies** with that public key, and refuses an unsigned
bundle:

```sh
rayspec bundle verify notes-1.4.0.ray --trusted-key publisher.pub.pem --require-signature
rayspec deploy notes-1.4.0.ray --dry-run --trusted-key publisher.pub.pem --require-signature
```

A bundle changed after signing, a signature made by another key, or a missing
signature is refused with `RAY_SIGNATURE_INVALID` (exit 4).

**What a signature proves, and what it does not.** A verified signature shows
that the archive is exactly the one the holder of the private key signed, and
nothing more. It does not show that the code in the bundle is safe, correct or
free of secrets, that the signer reviewed it, or that the bundle suits the
runtime you deploy it on — `bundle verify` checks that last part separately. It
is only as good as the key: anyone who has `publisher.pem` can sign anything as
you, and a deployer who trusts the wrong public key trusts its holder. If the
key leaks, make a new one, re-sign what you still publish, and tell deployers
to drop the old public key.

## Not available yet

- **`--build`** is refused: pack does not run builds. Build the application
  yourself as described above.

