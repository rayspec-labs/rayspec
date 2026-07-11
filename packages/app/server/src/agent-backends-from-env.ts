/**
 * Build the agent backends a DECLARED backend-profile spec needs, straight from the ambient env.
 *
 * The platform ships NO backend (zero product code), so a spec WITH agents needs its adapter instances
 * wired by the deployer. This is the generic, env-driven wiring the SHIPPED entrypoint (serve.ts) uses
 * so that `RAYSPEC_SPEC_PATH=<backend-profile-spec-with-agents> rayspec-serve` boots DIRECTLY — no
 * hand-written wrapper. It feeds `assembleServer`'s existing `agentBackendsFactory` seam, so the
 * roll-out's fail-closed-at-boot backend lookup (buildAgentRegistry) is satisfied for every declared
 * agent; the deploy pipeline itself is untouched.
 *
 * The mapping is NOT re-implemented here: each backend is built via `makeExtractionBackend` (the ONE
 * boot-side factory that owns the per-backend env contract + the fail-closed, actionable messages, and
 * consumes each adapter through its EXPORTED constructor only).
 */
import type { Backend, BackendId } from '@rayspec/core';
import { parseAnySpec } from '@rayspec/spec';
import { type AgentBackendsFactory, BootConfigError } from './composition-root.js';
import { anthropicApiKeyOverrideWarning, makeExtractionBackend } from './product-boot.js';

/**
 * Given a spec's YAML TEXT + the ambient env, return an `AgentBackendsFactory` that yields exactly the
 * DISTINCT backends the spec's agents declare — or `undefined` when none is needed:
 *   - a PRODUCT-profile document builds its own backends from its extraction sidecars (not the YAML), so
 *     this returns `undefined` and the product deploy path owns the wiring;
 *   - a backend-profile spec with NO agents (a stores/api/handler-only spec) needs no backend;
 *   - an unparseable / non-backend document likewise needs nothing here (the deploy path re-parses +
 *     fail-closed-validates the doc itself, so a real parse error surfaces there with a clean message).
 *
 * A backend-profile spec WITH ≥1 agent builds each distinct declared backend EAGERLY, so a boot with a
 * misconfigured credential fails FAST with a clean, actionable `BootConfigError` naming the missing env
 * var, the backend, and which agent(s) select it — never deep inside `assembleServer`.
 */
export function agentBackendsFactoryFromEnv(
  specText: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentBackendsFactory | undefined {
  const parsed = parseAnySpec(specText);
  // Only a parseable BACKEND-profile ('rayspec') doc reaches the agent-wiring path. A product doc, or a
  // doc that does not parse as a backend spec, needs no env-built backends here.
  if (!parsed.ok || parsed.kind !== 'rayspec') return undefined;

  const agents = parsed.spec.agents;
  if (agents.length === 0) return undefined;

  // Distinct declared backends → which agent id(s) select each (for an actionable fail-closed message).
  const backendToAgents = new Map<BackendId, string[]>();
  for (const agent of agents) {
    const id = agent.backend as BackendId;
    const selectors = backendToAgents.get(id) ?? [];
    selectors.push(agent.id);
    backendToAgents.set(id, selectors);
  }

  // Surface the Anthropic $0-subscription billing footgun UP FRONT (before the eager build): a sibling
  // backend's missing-env abort could otherwise fire before the anthropic case is reached, suppressing
  // makeExtractionBackend's own in-build emit. Gated on anthropic actually being declared so an
  // openai-only spec that merely carries both tokens in env is not warned spuriously. (In the all-green
  // anthropic path makeExtractionBackend emits the same warning again during the build — the same real
  // footgun surfaced at config-check and at build; harmless.)
  if (backendToAgents.has('anthropic')) {
    const billingWarning = anthropicApiKeyOverrideWarning(env);
    if (billingWarning) console.warn(billingWarning);
  }

  const backends = new Map<BackendId, Backend>();
  for (const [backend, selectors] of backendToAgents) {
    try {
      backends.set(backend, makeExtractionBackend(env, backend));
    } catch (err) {
      // Reuse makeExtractionBackend's env-var/backend-named message; add which agent(s) selected it.
      const detail = err instanceof Error ? err.message : String(err);
      throw new BootConfigError(
        `Boot aborted — declared agent(s) [${selectors.join(', ')}] select backend '${backend}', ` +
          `but its credentials are not configured: ${detail}`,
      );
    }
  }

  const map: ReadonlyMap<BackendId, Backend> = backends;
  return () => map;
}
