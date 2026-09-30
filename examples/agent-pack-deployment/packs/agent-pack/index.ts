/**
 * The SYNTHETIC `agents`-fragment EXTENSION — the platform's own
 * forcing-function for an extension contributing an OOTB `agents` fragment (not just stores/handlers/
 * tooling/api). It carries a self-contained, PRODUCT-AGNOSTIC structured-output agent: a `notes`
 * store, a `lookup_note` tool (+ its handler), and an agent that references that tool. Loaded via
 * `extensions: [{ id, module: ./packs/agent-pack, version }]`.
 *
 * This proves the core capability: an extension can ship its own agent, registered +
 * runnable like a deployment agent post-merge. `loadExtensions` resolves THIS manifest (path-jailed
 * directory, version-pin fail-closed), jails the handler against THIS extension root, and merges the
 * fragments into the deployment spec so the UNCHANGED `deploy()` materializes the store, the lint
 * resolves the agent's tool ref against the merged tooling, `buildAgentRegistry` registers the agent,
 * and the `{agent}` run surface resolves + runs it — with the deployment's `agentBackendsFactory`
 * resolving its `backend`. A real product extension is the intended consumer of this exact
 * fragment in its own repo — this is the platform's synthetic twin (zero product vocabulary).
 *
 * The extension ENTRY (this file) authors against `@rayspec/platform` (where `defineExtension` + the
 * fragment types live). The extension HANDLER under `handlers/` imports ONLY `@rayspec/handler-sdk`. This
 * dir is in no tsconfig (an `examples/` fixture, excluded from turbo/CI build). Nothing transforms
 * this file on the way into a deploy: `loadExtensions` loads compiled JavaScript only, so the
 * example's `build.mjs` compiles the extension to `dist/` and a deployment points at that directory. A
 * TEST loads this source through the loader's explicit `typeStrippingImporter` seam instead.
 */
import { defineExtension } from '@rayspec/platform';

export default defineExtension({
  version: '1.0.0',
  fragments: {
    // A NORMAL generated table (text; no new ColumnType) — rides the UNCHANGED migration gate +
    // chokepoint probe. The tenancy/GDPR columns are INJECTED by the generator.
    stores: [
      {
        name: 'notes',
        columns: [{ name: 'title', type: 'text' }],
      },
    ],
    // The escape-hatch TS module the extension tool references (jailed under THIS extension root by
    // loadExtensions).
    handlers: [
      {
        id: 'lookup_note_handler',
        module: 'handlers/lookup-note.ts',
        export: 'lookupNote',
        kind: 'tool',
      },
    ],
    // The extension's own tool, wired to the extension handler by id (lint-resolved post-merge).
    tooling: [
      {
        id: 'lookup_note',
        name: 'lookup_note',
        description: 'Look up a note by id.',
        parameters: {
          type: 'object',
          properties: { note_id: { type: 'string' } },
          required: ['note_id'],
        },
        outputSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
        handler: 'lookup_note_handler',
        idempotent: true,
        timeoutMs: 5000,
      },
    ],
    // The EXTENSION-CONTRIBUTED OOTB AGENT — references the extension's own tool. Its `backend` is
    // resolved at boot by the DEPLOYMENT's agentBackendsFactory. Post-merge it is indistinguishable
    // from a deployment agent: registered + runnable through the SAME run surface.
    agents: [
      {
        id: 'note_summarizer',
        name: 'Note Summarizer',
        instructions: 'Summarize the looked-up note.',
        model: 'gpt-4o-mini',
        backend: 'openai',
        tools: ['lookup_note'],
      },
    ],
  },
});
