/**
 * a pack-contributed `agents` FRAGMENT is REGISTERED + RUNNABLE,
 * END-TO-END, DB-backed, through the REAL createAuthApp run surface (platform stays product-free).
 *
 * The ONE core change needed: an extension pack may declare its own OOTB agent (not just stores/
 * handlers/tooling/api). This proves a pack agent is INDISTINGUISHABLE from a deployment agent after
 * the `loadExtensions` merge — registered by the spec-built `buildAgentRegistry` and resolved + run by
 * the SAME `{agent}` run surface, with its `backend` resolved by the deployment's agentBackends and its
 * `tools[]` lint-resolved against the MERGED tooling. NOT pass-the-shape: the assertions
 * drive the actually-deployed thing + read ground truth, and the FAIL-THE-FIX arm proves the merge is
 * load-bearing (drop the `...loaded.agents` thread → the agent is missing from the registry → 404).
 *
 * The pack (`examples/agent-pack`) is loaded via the REAL `loadExtensions` (DIRECTORY-ONLY path-jailed;
 * version-pin fail-closed; pack-handler-jailed) + the multi-root importer — the EXACT mechanism a real
 * deployment uses. The pack carries a `notes` store, a `lookup_note` tool (+ its handler), and a
 * `note_summarizer` agent that references that tool. The platform names none of it.
 *
 * Skips when DATABASE_URL is absent.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendId } from '@rayspec/core';
import { forTenant, schema } from '@rayspec/db';
import { loadExtensions, loadHandlers, type ResolvedHandler } from '@rayspec/platform';
import { lintSpec, parseSpec, type RaySpec } from '@rayspec/spec';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeRunBackend } from '../test-support/fake-backend.js';
import { createHarness, type Harness, jsonRequest } from '../test-support/harness.js';

const hasDb = Boolean(process.env.DATABASE_URL);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the extension-pack agent merge end-to-end — it
// must never silently self-skip to a false green. When the DB is REQUIRED but absent, hard-fail here.
if (requireDb && !hasDb) {
  throw new Error(
    'extension-agents.db.test: DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}

const here = dirname(fileURLToPath(import.meta.url));
// packages/api-auth/src/engine -> repo-root/examples/agent-pack-deployment
const DEPLOYMENT_DIR = resolve(here, '../../../../../examples/agent-pack-deployment');
const YAML_PATH = resolve(DEPLOYMENT_DIR, 'rayspec.yaml');

/** The merged spec (deployment ⊕ pack fragments) + the multi-root-loaded pack handlers. */
interface Loaded {
  spec: RaySpec;
  handlers: ReadonlyMap<string, ResolvedHandler>;
}

/**
 * Load the deployment spec + merge the agent pack via the REAL `loadExtensions` (the composition-root
 * path, exercised in-test). `includeAgents` defaults true; the FAIL-THE-FIX arm passes false to drop
 * `...loaded.agents` from the merge (simulating the missing thread) and proves the registry then lacks
 * the pack agent (404 at the run surface). Everything else (store/tool/handler) merges identically, so
 * the ONLY difference is the agent thread — the mutation is surgical.
 */
async function loadAgentPack(includeAgents = true): Promise<Loaded> {
  const parsed = parseSpec(readFileSync(YAML_PATH, 'utf8'));
  if (!parsed.ok) throw new Error(`deployment spec invalid: ${JSON.stringify(parsed.errors)}`);
  const base = parsed.value;

  const loaded = await loadExtensions(base.extensions, {
    packsRoot: DEPLOYMENT_DIR,
    deploymentRoot: DEPLOYMENT_DIR,
  });

  const spec: RaySpec = {
    ...base,
    stores: [...base.stores, ...loaded.stores],
    handlers: [...base.handlers, ...loaded.handlers],
    tooling: [...base.tooling, ...loaded.tooling],
    api: [...base.api, ...loaded.api],
    // the load-bearing thread under test. Dropping it (the FAIL-THE-FIX arm) leaves the
    // merged spec with NO agent → buildAgentRegistry registers nothing → the {agent} run is 404.
    agents: includeAgents ? [...base.agents, ...loaded.agents] : [...base.agents],
    extensions: [],
  };

  const handlers = await loadHandlers(DEPLOYMENT_DIR, spec.handlers, loaded.importer);
  return { spec, handlers };
}

describe.skipIf(!hasDb)('pack `agents` fragment registered + runnable', () => {
  it('the pack agent + its tool + handler are present in the MERGED spec (loadExtensions thread)', async () => {
    const { spec } = await loadAgentPack();
    expect(spec.agents.map((a) => a.id)).toContain('note_summarizer');
    const agent = spec.agents.find((a) => a.id === 'note_summarizer');
    expect(agent?.backend).toBe('openai');
    expect(agent?.tools).toEqual(['lookup_note']);
    // The tool + its handler merged alongside, so the post-merge lint can resolve the agent's tool ref.
    expect(spec.tooling.map((t) => t.id)).toContain('lookup_note');
    expect(spec.handlers.map((h) => h.id)).toContain('lookup_note_handler');
  });

  it('the MERGED spec LINT-RESOLVES (the pack agent tool ref + capability resolve post-merge)', async () => {
    const { spec } = await loadAgentPack();
    // lintSpec resolves agents[].tools[] against the merged tooling[] + runs every agent through the
    // capability check (native-structured-output etc.). A pack agent referencing its pack tool must
    // resolve cleanly — zero violations (no dangling_ref, no capability_violation).
    expect(lintSpec(spec)).toEqual([]);
  });

  it('a pack agent referencing an UNDECLARED tool is a lint error (dangling_ref)', async () => {
    const { spec } = await loadAgentPack();
    // Mutate the merged spec so the pack agent points at a tool that is NOT in the merged tooling.
    const broken: RaySpec = {
      ...spec,
      agents: spec.agents.map((a) =>
        a.id === 'note_summarizer' ? { ...a, tools: ['no_such_tool'] } : a,
      ),
    };
    const errors = lintSpec(broken);
    expect(errors.some((e) => e.code === 'dangling_ref' && /no_such_tool/.test(e.message))).toBe(
      true,
    );
  });

  describe('END-TO-END through the REAL run surface', () => {
    let h: Harness;
    let backend: FakeRunBackend;
    const SCHEMA = 'rayspec_test_extension_agents';

    beforeAll(async () => {
      const { spec, handlers } = await loadAgentPack();
      backend = new FakeRunBackend();
      h = await createHarness({
        engineSpec: spec,
        engineHandlers: handlers,
        agentBackends: new Map<BackendId, FakeRunBackend>([['openai', backend]]),
        schema: SCHEMA,
      });
    });
    beforeEach(async () => {
      await h.reset();
      await backend.settle();
    });
    afterAll(async () => {
      await backend.settle();
      await h.close();
    });

    /** Register → org → switch → JWT (member role: store:read/write + agent:run). */
    async function principal(
      email: string,
      orgName: string,
    ): Promise<{ orgId: string; token: string }> {
      const reg = await jsonRequest(h.app, 'POST', '/v1/auth/register', {
        body: { email, password: 'a-long-enough-password' },
      });
      const t0 = (await reg.json()).accessToken as string;
      const orgId = (
        await (
          await jsonRequest(h.app, 'POST', '/v1/orgs', {
            body: { name: orgName },
            headers: { authorization: `Bearer ${t0}` },
          })
        ).json()
      ).id as string;
      const token = (
        await (
          await jsonRequest(h.app, 'POST', `/v1/orgs/${orgId}/switch`, {
            headers: { authorization: `Bearer ${t0}` },
          })
        ).json()
      ).accessToken as string;
      return { orgId, token };
    }

    it('the PACK AGENT runs through the {agent} run surface + journals through runAgent (registered)', async () => {
      const { orgId, token } = await principal('agent@example.com', 'AgentOrg');

      // The pack agent is resolvable on the SAME run surface a deployment agent uses — no special case.
      const run = await jsonRequest(h.app, 'POST', '/v1/agents/note_summarizer/runs', {
        body: { input: 'a note' },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(run.status).toBe(200);
      const body = (await run.json()) as { status: string; runId: string };
      expect(body.status).toBe('completed');
      // GROUND TRUTH: a `runs` header row exists for this tenant's run (journaled through runAgent) —
      // the pack agent ran through the EXACT same path as a deployment agent.
      const tdb = forTenant(h.db, orgId);
      const runs = (await tdb
        .select(schema.runs)
        .where(eq(schema.runs.runId, body.runId))) as Array<{ status: string }>;
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe('completed');
      // The FakeRunBackend's live path actually ran (the registry resolved the pack agent's backend).
      expect(backend.liveRuns).toBeGreaterThan(0);
    });

    it('FAIL-THE-FIX: drop the `...loaded.agents` merge thread → the pack agent is NOT registered (404)', async () => {
      // A SECOND harness whose merged spec OMITS the agents thread (the exact mutation that would land
      // if the loadExtensions/merge `agents` wiring were removed). Everything else (store/tool/handler)
      // is identical, so the ONLY cause of the 404 is the missing agent in the registry.
      const { spec, handlers } = await loadAgentPack(false);
      const noAgentBackend = new FakeRunBackend();
      const h2 = await createHarness({
        engineSpec: spec,
        engineHandlers: handlers,
        agentBackends: new Map<BackendId, FakeRunBackend>([['openai', noAgentBackend]]),
        schema: 'rayspec_test_extension_noagents',
      });
      try {
        const reg = await jsonRequest(h2.app, 'POST', '/v1/auth/register', {
          body: { email: 'noagent@example.com', password: 'a-long-enough-password' },
        });
        const t0 = (await reg.json()).accessToken as string;
        const orgId = (
          await (
            await jsonRequest(h2.app, 'POST', '/v1/orgs', {
              body: { name: 'NoAgentOrg' },
              headers: { authorization: `Bearer ${t0}` },
            })
          ).json()
        ).id as string;
        const token = (
          await (
            await jsonRequest(h2.app, 'POST', `/v1/orgs/${orgId}/switch`, {
              headers: { authorization: `Bearer ${t0}` },
            })
          ).json()
        ).accessToken as string;
        const run = await jsonRequest(h2.app, 'POST', '/v1/agents/note_summarizer/runs', {
          body: { input: 'a note' },
          headers: { authorization: `Bearer ${token}` },
        });
        // Without the merge thread the agent is absent from the registry → the run surface 404s it.
        expect(run.status).toBe(404);
        // The backend never ran (no agent resolved it).
        expect(noAgentBackend.liveRuns).toBe(0);
      } finally {
        await noAgentBackend.settle();
        await h2.close();
      }
    });
  });
});
