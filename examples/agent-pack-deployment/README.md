# Agent-pack deployment — a synthetic backend whose only agent is contributed by an extension

This is a tiny, **synthetic** backend that is the platform's **own** forcing function for an
extension (`extensions[]`) contributing an **`agents` fragment** — not just stores/handlers/tooling/api. It
is **NOT** a real product extension; those ship as product code in their own repos.

The deployment `rayspec.yaml` is **THIN** — `version` + `metadata` + ONE `extensions[]` ref, and
**zero** base `agents:`. The whole product surface (a `notes` store, a `lookup_note` tool + its
handler, and the `note_summarizer` agent that references that tool) lives in an extension built with
`defineExtension` under [`packs/agent-pack/`](./packs/agent-pack). At boot `loadExtensions` resolves the extension
(directory-only **path-jailed**; **version-pin fail-closed**), jails the extension handler against the
**extension root**, and **merges** the extension's fragments into the deployment spec, so the **UNCHANGED**
`deploy()` materializes the store, the lint resolves the agent's tool ref against the merged tooling,
`buildAgentRegistry` registers the agent, and the `{agent}` run surface resolves + runs it.

The EXTENSION (`packs/agent-pack`) is a `@spike/*` workspace member **only** so pnpm links
`@rayspec/platform` into its `node_modules` (the extension ENTRY imports `defineExtension` at runtime); the
deployment dir itself is not a workspace package. Turbo never builds, typechecks or tests either one —
CI's `--filter='@rayspec/*'` excludes `@spike/*`.

## Building the extension

The `rayspec` serve/deploy runtime loads extension modules through the guarded `defaultImporter`, which
**fail-closed-rejects a `.ts` path** (`assertCompiledJavaScriptModule`) — so the extension, authored in
TypeScript, has to be compiled before it can be deployed. [`build.mjs`](./build.mjs) is a thin `tsc`
wrapper (see [`packs/agent-pack/tsconfig.build.json`](./packs/agent-pack/tsconfig.build.json)) that
transpiles the extension's `index.ts` + `handlers/*.ts` to ESM `.js` under `packs/agent-pack/dist/` and
marks that output `{"type":"module"}`:

```bash
node examples/agent-pack-deployment/build.mjs   # -> examples/agent-pack-deployment/packs/agent-pack/dist/
```

The built extension lands **under** the extension directory on purpose: the loader imports the entry by the
entry's own absolute file URL, so Node resolves the bare `@rayspec/platform` specifier from the built
file's location upward and reaches the extension's own `node_modules` first. Shipping this extension out of the
repository needs the same three steps the sibling example documents — see
[examples/stream-backend/README.md, 'Shipping this extension from its own repo'](../stream-backend/README.md#shipping-this-extension-from-its-own-repo).

## Deploying the built extension

**One line changes.** Point the `extensions[].module` at the BUILT directory instead of the extension
source:

```yaml
extensions:
  - id: agent_pack
    module: ./packs/agent-pack/dist # the BUILT dir; ./packs/agent-pack/node_modules is one level up
    version: 1.0.0
```

Note the difference from the committed `rayspec.yaml`, which points at `./packs/agent-pack` — the extension
SOURCE, and stays that way by design: it is the form the tests below load, opting into the loader's
`typeStrippingImporter` seam so the test runner's transform handles the `.ts` on the way in. A deploy
runtime loads compiled JavaScript only, so a deployment points at the built directory instead. No
manifest rewrite is needed either way: the extension manifest keeps its authored `handlers/lookup-note.ts`
module path and `.js`-preferred resolution loads the compiled sibling.

The build is not the whole of a deploy: it clears the compiled-JavaScript boundary and nothing else.
This document still needs its boot environment, which
`rayspec deploy --check-env examples/agent-pack-deployment/rayspec.yaml` reports (`DATABASE_URL`,
`RAYSPEC_JWT_SIGNING_KEY`, `RAYSPEC_API_KEY_PEPPER`) and exits 0/1 on. That report is derived from
**this** document, which declares no agents of its own, so it does not name the credential the extension's
`note_summarizer` needs to run: that agent declares `backend: openai`, and the OpenAI adapter reads
`OPENAI_API_KEY`.

## Where it is exercised

- `packages/app/server/src/deployable-backend-handlers.test.ts` — the compiled-JavaScript boundary on
  this extension: the production importer refuses the `.ts` source, accepts the built `dist/` (entry,
  handler AND the `agents` fragment), and the seam importer loads the source.
- `packages/app/server/src/agent-pack-factory-boot.test.ts` — the zero-base-agent + extension shape through
  the REAL from-env `agentBackendsFactory`, up to `agentRegistry.has('note_summarizer')`.
- `packages/compose/api-auth/src/engine/extension-agents.db.test.ts` — the merged extension agent running
  end-to-end against a real database.
