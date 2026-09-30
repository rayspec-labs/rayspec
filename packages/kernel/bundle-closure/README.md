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
followed only when its target lies inside the root. In the bundle, a package stays where the
application's module imported it from, and a dependency is reused where Node would already find
the same package from its dependent, and otherwise placed in the dependent's own `node_modules`,
so each import resolves to the version it resolved to on the author's machine.

A package is native when it ships a `.node` addon or a `binding.gyp`, sets `gypfile`, or depends on
a known native loader (`bindings`, `node-gyp-build`, `prebuild-install`, `node-addon-api` and
others). It is carried only when it has compiled addons and every one is built for linux/x64 and
Node 22: the ELF header must name a 64-bit little-endian x86-64 shared object for System V or
GNU/Linux, and the addon must export `napi_register_module_v1` (Node-API) or
`node_register_module_v127`. The file is read, never loaded. Anything else is `RAY_CLOSURE_INVALID`
`native-module`, naming the package, the file and the platform it was built for; an application
module importing a native loader itself is refused the same way.

### What never enters

The resolver walks only the directories the spec names or `include` adds, and there it leaves out
version-control metadata (`.git`, `.hg`, `.svn`), caches, `logs/` and `*.log`, environment files
(`.env`, `.env.*`), credentials (`id_rsa` and its kin, `.pgpass`, `.netrc`, `.npmrc`, `*.pem`,
`*.key`, keystores), database dumps (`*.dump`, `*.sqlite`, `*.db`, `*.bak` and others), local
`node_modules` directories, operating-system metadata and, unless `sourceMaps` is set, source maps.
Each is listed in `excluded` with its reason. A file of those classes named explicitly (by the
spec, an import or `include`) is refused instead: `excluded-file`, or `source-map-not-opted-in`
for a source map.

Every path is anchored in the root. A reference that is absolute or lands outside the root is
refused (`escaping-link`), and so is any symbolic link met on the way or in a walked directory,
because a bundle holds regular files only. A name a bundle path cannot carry (only
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
