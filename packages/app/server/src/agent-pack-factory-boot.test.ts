/**
 * BOOT-LEVEL acceptance that the "thin base + all agents delegated to an extensions pack" shape is wired
 * through the REAL shipped from-env path — the case CI was green on while it was broken (a blind spot: a
 * passing test proved nothing because no test exercised this shape through the shipped factory).
 *
 * The existing coverage is BLIND to this shape:
 *   - the factory UNIT tests use a base WITH ≥1 agent (so the `agents.length === 0` early-return never
 *     fires), and
 *   - `extension-agents.db.test.ts` proves the pack-agent MERGE end-to-end but INJECTS `agentBackends`
 *     directly into the harness — it never runs `agentBackendsFactoryFromEnv`, so it could not catch the
 *     factory returning `undefined` for a zero-base-agent spec.
 * So the zero-base-agent + pack shape was proven NOWHERE through the shipped from-env factory. This test
 * closes that gap: it reads the repo's OWN forcing-function deployment (`examples/agent-pack-deployment`,
 * ZERO base `agents:`, the pack contributes the only agent `note_summarizer → openai`), runs the REAL
 * factory, performs the REAL `loadExtensions` merge the composition root performs, and asserts the pack
 * agent ends up in the SAME `AgentRegistry` the run surface resolves against (`deps.agentRegistry.has(id)`
 * — the exact predicate whose miss is the fail-OPEN 404).
 *
 * Faithful to `composition-root`'s path: `agentBackendsFactoryFromEnv(baseText)` → `mergeExtensions`
 * (loadExtensions + concat) → `factory(effectiveSpec.agents)` → `buildAgentRegistry`. DB-free +
 * network-free: the OpenAI adapter is built from an INERT key (construction only, never run), and
 * `buildAgentRegistry` resolves the pack tool/handler at boot without touching a database.
 *
 * FAIL-THE-FIX: with the pre-fix `agents.length === 0` early-return the factory is `undefined` for this
 * shape, so `expect(factory).toBeTypeOf('function')` is RED (and the wiring below can never run) — GREEN
 * only once the factory is created for a zero-base-agent spec that declares `extensions:`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAIAdapter } from '@rayspec/adapter-openai';
import { buildAgentRegistry } from '@rayspec/api-auth';
import type { BackendId } from '@rayspec/core';
import { loadExtensions, loadHandlers, typeStrippingImporter } from '@rayspec/platform';
import { parseSpec, type RaySpec } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { agentBackendsFactoryFromEnv } from './agent-backends-from-env.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/app/server/src -> repo-root/examples/agent-pack-deployment
const repoRoot = resolve(here, '../../../..');
const DEPLOYMENT_DIR = resolve(repoRoot, 'examples/agent-pack-deployment');
const YAML_PATH = resolve(DEPLOYMENT_DIR, 'rayspec.yaml');

// An INERT key: the OpenAI adapter is CONSTRUCTED (proving the factory built it) but never RUN, so no
// provider is ever contacted — the test is fully deterministic + hermetic.
const INERT_ENV: NodeJS.ProcessEnv = { OPENAI_API_KEY: 'sk-inert-boot-only-never-called' };

/**
 * Reproduce exactly what `composition-root.mergeExtensions` yields for this deployment: load the pack via
 * the REAL `loadExtensions` (DIRECTORY-ONLY path-jailed; version-pin fail-closed) and concatenate the
 * pack's fragments onto the (empty) base sections — so `spec.agents` is the effectiveSpec agent set the
 * composition root passes to `opts.agentBackendsFactory(effectiveSpec.agents)`.
 */
async function loadMergedDeployment(): Promise<{
  baseText: string;
  spec: RaySpec;
  importer: Awaited<ReturnType<typeof loadExtensions>>['importer'];
}> {
  const baseText = readFileSync(YAML_PATH, 'utf8');
  const parsed = parseSpec(baseText);
  if (!parsed.ok) throw new Error(`deployment spec invalid: ${JSON.stringify(parsed.errors)}`);
  const base = parsed.value;
  // Ground the premise: the base document really declares ZERO agents (this IS the pack-only shape).
  expect(base.agents).toHaveLength(0);
  expect(base.extensions.length).toBeGreaterThan(0);

  const loaded = await loadExtensions(base.extensions, {
    packsRoot: DEPLOYMENT_DIR,
    deploymentRoot: DEPLOYMENT_DIR,
    // Un-built `.ts` pack under vitest: opt into the type-stripping importer seam (production loads
    // compiled `.js` only; this is the single, explicit way un-built source loads).
    importer: typeStrippingImporter,
  });
  const spec: RaySpec = {
    ...base,
    stores: [...base.stores, ...loaded.stores],
    handlers: [...base.handlers, ...loaded.handlers],
    tooling: [...base.tooling, ...loaded.tooling],
    api: [...base.api, ...loaded.api],
    agents: [...base.agents, ...loaded.agents], // the pack contributes the only agent
    extensions: [],
  };
  return { baseText, spec, importer: loaded.importer };
}

describe('a pack-only deployment (zero base agents) wires its pack agent through the REAL from-env factory', () => {
  it('the factory is created (not undefined) and its map covers every merged agent’s backend', async () => {
    const { baseText, spec } = await loadMergedDeployment();

    // THE FIX: the from-env factory is created even though the BASE spec declares zero agents (RED before
    // — the old `agents.length === 0` early-return returned undefined, so serve-opts injected no factory
    // and the composition-root call short-circuited).
    const factory = agentBackendsFactoryFromEnv(baseText, INERT_ENV);
    expect(factory).toBeTypeOf('function');

    // Faithful to composition-root: hand the factory the MERGED agents. It must build the pack agent's
    // backend (openai) from env — a REAL OpenAIAdapter (proves makeExtractionBackend ran, not a stub).
    const agentBackends = factory?.(spec.agents);
    expect(agentBackends?.get('openai')).toBeInstanceOf(OpenAIAdapter);
    // The invariant buildAgentRegistry requires (and would throw on): every merged agent's backend is
    // present in the map — so none falls through to the fail-OPEN 404.
    for (const agent of spec.agents) {
      expect(agentBackends?.has(agent.backend as BackendId)).toBe(true);
    }
  });

  it('buildAgentRegistry registers the pack agent from the factory map (the run surface would NOT 404)', async () => {
    const { baseText, spec, importer } = await loadMergedDeployment();
    const agentBackends = agentBackendsFactoryFromEnv(baseText, INERT_ENV)?.(spec.agents);
    if (!agentBackends) {
      throw new Error('factory did not produce backends for the pack-only deployment');
    }

    // Load the pack's tool handler via the SAME multi-root importer (boot path); no DB needed.
    const handlers = await loadHandlers(DEPLOYMENT_DIR, spec.handlers, importer);

    // The registry the run surface resolves against. buildAgentRegistry FAIL-CLOSES at boot if any
    // agent's backend is missing — that it succeeds proves the factory wired every backend.
    const registry = buildAgentRegistry({
      spec,
      agentBackends,
      handlers,
      productTables: new Map<string, PgTable>(), // captured lazily by the tool factory; unused at boot
    });

    // routes/runs.ts gates the run with `!deps.agentRegistry?.has(agentId)` → 404. The pack agent being
    // in the registry is exactly what makes that check pass (no fail-OPEN 404).
    expect(registry.has('note_summarizer')).toBe(true);
  });
});
