# @rayspec/bundle-closure

What goes into an application bundle (`.ray`), decided from the spec without running anything.
`rayspec pack` builds on it: this package computes the explicit inclusion list, the preview and
the manifest fields, and [`@rayspec/bundle`](../bundle) writes the archive. The spec checks of
`rayspec bundle verify` live here too, so pack and verify derive the manifest fields from the same
code.

## Resolving a closure

`resolveClosure({ specPath, runtimeVersion, target?, id?, version?, include?, sourceMaps?,
productMigration? })` reads the application tree and writes nothing. The application root is the
directory of the spec. The result is `{ ok: true, value }` or `{ ok: false, errors }`, where
`errors[0]` carries a code from the contract vocabulary, in the order of the pack pipeline:
`RAY_USAGE`, `RAY_SPEC_INVALID` with the `SPEC_` codes, `RAY_APPLICATION_IDENTITY_MISSING`,
`RAY_CLOSURE_INVALID` or `RAY_RUNTIME_UNSUPPORTED`, `RAY_SECRET_DETECTED`, `RAY_LIMIT_EXCEEDED`.

The inclusion list holds only what the spec names:

- the spec itself;
- **backend profile**: each `handlers[].module`; for each extension, its entry module (the compiled
  `index.js` beside an `index.ts`, as the extension loader prefers) and every module under its
  `handlers/` directory; every module those import; every file of each `frontend[].dir`;
- **product profile**: the extraction configuration the runtime reads for each extractor
  (`extraction/<id>.extractor.json`, or `extraction/extractor.json` for a single extractor) with the
  `prompt_file` and `schema_file` it names, each `instructions_ref.file`, the responder
  configuration under `conversation/` when the spec declares `conversation_input`, and the
  normalizer configuration under `record/` when it declares `input_normalize`;
- the nearest `package.json` of each module (it decides that a `.js` file is an ES module), and the
  `package.json` and dependency lock of every directory whose `node_modules` supplies a package;
- every third-party package the modules import, and the packages those depend on;
- the product migration delta and allowlist, when the caller supplies them;
- each `include` path, a file or a directory relative to the spec;
- `payload/sbom.cdx.json` (CycloneDX 1.5, canonical JSON) and `payload/THIRD-PARTY-NOTICES.txt`,
  generated from the vendored packages.

A bundle path mirrors the path under the application root: `handlers/h.js` is
`payload/handlers/h.js`.

### Modules and imports

Modules are read by [`es-module-lexer`](https://github.com/guybedford/es-module-lexer) and never
imported. A handler or extension module must be compiled JavaScript and an ES module (`.mjs`, or
`.js` under a `package.json` with `"type": "module"`): TypeScript source and CommonJS are refused,
because the runtime does not load the first and the `require()` calls of the second cannot be read
without running it. Each import is resolved as Node resolves it:

- a relative import must name an existing file inside the root; a module is followed in turn, any
  other file (JSON, WebAssembly, text) is carried;
- a Node built-in needs nothing, except `node:module`, whose `createRequire` loads modules no
  closure can see, which is refused;
- a dynamic `import()` of one string literal is followed; any other argument is refused, naming
  the file and line;
- `@rayspec/*` is the platform's and is never copied. The runtime resolves it to its own packages.
  The range the nearest declaring `package.json` gives it must include the pinned runtime version,
  under npm's rules; a range that excludes it, or a value that is no range (`workspace:*`, a path),
  is `RAY_RUNTIME_UNSUPPORTED`. A vendored package's declared `@rayspec/*` range is checked the same
  way;
- any other bare import names a package that must be installed in a `node_modules` directory
  inside the root, found from the importing file's directory upward, stopping at the root.

### Third-party packages

A vendored package is copied whole, with its `package.json` and license files, apart from its own
`node_modules` and the excluded classes below. Its `dependencies`, `optionalDependencies` and
`peerDependencies` are resolved from its real location, as Node does; a missing required one is
refused. Package managers link packages into `node_modules` (pnpm does throughout); such a link is
followed only when its target lies inside the root. The literal `import`, `import()` and
`require()` calls of every vendored module are read as well: a package the module imports without
declaring it (npm's hoisting lets that work) is carried like a declared dependency when it is
installed, with a note.

In the bundle, a package stays where the application's module imported it from. A dependency is
reused where Node already finds the same package from its dependent. Otherwise it is placed at the
path it has on disk when that path is on its dependent's lookup chain, so an npm layout keeps its
shape, or else at the highest `node_modules` from the dependent's dependency root down, so a pnpm
layout becomes a hoisted one. A place is taken only when the dependent then finds it and no lookup
made so far, the application's own included, changes. Each import therefore resolves to the
version it resolved to on the author's machine, and a package several others share stays one copy
and one module instance. A package named in `peerDependencies` that would still need two copies is
refused (`unresolved-import`).

A package is native when it ships a `.node` addon or a `binding.gyp`, sets `gypfile`, or depends on
a known native loader (`bindings`, `node-gyp-build`, `prebuild-install`, `node-addon-api` and
others). It is carried only when it has compiled addons and every one is built for linux/x64 and
Node 22: the ELF header must name a 64-bit little-endian x86-64 shared object for System V or
GNU/Linux, and the addon must export `napi_register_module_v1` (Node-API) or
`node_register_module_v127`. The file is read, never loaded. Anything else is `RAY_CLOSURE_INVALID`
`native-module`, naming the package, the file and the platform it was built for; an application
module importing a native loader itself is refused the same way. Every other file of a vendored
package is checked by its first bytes too: an ELF, Mach-O or Windows PE binary must be an ELF file
for x86-64 Linux. A package whose `os` or `cpu` field excludes linux or x64 is refused, optional or
not: it is a platform-specific build installed for the author's machine.

### What never enters

The resolver walks only the directories the spec names or `include` adds, and there it leaves out
version-control metadata (`.git`, `.hg`, `.svn`), caches, `logs/` and `*.log`, environment files
(`.env`, `.env.*`, `*.env`, `.envrc`), credentials (`id_rsa` and its kin, credential directories
such as `.aws/` and `.ssh/`, `credentials`, `.pgpass`, `.netrc`, `.npmrc`, service-account and
`client_secret` JSON files, `*.pem`, `*.key`, `*.p8`, keystores), database dumps (`*.sql`,
`*.dump`, `*.sqlite`, `*.db`, `*.bak` and others), local `node_modules` directories, operating-system
metadata and, unless `sourceMaps` is set, source maps. Names match in any letter case. Each is
listed in `excluded` with its reason. A file of those classes named explicitly (by the spec, an
import or `include`) is refused instead: `excluded-file`, or `source-map-not-opted-in` for a
source map. A `*.sql` file is the exception: named explicitly, it goes in. A file whose first bytes
are those of a database dump (the banner pg_dump, pg_dumpall, mysqldump or mariadb-dump write in
plain-text output, or the magic of a pg_dump archive or an SQLite database) is a dump whatever its
name: left out of a walked directory and refused with `excluded-file` when named. A script or style sheet of the application that inlines its source map as a `data:`
URL is refused with `source-map-not-opted-in` unless `sourceMaps` is set.

Inside a vendored package only environment and credential files by their exact name,
version-control and credential directories and, unless `sourceMaps` is set, source maps are left
out: the package may read its `*.pem` certificates, `*.db` data or `logs/` modules at run time. A
private key among its files is still found by the secret scan's content rule.

Every path is anchored in the root. A reference that is absolute or lands outside the root is
refused (`escaping-link`), and so is any symbolic link met on the way or in a walked directory,
because a bundle holds regular files only. A file of the application with more than one name on
disk (a hard link) is refused the same way, since its other name may lie outside the root; files
of vendored packages are exempt, because pnpm hard-links them from its store. A name a bundle path cannot carry (only
`A-Z a-z 0-9 _ . - @ +` per segment), two names that differ only in letter case, and a file that
is also another file's directory are refused before the writer would.

Every file, the generated ones included, then goes through the bundle's secret rules
(`@rayspec/bundle`): a secret file name, or a PEM private-key header in the content. Any hit is
`RAY_SECRET_DETECTED`, one error per file, naming the bundle path and never the content.

## Derived fields

- **Identity**: `id` and `version` override the spec's `metadata.id` and `metadata.version`
  (backend profile) or `product.metadata.id` and `product.metadata.version` (product profile).
  Nothing else is a source; a missing or malformed value is `RAY_APPLICATION_IDENTITY_MISSING`
  with the reason `id` or `version`.
- **`requires`, `permissions.execution`, `permissions.egressHosts`**: `deriveManifestFields`,
  following each capability's `derivedFrom` rule. `bundle verify` runs the same function on the
  spec inside the archive and `checkDerivedFields` refuses a manifest that differs. Egress hosts
  derive as an empty list until the grammar can declare them, and a spec using an agent backend
  gets the `RAY_W_EGRESS_UNDECLARED` warning.
- **`bindings`**: `deriveBindings`, the platform-grantable credentials of the agent backends the
  spec uses (`OPENAI_API_KEY` for `openai` and `pi`, `ANTHROPIC_API_KEY` or
  `CLAUDE_CODE_OAUTH_TOKEN` for `anthropic`, `CODEX_API_KEY` for `codex`). A product spec's
  backends come from the configuration files the closure carries. Names only, never values.

## Output

- `closurePreview(closure)` — the summary `rayspec pack --preview` prints: application id and
  version, spec, target, runtime version, capabilities, binding names, execution level, egress
  hosts, warnings, notes, excluded files, total bytes, and every file with its size, SHA-256 and
  source. Pure; it reads nothing.
- `closureManifest(closure)` — the application manifest without its inventory, for `writeBundle`.
- `closureFiles(closure)` — the files as `writeBundle` takes them. Files on disk are passed by
  path and read again by the writer, so a caller compares the written inventory with the closure's
  digests.

The resolver never builds anything: TypeScript handlers, extensions and frontends must be built
before packing, and a native module must come from an isolated linux/x64 build. Nothing it reads is
imported, evaluated or executed.
