# Asset catalog — custom code with a dependency and declared egress

A reference application in the backend profile whose behaviour is custom code: a tenant keeps a
catalog of files, and each item added is classified by an external service.

- [`packs/catalog-pack/`](./packs/catalog-pack) — an extension written in TypeScript: two route
  handlers and their routes, as a `defineExtension` manifest.
- One third-party npm dependency, [`mime-types`](https://www.npmjs.com/package/mime-types), which
  brings its own dependency `mime-db`. The create handler derives a content type from the file
  name with it.
- The `catalog_items` store, declared in [`rayspec.yaml`](./rayspec.yaml). The handlers reach it
  only through the injected, tenant-bound `init.db`: they never name a tenant and cannot read or
  write another's rows.
- One outbound HTTPS call, to `classifier.example.com`, the one host the spec declares in
  `deployment.egressHosts`.
- Static assets in [`public/`](./public), served at `/`.
- [`native-fixture/`](./native-fixture) — not part of the application: a handler whose dependency
  carries a native addon built for macOS, which `rayspec pack` refuses.

```
POST /api/items    { name, file_name } → the item, with content_type and category   (201)
GET  /api/items    the tenant's items, newest first (?limit=1-100, ?offset=)
GET  /             the static page
```

A create answers `400` for a missing or over-long `name` or `file_name`, and `502` — writing
nothing — when the classification service cannot be reached or gives no category. The call is
bounded by a 5-second timeout.

## Build

The runtime loads compiled JavaScript only, so the extension is compiled before it is packed:

```bash
node examples/asset-catalog/build.mjs --out=build/asset-catalog
```

`build.mjs` compiles `index.ts` and `handlers/*.ts` with TypeScript, writes the built extension's
`package.json` from [`package.out-of-repo.json`](./packs/catalog-pack/package.out-of-repo.json), and
copies `mime-types` and `mime-db` from wherever the source extension resolves them into a plain
`node_modules` beside the compiled extension. Nothing is downloaded. `@rayspec/platform` and
`@rayspec/handler-sdk` are not copied: the runtime that deploys the bundle provides them, and the
manifest declares them on a range (`^1.8.0`) that must include the runtime the bundle pins. Outside
this repository, install the extension's dependencies first (`npm install` in
`packs/catalog-pack` after copying `package.out-of-repo.json` over its `package.json`), with
`typescript` available to the build.

## Pack, inspect, verify

```bash
rayspec pack --spec build/asset-catalog/rayspec.yaml --output asset-catalog-1.0.0.ray
rayspec bundle inspect asset-catalog-1.0.0.ray
rayspec bundle verify  asset-catalog-1.0.0.ray
```

The bundle carries the spec, the compiled extension, `mime-types` and `mime-db` with their
notices in its SBOM and `THIRD-PARTY-NOTICES.txt`, and the static assets — no TypeScript source and
no `@rayspec/*` package. `inspect` reports `execution: in-process` (the bundle runs code) and
`egressHosts: ["classifier.example.com"]`.

## Deploy, and the egress policy

```bash
rayspec deploy asset-catalog-1.0.0.ray --dry-run
rayspec deploy asset-catalog-1.0.0.ray --plan-digest <planDigest from the dry-run>
```

The plan reports the new egress host under `permissionChanges.egressAdded`. The declaration is
what the host's network policy is programmed from; **the runtime itself blocks no host**. Program
your egress firewall or proxy from the bundle's `permissions.egressHosts` (`rayspec bundle inspect`
prints it as `egressHosts`) and deny everything else — see
[Egress](../../docs/hardened-posture.md#egress). Behind an egress proxy, set `HTTPS_PROXY` and
`NODE_USE_ENV_PROXY=1` for the deployment. A proxy reaches only the clients that use it (Node's
`fetch` and `https` under `NODE_USE_ENV_PROXY=1`); code that opens a socket of its own goes around
it, so deny direct outbound traffic at the firewall too. The reference journey shows a proxy
programmed this way refusing an undeclared host; that refusal is the proxy's, not the runtime's.
The application's dependencies resolve from the bundle at run time; nothing is installed on the
server.

## Export and import

The application is exported and imported like any other
([Exporting a deployment](../../docs/export.md), [Importing a deployment](../../docs/import.md)).
Its extension provides no blob backend of its own and the application keeps no blobs: its boot
records that, and `rayspec export` reads the record instead of loading the extension. The migration
bundle carries the application bundle, so the target serves the compiled extension and its
vendored `mime-types` and `mime-db` from it, as the source did. Program the target's egress policy
from the same bundle before you deploy it there.

An extension that kept the blobs in a backend of its own would make the export refuse the
application before it fences anything (`RAY_EXTERNAL_STATE_UNSUPPORTED`, reason
`unsupported-blob-adapter`, naming the extension); see
[Applications with extensions](../../docs/export.md#applications-with-extensions).

## The native-addon fixture

```bash
node examples/asset-catalog/native-fixture/make-tree.mjs --out=build/native-probe
rayspec pack --spec build/native-probe/rayspec.yaml --output native-probe.ray
```

The tree it writes holds a package whose addon `build/Release/probe.node` starts like a 64-bit
Mach-O file — a macOS build. Pack refuses it with `RAY_CLOSURE_INVALID`, reason `native-module`,
naming that file and saying the addon was built for macOS, and writes nothing. With `--os-field`,
the package instead declares `"os": ["darwin"]`, and the refusal names the package and its `os`
field. A bundle runs on linux/x64: a native dependency is packed only from a tree built for
linux/x64 and Node 22 (or Node-API) in an isolated Linux build. See
[Before you pack](../../docs/packing.md#before-you-pack).

## Where it is tested

- `packages/app/cli/src/reference-apps.test.ts` — the build (compiled extension, vendored
  dependencies), pack, inspect and verify, and both native-addon refusals.
- `packages/app/cli/src/reference-apps-asset-catalog.db.test.ts` — the deployment from the bundle
  alone with the real built CLI and a database; creates classified through a local HTTPS service
  reached only through an egress proxy programmed from the bundle's declared hosts; tenant
  isolation, `401` and `400`; and an update whose bundle declares no host, after which the proxy
  denies the call, the create answers `502` and the earlier rows are kept.
- `pnpm gate:handler-imports` and `pnpm gate:extension-capability` scan the extension's handlers.
- `scripts/journeys/asset-catalog.mjs` — the application with the CLI installed from the packed
  release: build, pack, the native-addon refusal, the deployment behind an egress proxy programmed
  from the bundle with npm offline, the dependency resolved from the bundle's own tree and nowhere
  above it, an additive and a refused destructive release, a release that declares no host (the
  call is refused by the proxy, the create answers `502`), a release that declares the host again,
  then the encrypted export of the serving source, an import into an empty target, a new write
  there, an exit export and an import into a second empty target — rows compared byte for byte, the
  extension and its dependency served from each target's version directory, the owner signing in
  with the same password and every earlier token and API key refused. A separate case adds an
  extension that provides its own blob backend and sees the export refuse it, naming it, with the
  source left unfenced. Run with `pnpm test:journeys --app asset-catalog`.
- `scripts/upgrade-with-data.mjs --app asset-catalog` — the application deployed with the previous
  published release and written to, then booted and deployed as a bundle by this release, every row
  and credential kept.
