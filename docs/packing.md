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
you whether this runtime can deploy it. `rayspec deploy` does not take a `.ray`
file yet: deploy the spec as before.

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
  `*.p8`, keystores), database dumps (`*.dump`, `*.sqlite`, `*.db`, `*.bak` and
  others), local `node_modules` directories, operating-system files and, without
  `--source-maps`, source maps. Names match in any letter case. The summary
  lists each with its reason.
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

## Refusals and how to fix them

Pack checks everything before it writes anything, and a refusal leaves no file
behind. The first error in the envelope is the first check that failed; its
message names the file and the fix.

| Code (reason) | Exit | What happened | Fix |
| --- | --- | --- | --- |
| `RAY_USAGE` | 2 | A flag is missing, unknown or malformed; the output is a directory or its directory does not exist; `--build`, `--against` or `--allowlist` was given; a file changed while pack ran. | Fix the command line. For a changed file, run pack again once the build has finished. |
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

A spec that uses an agent backend but declares no egress hosts is packed with
the warning `RAY_W_EGRESS_UNDECLARED`: a host network policy that enforces the
declared hosts would deny its calls.

## Not available yet

- **`--build`** is refused: pack does not run builds. Build the application
  yourself as described above.
- **`--against` and `--allowlist`** are refused: a product delta carried in a
  bundle must name the product schema heads it migrates between, and those are
  read from a database, not from spec files. Review a delta with
  `rayspec plan <spec> --against <old-spec> [--allowlist <file.json>]` and apply
  it with `rayspec deploy <spec> --apply-migration <delta.sql>`.
