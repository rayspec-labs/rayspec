/**
 * The OPTIONAL product-backend factory seam — the product-profile sibling of the backend profile's
 * `AgentBackendsFactory`. Pure unit proofs (no DB, no DBOS, no network, and — the point of the whole
 * seam — NO provider credentials): a deployment that brokers its model calls through its own execution
 * boundary can hand the product boot every Backend, instead of the boot constructing the four
 * in-process adapters from ambient env credentials.
 *
 * The two halves this file exists to keep apart:
 *
 *  - THE SEAM (`bindProductBackends`): the survey that collects EVERY product-side model call the
 *    DEPLOYED document needs (extraction in `spec.extractors` order, then responder, then normalizer),
 *    the ONE factory call after sidecar + capability composition, and the four fail-closed checks on
 *    what comes back — key identity, completeness, no extras, and the Backend.id pin. A factory OWNS
 *    every requirement it is shown: there is DELIBERATELY no per-requirement fallback to the in-process
 *    construction, because a broker that forgets one requirement would otherwise get three calls
 *    brokered and one silently built against an ambient credential, with no signal.
 *  - THE OMISSION PATH: with no factory the builders keep their built-in env construction. The guards
 *    below pin the observable behavior that must stay byte-identical — the per-extractor abort ORDER,
 *    and the exact anthropic warning transcript `makeExtractionBackend` emits.
 *
 * The end-to-end journal/replay/structured-output parity of the two paths is measured against a real
 * database in product-backend-factory-parity.db.test.ts.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend, BackendId } from '@rayspec/core';
import type { Db } from '@rayspec/db';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindProductBackends,
  buildLiveAgent,
  buildRecordNormalizer,
  buildTurnResponder,
  type ProductAgentBackendsFactory,
  type ProductBackendContext,
  type ProductBackendSource,
} from './product-boot.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');
const DB = {} as Db; // the builders only close over it (never dereferenced here).

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function acmeSpec(): ProductSpec {
  const parsed = parseProductSpec(readFileSync(ACME_YAML, 'utf8'));
  if (!parsed.ok) throw new Error(`acme-notes.yaml must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

/** acmeSpec re-shaped to declare N extractors with the given ids (the extraction contract cloned). */
function specWithAgents(ids: string[]): ProductSpec {
  const base = acmeSpec();
  const proto = base.extractors[0];
  if (!proto) throw new Error('acme-notes must declare an extractor');
  return { ...base, extractors: ids.map((id) => ({ ...proto, id })) };
}

interface ExtractorFixture {
  id: string;
  backend?: string;
  model?: string;
  mode?: 'native' | 'validated';
  /** Declare the extractor but write NO sidecar config (the unreadable-config abort). */
  omitConfig?: boolean;
}

/**
 * Write a throwaway deployment dir carrying whichever sidecars a case needs and return the (unread)
 * spec path — the same `<specDir>/extraction|conversation|record/` layout the boot resolves against.
 */
function writeDeploymentDir(fx: {
  extractors?: ExtractorFixture[];
  responder?: { agentId: string; backend?: string; model?: string };
  normalizer?: { agentId: string; backend?: string; model?: string; mode?: 'native' | 'validated' };
}): string {
  const root = mkdtempSync(join(tmpdir(), 'product-backend-factory-'));
  dirs.push(root);
  if (fx.extractors) {
    const extractionDir = join(root, 'extraction');
    mkdirSync(extractionDir, { recursive: true });
    for (const e of fx.extractors) {
      if (e.omitConfig) continue;
      writeFileSync(join(extractionDir, `${e.id}.prompt.md`), `PROMPT for ${e.id}`);
      writeFileSync(join(extractionDir, `${e.id}.schema.json`), JSON.stringify({ type: 'object' }));
      writeFileSync(
        join(extractionDir, `${e.id}.extractor.json`),
        JSON.stringify({
          agent_id: e.id,
          backend: e.backend ?? 'openai',
          model: e.model ?? 'fixture-model',
          prompt_file: `${e.id}.prompt.md`,
          schema_file: `${e.id}.schema.json`,
          output_schema_name: `schema_${e.id}`,
          ...(e.mode ? { structured_output_mode: e.mode } : {}),
        }),
      );
    }
  }
  if (fx.responder) {
    const conversationDir = join(root, 'conversation');
    mkdirSync(conversationDir, { recursive: true });
    writeFileSync(
      join(conversationDir, `${fx.responder.agentId}.responder.json`),
      JSON.stringify({
        agent_id: fx.responder.agentId,
        instructions: 'Reply concisely to the last user turn.',
        model: fx.responder.model ?? 'fixture-reply-model',
        backend: fx.responder.backend ?? 'openai',
      }),
    );
  }
  if (fx.normalizer) {
    const recordDir = join(root, 'record');
    mkdirSync(recordDir, { recursive: true });
    writeFileSync(
      join(recordDir, `${fx.normalizer.agentId}.normalizer.json`),
      JSON.stringify({
        agent_id: fx.normalizer.agentId,
        instructions: 'Normalize the submitted record.',
        model: fx.normalizer.model ?? 'fixture-normalize-model',
        backend: fx.normalizer.backend ?? 'openai',
        ...(fx.normalizer.mode ? { structured_output_mode: fx.normalizer.mode } : {}),
      }),
    );
  }
  return join(root, 'product.yaml');
}

/** A network-free stand-in for whatever a broker returns; only its `id` is read at boot. */
function fakeBackend(id: BackendId): Backend {
  return {
    id,
    async resolveAuth() {
      return 'api-key' as const;
    },
    async run() {
      throw new Error('the fixture Backend is never run in these unit cases');
    },
  } as unknown as Backend;
}

/** A factory that serves every requirement it is shown with a Backend reporting the declared id. */
const serveAll: ProductAgentBackendsFactory = (ctx) =>
  new Map(ctx.requirements.map((r) => [r, fakeBackend(r.backend)]));

describe('bindProductBackends — the factory CONSTRUCTS the product-side model calls', () => {
  it('a boot with ZERO provider credentials still builds the live agent (the whole point of the seam)', () => {
    const spec = specWithAgents(['note_extractor']);
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'note_extractor', backend: 'openai', model: 'fixture-model' }],
    });
    const env = { RAYSPEC_EXTRACTION_MODE: 'live' };

    // CONTROL — the credential really IS absent: the omission path fails exactly as it does at HEAD.
    // Without this half a stub that accepted a 4th argument and ignored it would read green.
    expect(() => buildLiveAgent(env, specPath, spec)).toThrow(
      /extractor 'note_extractor': .*OPENAI_API_KEY is required/,
    );

    // SEAM — the source hands back the EXACT instance the factory returned, at the interface the
    // builder calls, and the builder then completes with no credential anywhere in env.
    const brokered = fakeBackend('openai');
    const src = bindProductBackends((ctx) => new Map(ctx.requirements.map((r) => [r, brokered])), {
      env,
      specPath,
      spec,
      withConversationInput: false,
    });
    expect(src.backendFor('extraction', 'note_extractor', 'openai', 'fixture-model')).toBe(
      brokered,
    );
    const live = buildLiveAgent(env, specPath, spec, src);
    expect(live.agentIds).toContain('note_extractor');
  });

  it('is called EXACTLY once, with EVERY model call the document needs, in boot order', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeDeploymentDir({
      extractors: [
        { id: 'agent_one', backend: 'openai', model: 'm-one' },
        { id: 'agent_two', backend: 'anthropic', model: 'm-two' },
      ],
      responder: { agentId: 'support_responder', backend: 'pi', model: 'm-reply' },
      normalizer: { agentId: 'field_normalizer', backend: 'codex', model: 'm-norm' },
    });
    const env = {
      RAYSPEC_EXTRACTION_MODE: 'live',
      RAYSPEC_RESPONDER_MODE: 'live',
      RAYSPEC_NORMALIZE_MODE: 'live',
    };
    const seen: ProductBackendContext[] = [];
    bindProductBackends(
      (ctx) => {
        seen.push(ctx);
        return serveAll(ctx);
      },
      {
        env,
        specPath,
        spec,
        withConversationInput: true,
        normalizeAgentId: 'field_normalizer',
      },
    );
    // ONE call — a per-site lazy factory would show 3+ calls, each carrying one requirement.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.productId).toBe(spec.product.id);
    expect(seen[0]?.requirements).toEqual([
      { kind: 'extraction', agentId: 'agent_one', backend: 'openai', model: 'm-one' },
      { kind: 'extraction', agentId: 'agent_two', backend: 'anthropic', model: 'm-two' },
      { kind: 'responder', agentId: 'support_responder', backend: 'pi', model: 'm-reply' },
      { kind: 'normalizer', agentId: 'field_normalizer', backend: 'codex', model: 'm-norm' },
    ]);
  });

  it('is NOT shown what the deployed document does not declare (no conversation, no input_normalize)', () => {
    const spec = specWithAgents(['agent_one']);
    // The sidecars are ON DISK; what gates the survey is what the DOCUMENT declares, never what a
    // directory happens to contain — a stale conversation/ dir must not conjure a responder call.
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'agent_one', backend: 'openai', model: 'm-one' }],
      responder: { agentId: 'support_responder' },
      normalizer: { agentId: 'field_normalizer' },
    });
    const seen: ProductBackendContext[] = [];
    bindProductBackends(
      (ctx) => {
        seen.push(ctx);
        return serveAll(ctx);
      },
      {
        env: {
          RAYSPEC_EXTRACTION_MODE: 'live',
          RAYSPEC_RESPONDER_MODE: 'live',
          RAYSPEC_NORMALIZE_MODE: 'live',
        },
        specPath,
        spec,
        withConversationInput: false,
      },
    );
    expect(seen[0]?.requirements).toEqual([
      { kind: 'extraction', agentId: 'agent_one', backend: 'openai', model: 'm-one' },
    ]);
  });

  it('a DETERMINISTIC executor mode keeps its kind out of the survey (that Backend is embedder-supplied)', () => {
    const spec = specWithAgents(['agent_one']);
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'agent_one', backend: 'openai', model: 'm-one' }],
      responder: { agentId: 'support_responder', backend: 'openai', model: 'm-reply' },
    });
    const seen: ProductBackendContext[] = [];
    bindProductBackends(
      (ctx) => {
        seen.push(ctx);
        return serveAll(ctx);
      },
      {
        env: { RAYSPEC_EXTRACTION_MODE: 'live', RAYSPEC_RESPONDER_MODE: 'deterministic' },
        specPath,
        spec,
        withConversationInput: true,
      },
    );
    // The deterministic seam owns that Backend, so the factory is never asked for one it could not win.
    expect(seen[0]?.requirements.map((r) => r.kind)).toEqual(['extraction']);
  });
});

describe('bindProductBackends — the fail-closed checks on what the factory returns', () => {
  it('PINS Backend.id to the sidecar-declared backend (journal attribution + the capability gates key on it)', () => {
    const spec = specWithAgents(['note_extractor']);
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'note_extractor', backend: 'pi', model: 'm', mode: 'validated' }],
    });
    // A relabelled Backend would silently stop the fork-4 native-structured-output gate from firing
    // for this agent AND make the journal's `backend` column lie — so it aborts the boot instead.
    expect(() =>
      bindProductBackends(
        (ctx) => new Map(ctx.requirements.map((r) => [r, fakeBackend('openai')])),
        {
          env: { RAYSPEC_EXTRACTION_MODE: 'live' },
          specPath,
          spec,
          withConversationInput: false,
        },
      ),
    ).toThrow(
      /returned a Backend reporting id 'openai' for extraction 'note_extractor', whose config declares backend 'pi'/,
    );
  });

  it('a factory that OMITS one requirement aborts — there is no per-requirement fallback', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeDeploymentDir({
      extractors: [
        { id: 'agent_one', backend: 'openai', model: 'm-one' },
        { id: 'agent_two', backend: 'openai', model: 'm-two' },
      ],
    });
    // DELIBERATELY built WITH a usable OPENAI_API_KEY: an implementation that fell back to the
    // in-process construction for the missing requirement would boot GREEN here, brokering one call
    // and quietly building the other against the ambient credential. That is the hole the seam closes.
    expect(() =>
      bindProductBackends(
        (ctx) =>
          new Map(
            ctx.requirements
              .filter((r) => r.agentId === 'agent_one')
              .map((r) => [r, fakeBackend(r.backend)]),
          ),
        {
          env: { RAYSPEC_EXTRACTION_MODE: 'live', OPENAI_API_KEY: 'sk-usable-in-this-process' },
          specPath,
          spec,
          withConversationInput: false,
        },
      ),
    ).toThrow(
      /returned no Backend for extraction 'agent_two' \(declared backend 'openai', model 'm-two'\)/,
    );
  });

  it('a factory that CLONES the requirement objects aborts, naming the footgun', () => {
    const spec = specWithAgents(['note_extractor']);
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'note_extractor', backend: 'openai', model: 'm' }],
    });
    // The map is keyed by the OBJECTS the boot handed out — a guessable string key would let a
    // factory invent entries the boot never asked about, so a spread/clone must fail loudly.
    expect(() =>
      bindProductBackends(
        (ctx) => new Map(ctx.requirements.map((r) => [{ ...r }, fakeBackend(r.backend)])),
        {
          env: { RAYSPEC_EXTRACTION_MODE: 'live' },
          specPath,
          spec,
          withConversationInput: false,
        },
      ),
    ).toThrow(/a spread\/clone loses identity — use the requirement objects exactly as given/);
  });

  it('refuses a call the survey never saw, rather than serving some other requirement’s Backend', () => {
    const spec = specWithAgents(['note_extractor']);
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'note_extractor', backend: 'openai', model: 'm' }],
    });
    const source = bindProductBackends(
      (ctx) => new Map(ctx.requirements.map((r) => [r, fakeBackend(r.backend)])),
      { env: { RAYSPEC_EXTRACTION_MODE: 'live' }, specPath, spec, withConversationInput: false },
    );
    // The sealed map is keyed by kind+agentId, so a lookup miss means the survey and the builder
    // disagree about which model calls this document needs. Refusing is the only honest answer: the
    // alternative — returning any Backend that happens to be in the map — would run this call on a
    // credential brokered for a DIFFERENT agent.
    expect(() => source.backendFor('extraction', 'never_surveyed', 'openai', 'm')).toThrow(
      /was not shown extraction 'never_surveyed' \(declared backend 'openai', model 'm'\)/,
    );
  });

  it('refuses when the sidecar changed between the survey and the build (same agent, new model)', () => {
    const spec = specWithAgents(['note_extractor']);
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'note_extractor', backend: 'openai', model: 'surveyed-model' }],
    });
    const source = bindProductBackends(
      (ctx) => new Map(ctx.requirements.map((r) => [r, fakeBackend(r.backend)])),
      { env: { RAYSPEC_EXTRACTION_MODE: 'live' }, specPath, spec, withConversationInput: false },
    );
    // The survey and the builder read the same sidecar at different moments. An edit in between would
    // otherwise hand the run a Backend the deployment brokered for a configuration the boot is no
    // longer using — the model the factory was asked about is not the model that would run.
    expect(() =>
      source.backendFor('extraction', 'note_extractor', 'openai', 'edited-model'),
    ).toThrow(
      /config changed between the factory survey \(backend 'openai', model 'surveyed-model'\) and the boot \(backend 'openai', model 'edited-model'\)/,
    );
  });

  it('an UNWIRED extractor sidecar reads CHARACTER-IDENTICALLY with and without a factory', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeDeploymentDir({
      extractors: [
        { id: 'agent_one', backend: 'openai', model: 'm-one' },
        { id: 'agent_two', backend: 'gemini', model: 'm-two' },
      ],
    });
    const env = { RAYSPEC_EXTRACTION_MODE: 'live', OPENAI_API_KEY: 'sk-x' };
    // The extractor path (unlike the responder/normalizer resolvers) does NOT validate the backend id
    // at resolve, so the survey EXCLUDES an unwired one and `backendFor` re-issues the unchanged
    // message before it ever consults the sealed map. A lookup-first implementation would mask it.
    const src = bindProductBackends(serveAll, {
      env,
      specPath,
      spec,
      withConversationInput: false,
    });
    const withFactory = (() => {
      try {
        buildLiveAgent(env, specPath, spec, src);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    const withoutFactory = (() => {
      try {
        buildLiveAgent(env, specPath, spec);
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(withFactory).toBe(withoutFactory);
    expect(withFactory).toContain("extractor 'agent_two'");
    expect(withFactory).toContain(
      "extraction backend 'gemini' is not wired in this boot (wired: openai | anthropic | pi | codex). Fail-closed.",
    );
  });
});

describe('the OMISSION path stays byte-identical', () => {
  it('keeps the per-extractor abort ORDER: agent_one’s missing credential precedes agent_two’s unreadable config', () => {
    const spec = specWithAgents(['agent_one', 'agent_two']);
    const specPath = writeDeploymentDir({
      extractors: [
        { id: 'agent_one', backend: 'openai' },
        { id: 'agent_two', omitConfig: true },
      ],
    });
    const env = { RAYSPEC_EXTRACTION_MODE: 'live' };
    // GREEN at HEAD by design — this is the omission guard. It goes RED against any refactor that
    // hoists sidecar resolution out of the loop or splits it into resolve-all-then-construct-all,
    // because that reverses which extractor aborts first.
    expect(() => buildLiveAgent(env, specPath, spec)).toThrow(
      /extractor 'agent_one': .*OPENAI_API_KEY is required/,
    );
    expect(() => buildLiveAgent(env, specPath, spec)).not.toThrow(/agent_two/);
  });

  it('emits the anthropic warning transcript unchanged (billing override, reuse-login banner, shadow)', () => {
    const spec = specWithAgents(['note_extractor']);
    const specPath = writeDeploymentDir({
      extractors: [{ id: 'note_extractor', backend: 'anthropic', model: 'm' }],
    });
    const base = {
      RAYSPEC_EXTRACTION_MODE: 'live',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: 'key',
      RAYSPEC_ANTHROPIC_CONFIG_ROOT: '/tmp/anthro',
    };
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The default source emits NOTHING of its own — every warning still comes from inside
      // `makeExtractionBackend`, in the same order, at the same point in the per-extractor loop.
      buildLiveAgent(base, specPath, spec);
      expect(spy.mock.calls.map((c) => String(c[0]))).toHaveLength(1);
      expect(String(spy.mock.calls[0]?.[0])).toMatch(/OVERRIDDEN & BILLED/);

      spy.mockClear();
      buildLiveAgent({ ...base, RAYSPEC_ANTHROPIC_REUSE_LOGIN: 'true' }, specPath, spec);
      const msgs = spy.mock.calls.map((c) => String(c[0]));
      expect(msgs).toHaveLength(3);
      expect(msgs[0]).toMatch(/OVERRIDDEN & BILLED/);
      expect(msgs[1]).toMatch(/REUSE-LOGIN ACTIVE/);
      expect(msgs[2]).toMatch(/REUSE-LOGIN INTENT WILL BE SHADOWED/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the deterministic executor seams keep their exact meaning', () => {
  it('a deterministic responder wins STRUCTURALLY: the source is never consulted', () => {
    const specPath = writeDeploymentDir({
      responder: { agentId: 'support_responder', backend: 'openai', model: 'm-reply' },
    });
    const spec = { product: { id: 'p' }, extractors: [] } as unknown as ProductSpec;
    const env = { RAYSPEC_RESPONDER_MODE: 'deterministic' };
    const injected = fakeBackend('openai');
    const src = bindProductBackends(serveAll, {
      env,
      specPath,
      spec,
      withConversationInput: true,
    });
    let consulted = 0;
    const counted: ProductBackendSource = {
      backendFor(kind, agentId, backend, model) {
        consulted += 1;
        return src.backendFor(kind, agentId, backend, model);
      },
    };
    const factory = buildTurnResponder(
      env,
      specPath,
      spec,
      DB,
      {
        deterministicResponderBackend: injected,
      },
      counted,
    );
    // The swap lives inside the `mode === 'live'` arm only, so the deterministic Backend still wins
    // with zero new code. Hoisting the seam above the mode dispatch would consult the source here —
    // and, because the survey excluded the responder, the sealed source would abort the boot.
    expect(factory('tenant-x').agentId).toBe('support_responder');
    expect(consulted).toBe(0);
  });

  it('a deterministic normalizer wins STRUCTURALLY: the source is never consulted', () => {
    const specPath = writeDeploymentDir({
      normalizer: { agentId: 'field_normalizer', backend: 'openai', model: 'm-norm' },
    });
    const spec = {
      product: { id: 'p' },
      extractors: [],
      contracts: { 'intake.normalized': { type: 'object' } },
    } as unknown as ProductSpec;
    const env = { RAYSPEC_NORMALIZE_MODE: 'deterministic' };
    const src = bindProductBackends(serveAll, {
      env,
      specPath,
      spec,
      withConversationInput: false,
      normalizeAgentId: 'field_normalizer',
    });
    let consulted = 0;
    const counted: ProductBackendSource = {
      backendFor(kind, agentId, backend, model) {
        consulted += 1;
        return src.backendFor(kind, agentId, backend, model);
      },
    };
    const normalizer = buildRecordNormalizer(
      env,
      specPath,
      spec,
      DB,
      { deterministicNormalizerBackend: fakeBackend('openai') },
      { agent: 'field_normalizer', output_contract: 'intake.normalized' },
      counted,
    );
    expect(normalizer('tenant-x').agentId).toBe('field_normalizer');
    expect(consulted).toBe(0);
  });
});
