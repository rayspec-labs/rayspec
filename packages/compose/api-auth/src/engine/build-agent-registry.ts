/**
 * Declared-`agents` → agent registry builder.
 *
 * Turns `spec.agents[]` into the SAME `AgentRegistry` the run surface already resolves against
 * (`executeAgentRun` → `deps.agentRegistry.get(id)`), so a declared agent runs through the EXISTING
 * `runAgent`/`executeAgentRun` with ZERO new agent-execution code. For each agent:
 *   - the registry `AgentSpec` is the agent's BASE neutral spec (instructions/model/outputSchema/
 *     maxTurns — straight from the wrapped `core.AgentSpec` fields; `input` is the per-request runtime
 *     value, supplied by the run surface, so it is a placeholder here);
 *   - the `Backend` is resolved from the deployment-supplied `agentBackends` map (the platform ships
 * no backend — zero-product-code);
 *   - the per-run, tenant-bound `toolFactory` is built from the agent's declared `tools[]` via
 * `@rayspec/platform`'s `buildToolFactory`: each declared tool resolves to a
 *     `NeutralTool` whose handler routes through the UNCHANGED `dispatchTool` chokepoint, with the
 *     escape-hatch fn wrapped so it gets a tenant-bound `HandlerInit`.
 *
 * `validateSpec` runs again at run time inside run-core/executeAgentRun (defense in depth) — this
 * builder additionally fail-closes at BOOT on a missing backend / unresolved tool/handler, so a
 * deploy-wiring mistake aborts the boot, never a runtime 500.
 *
 * PRODUCT-AGNOSTIC: everything is derived from the validated spec + the injected backends/handlers/
 * tables at runtime. No product agent, tool, or name is in platform source.
 *
 * author-controlled MODEL INPUTS (stated explicitly):
 * (1) `agent.instructions` (the system prompt) is TRUSTED FIRST-PARTY AUTHOR input in — it is
 *      placed verbatim as the system turn (the adapters never re-inject stored/SDK content as
 *      instructions). It is the author's prompt, not untrusted runtime data.
 *  (2) a declared tool's `description`/`parameters` (see resolve-tools.ts) are likewise TRUSTED
 *      first-party author input — the model-facing tool declaration the author wrote.
 *  (3) a STORE ROW read by a tool/route handler and surfaced to the model is DATA, never
 *      instructions: a tool's output is opaque-wrapped by dispatchTool (`{kind:'tool_data'}`) so it
 *      re-enters the model as data; a route handler does not call the model. No path turns a store
 *      row into a system/user turn. (The trusted-author posture for the handler CODE itself is in
 *      @rayspec/platform's handler-runtime.ts / loader.ts.)
 */

import type { AgentSpec, Backend, BackendId } from '@rayspec/core';
import { type BlobStoreFactory, buildToolFactory, type ResolvedHandler } from '@rayspec/platform';
import type { AgentSpecConfig, RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { AgentRegistry, AgentRegistryEntry } from '../app-context.js';

/** The inputs the engine supplies to build the declared-agent registry. */
export interface BuildAgentRegistryConfig {
  /** The validated spec whose `agents[]`/`tooling[]` define the agents + their tools. */
  spec: RaySpec;
  /** Backend INSTANCE per BackendId (deployment-supplied; the platform ships none). */
  agentBackends: ReadonlyMap<BackendId, Backend>;
  /** Boot-loaded handler id → resolved function + kind (path-jailed; loadHandlers). */
  handlers: ReadonlyMap<string, ResolvedHandler>;
  /** Declared store name → runtime PgTable (for the per-run HandlerDb facade a tool handler gets). */
  productTables: ReadonlyMap<string, PgTable>;
  /**
   * the composition-root `BlobStoreFactory` (the SAME one the route/stream arms use).
   * When wired, each declared tool's per-run `ToolHandlerInit` carries `init.blob` bound to the run's
   * SERVER-DERIVED tenant — so a tool reads/writes blobs through the SANCTIONED, tenant-bound, jailed
   * `BlobStore` instead of re-implementing an fs path-jail. Optional: absent on a stores/api-only
   * deploy with no blob backend (the tool's `init.blob` is then undefined, fail-closed loudly).
   */
  blobFactory?: BlobStoreFactory;
}

/** Build the base neutral `AgentSpec` for a declared agent (the per-request `input` is a placeholder). */
function baseAgentSpec(agent: AgentSpecConfig): AgentSpec {
  return {
    name: agent.name,
    instructions: agent.instructions,
    model: agent.model,
    // `input` is the per-request RUNTIME value; the run surface (executeAgentRun) overrides it from
    // the request body. A non-empty placeholder satisfies the neutral schema's `min(1)` here.
    input: 'placeholder',
    // Declared agents reference tools by id → the per-run NeutralTools are built by `toolFactory`;
    // the spec's inline `tools` array stays empty (the wrap omits the inline neutral tools).
    tools: [],
    maxTurns: agent.maxTurns,
    ...(agent.outputSchema ? { outputSchema: agent.outputSchema } : {}),
  };
}

/**
 * Build the `AgentRegistry` from the declared agents. FAIL-CLOSED at boot: a missing backend or an
 * unresolved tool/handler throws (the deploy aborts), never a runtime 500. Empty `agents[]` ⇒ an
 * empty registry (a stores/api-only spec).
 */
export function buildAgentRegistry(config: BuildAgentRegistryConfig): AgentRegistry {
  const { spec, agentBackends, handlers, productTables, blobFactory } = config;
  const registry = new Map<string, AgentRegistryEntry>();

  for (const agent of spec.agents) {
    const backend = agentBackends.get(agent.backend as BackendId);
    if (!backend) {
      throw new Error(
        `buildAgentRegistry: declared agent '${agent.id}' selects backend '${agent.backend}' which ` +
          'is not in the injected agentBackends map — the deployment must wire that adapter instance ' +
          '(fail-closed at boot).',
      );
    }
    // Build the per-run, tenant-bound tool factory from the agent's declared tool ids. This resolves
    // each tool + its handler at boot (fail-closed) and returns a factory the run surface calls with
    // the run's TenantDb. An agent with no tools gets a factory that yields []. The blobFactory (when
    // wired) lets each tool init carry a tenant-bound `init.blob`.
    const toolFactory = buildToolFactory(spec, handlers, productTables, agent.tools, blobFactory);

    registry.set(agent.id, {
      spec: baseAgentSpec(agent),
      backend,
      toolFactory,
    });
  }

  return registry;
}
