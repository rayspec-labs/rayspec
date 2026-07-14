/**
 * Build the agent backends a DECLARED backend-profile spec needs, straight from the ambient env.
 *
 * The platform ships NO backend (zero product code), so a spec WITH agents needs its adapter instances
 * wired by the deployer. This is the generic, env-driven wiring the SHIPPED entrypoint (serve.ts) uses
 * so that `RAYSPEC_SPEC_PATH=<backend-profile-spec-with-agents> rayspec-serve` boots DIRECTLY — no
 * hand-written wrapper. It feeds `assembleServer`'s existing `agentBackendsFactory` seam, so the
 * roll-out's fail-closed-at-boot backend lookup (buildAgentRegistry) is satisfied for every backend the
 * spec's OWN declared agents select; the deploy pipeline itself is untouched.
 *
 * MERGED-SPEC AWARE: the base backends are derived EAGERLY from the spec's OWN `agents:` (the
 * pre-extension-merge base document `parseAnySpec` returns), so a misconfigured base credential fails
 * FAST at factory creation. The returned factory then ADDITIONALLY accepts the MERGED spec's agents
 * (deployment ⊕ extension-pack fragments, passed by the composition root after `mergeExtensions`) and
 * wires any backend a pack-contributed agent selects that NO base agent uses — so `buildAgentRegistry`
 * finds every merged agent's backend instead of failing closed at boot. Base-only deploys stay
 * byte-identical (the merged agent set equals the base set ⇒ nothing extra is built).
 *
 * This covers the canonical "thin base + all agents delegated to a pack" shape too: a spec with ZERO
 * base `agents:` that declares `extensions:` still yields a factory (its eager base map is empty), and
 * the pack's agents are wired lazily from the merged set the composition root passes. Only a spec that
 * declares NEITHER base agents NOR extensions returns `undefined` (nothing can ever need a backend).
 *
 * The mapping is NOT re-implemented here: each backend is built via `makeExtractionBackend` (the ONE
 * boot-side factory that owns the per-backend env contract + the fail-closed, actionable messages, and
 * consumes each adapter through its EXPORTED constructor only).
 */
import type { Backend, BackendId } from '@rayspec/core';
import { parseAnySpec } from '@rayspec/spec';
import { type AgentBackendsFactory, BootConfigError } from './composition-root.js';
import {
  anthropicApiKeyOverrideWarning,
  anthropicReuseLoginShadowWarning,
  makeExtractionBackend,
} from './product-boot.js';

/**
 * Build the DISTINCT backends a set of declared agents selects, reusing `makeExtractionBackend` (the ONE
 * boot-side factory) and the SAME actionable fail-closed message. A backend already present in `existing`
 * is SKIPPED (already wired — e.g. by the eager base build), and when nothing new needs building the
 * `existing` map is returned UNCHANGED (so an augmentation that adds nothing is a true no-op). On a
 * missing env the thrown `BootConfigError` names the backend, the selecting agent(s), and the missing var.
 */
function buildDeclaredBackends(
  agents: readonly { id: string; backend: string }[],
  env: NodeJS.ProcessEnv,
  existing?: ReadonlyMap<BackendId, Backend>,
): ReadonlyMap<BackendId, Backend> {
  // Distinct NEW backends (not already in `existing`) → which agent id(s) select each (for the message).
  const backendToAgents = new Map<BackendId, string[]>();
  for (const agent of agents) {
    const id = agent.backend as BackendId;
    if (existing?.has(id)) continue; // already wired (eager base build) — do not rebuild.
    const selectors = backendToAgents.get(id) ?? [];
    selectors.push(agent.id);
    backendToAgents.set(id, selectors);
  }
  // Nothing new to build ⇒ return the existing map unchanged (base-only deploys stay byte-identical).
  if (backendToAgents.size === 0) return existing ?? new Map<BackendId, Backend>();

  // Surface the Anthropic $0-subscription billing footgun UP FRONT (before the build): a sibling
  // backend's missing-env abort could otherwise fire before the anthropic case is reached, suppressing
  // makeExtractionBackend's own in-build emit. Gated on anthropic actually being NEWLY declared so an
  // openai-only spec that merely carries both tokens in env is not warned spuriously (and a re-wire that
  // skips an already-built anthropic backend does not warn twice). (In the all-green anthropic path
  // makeExtractionBackend emits the same warning again during the build — harmless.)
  if (backendToAgents.has('anthropic')) {
    const billingWarning = anthropicApiKeyOverrideWarning(env);
    if (billingWarning) console.warn(billingWarning);
    // The reuse-login shadow footgun (a token/key present alongside RAYSPEC_ANTHROPIC_REUSE_LOGIN
    // shadows the seeded per-tenant login) — surfaced UP FRONT for the same reason as the billing
    // warning (a sibling backend's missing-env abort could otherwise fire before the anthropic build).
    const shadowWarning = anthropicReuseLoginShadowWarning(env);
    if (shadowWarning) console.warn(shadowWarning);
  }

  const backends = new Map<BackendId, Backend>(existing ?? []);
  for (const [backend, selectors] of backendToAgents) {
    try {
      backends.set(backend, makeExtractionBackend(env, backend));
    } catch (err) {
      // Reuse makeExtractionBackend's env-var/backend-named message, but STRIP its own leading
      // "Boot aborted (Product-YAML) — " / "Boot aborted — " prefix so the composed abort reads
      // "Boot aborted — …" ONCE (not doubled / mislabelled Product-YAML on a backend-profile boot), and
      // add which agent(s) selected the backend. "is not configured for this boot" (NOT "credentials")
      // is accurate for BOTH a missing credential AND a missing non-credential env
      // (RAYSPEC_ANTHROPIC_CONFIG_ROOT / CODEX_HOME).
      const raw = err instanceof Error ? err.message : String(err);
      const detail = raw.replace(/^Boot aborted(?: \(Product-YAML\))? — /, '');
      throw new BootConfigError(
        `Boot aborted — declared agent(s) [${selectors.join(', ')}] select backend '${backend}', ` +
          `which is not configured for this boot: ${detail}`,
      );
    }
  }
  return backends;
}

/**
 * Given a spec's YAML TEXT + the ambient env, return an `AgentBackendsFactory` that yields exactly the
 * DISTINCT backends the spec's agents declare — or `undefined` when none is needed:
 *   - a PRODUCT-profile document builds its own backends from its extraction sidecars (not the YAML), so
 *     this returns `undefined` and the product deploy path owns the wiring;
 *   - a backend-profile spec with NEITHER base agents NOR `extensions:` (a stores/api/handler-only spec)
 *     needs no backend — nothing can ever gain an agent from a merge;
 *   - an unparseable / non-backend document likewise needs nothing here (the deploy path re-parses +
 *     fail-closed-validates the doc itself, so a real parse error surfaces there with a clean message).
 *
 * A backend-profile spec WITH ≥1 base agent builds each distinct declared backend EAGERLY, so a boot with
 * a misconfigured credential fails FAST with a clean, actionable `BootConfigError` naming the missing env
 * var, the backend, and which agent(s) select it — never deep inside `assembleServer`. A spec with ZERO
 * base agents that DECLARES `extensions:` still gets a factory (its eager base map is empty): the pack's
 * agents are wired LAZILY from the merged agent set the composition root passes, and a pack backend with
 * no env credential still fails closed via the SAME `makeExtractionBackend` throw (never a silent skip).
 *
 * The returned factory ADDITIONALLY accepts the MERGED spec's agents (the composition root passes them
 * after `mergeExtensions`). When a pack-contributed agent selects a backend NO base agent uses, the
 * factory wires that backend too — via the SAME `makeExtractionBackend` + env — so `buildAgentRegistry`
 * finds every merged agent's backend. Called with no argument (or with agents that add no new backend),
 * it returns exactly the eagerly-built base map, so base-only deploys are byte-identical.
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
  // A spec that declares NEITHER base agents NOR extension packs can never gain an agent from a merge, so
  // it needs no backend factory — a byte-identical auth-only / stores-only boot (no factory injected).
  // But a spec with ZERO base agents that DOES declare `extensions:` may gain agents from a pack merge
  // (mergeExtensions concatenates each pack's `agents` fragment into effectiveSpec.agents). For that shape
  // we MUST still return a factory: otherwise `opts.agentBackendsFactory?.(effectiveSpec.agents)`
  // short-circuits to undefined, no agent registry is built, and a pack-contributed agent is SILENTLY
  // absent — an authenticated run fail-OPENs to 404 instead of the agent being wired (or failing closed).
  if (agents.length === 0 && parsed.spec.extensions.length === 0) return undefined;

  // EAGERLY build the base backends (fail-fast at factory creation on a misconfigured base credential).
  // For a zero-base-agent + extensions spec this is an EMPTY map (no throw, no side effect); the pack's
  // backends are built lazily below when the composition root passes the merged agents.
  const baseBackends = buildDeclaredBackends(agents, env);

  // The factory yields the base map, and — given the MERGED spec's agents — additionally wires any
  // backend a pack-contributed agent selects that no base agent used (base-only ⇒ the base map returned).
  return (mergedAgents) =>
    mergedAgents === undefined
      ? baseBackends
      : buildDeclaredBackends(mergedAgents, env, baseBackends);
}
