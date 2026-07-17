/**
 * `composeProductDeploy` — the PARTIAL-UNLOCK HONESTY proofs (fail-closed, section named) + the
 * healthy composition shape, over the REAL parser output (a product-neutral fixture — the composition is
 * declaration-driven, not product-shaped). Each rejection case is a one-mutation red: the exact
 * behavior deploy() relies on ("everything NOT wired rejects the doc naming the section").
 */

import { InMemoryAgentHandlerRegistry } from '@rayspec/agent-runtime';
import { type AudioBlobContext, err, ok, resolveConfig } from '@rayspec/audio-runtime';
import type { TenantDb } from '@rayspec/db';
import type { ProductSpec, TriggerEventDescriptor } from '@rayspec/spec';
import { FAKE_STT_ADAPTER_ID, FakeSttAdapter } from '@rayspec/stt-port';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeProductDeploy, makeFailSoftMediaPrep, type ProductYamlRollout } from './compose.js';
import { deriveProductStores } from './derive-stores.js';
import { ProductComposeError } from './errors.js';
import { mountedTriggerEventDescriptors } from './event-vocabulary.js';
import { STT_INCOMPLETE_WAIT_MS } from './nodes.js';
import {
  FIELDLOG_YAML,
  fixtureStores,
  INTAKE_YAML,
  NOTETOOL_YAML,
  parseFixture,
  RecordingEnqueuer,
} from './test-support/fixture.js';

/**
 * A PARTIAL module mock over the event vocabulary — ONLY `mountedTriggerEventDescriptors` is
 * overridable, and only while a test sets `vocabularyMock.override` (undefined ⇒ the REAL
 * implementation, so every other describe block in this file runs the genuine vocabulary). This is
 * the revert-net for compose's WIRING: audio's real descriptor values coincide byte-for-byte with
 * the original hardcodes, so only a descriptor map the original hardcodes could NOT produce proves the
 * wiring actually SOURCES the registry.
 */
const vocabularyMock = vi.hoisted(() => ({
  override: undefined as undefined | (() => ReadonlyMap<string, unknown>),
}));
vi.mock('./event-vocabulary.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./event-vocabulary.js')>();
  return {
    ...actual,
    mountedTriggerEventDescriptors: (
      ...args: Parameters<typeof actual.mountedTriggerEventDescriptors>
    ) =>
      vocabularyMock.override
        ? vocabularyMock.override()
        : actual.mountedTriggerEventDescriptors(...args),
  };
});

const TENANT = '00000000-0000-0000-0000-0000000000d5';

function agentRegistry(): InMemoryAgentHandlerRegistry {
  const registry = new InMemoryAgentHandlerRegistry();
  registry.register('agent.note_extractor', () => []);
  return registry;
}

function rollout(overrides: Partial<ProductYamlRollout> = {}): ProductYamlRollout {
  return {
    tenantId: TENANT,
    enqueuer: new RecordingEnqueuer(),
    stores: fixtureStores(),
    artifactCollections: new Map([['note_artifacts', { store: 'note_artifacts' }]]),
    transcripts: { store: 'track_transcripts' },
    stt: { adapter: new FakeSttAdapter({ fixtures: [] }) },
    agents: agentRegistry(),
    ...overrides,
  };
}

/** The fieldlog rollout: NO stt/agents (the fixture uses neither); stores derived from the doc. */
function fieldlogRollout(overrides: Partial<ProductYamlRollout> = {}): ProductYamlRollout {
  const spec = parseFixture(FIELDLOG_YAML);
  const derived = deriveProductStores(spec, new Set(['audio_sessions', 'audio_tracks']));
  return {
    tenantId: TENANT,
    enqueuer: new RecordingEnqueuer(),
    stores: derived.stores,
    artifactCollections: derived.artifactCollections,
    ...overrides,
  };
}

function expectReject(
  yaml: string,
  cfg: ProductYamlRollout,
  step: 'unsupported_spec' | 'roll out',
  pattern: RegExp,
): void {
  let thrown: unknown;
  try {
    composeProductDeploy(parseFixture(yaml), cfg);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ProductComposeError);
  expect((thrown as ProductComposeError).step).toBe(step);
  expect((thrown as ProductComposeError).message).toMatch(pattern);
}

describe('composeProductDeploy — healthy composition', () => {
  it('composes the engine spec, workflows, handlers, trigger wiring, and node registry', () => {
    const composed = composeProductDeploy(parseFixture(), rollout());

    // Workflows compiled by the REAL bridge onto the canonical trigger event.
    expect([...composed.workflows.keys()]).toEqual(['process_recording']);
    const wf = composed.workflows.get('process_recording');
    expect(wf?.trigger.event).toBe('audio_input.finalized_session');
    expect(wf?.steps.map((s) => s.id)).toEqual([
      'transcribe',
      'extract',
      'ground',
      'validate',
      'persist',
    ]);
    expect(composed.triggerEvents).toEqual(['audio_input.finalized_session']);

    // Dual-track completeness plumbing: compose wires the transcribe step a retry policy with REAL
    // backoff so the node's completeness wait (a `retryable_failure`) actually re-invokes it — the
    // bridge compiler alone sets `max_attempts` but no `backoff_ms`, which would fire retries instantly
    // and defeat the wait. The retry WINDOW must exceed the node's completeness bound so the node
    // proceeds-with-whatever-sealed rather than exhausting into a fail-closed run failure.
    const transcribeStep = wf?.steps.find((s) => s.id === 'transcribe');
    expect(transcribeStep?.retry_policy?.backoff_ms ?? 0).toBeGreaterThan(0);
    const window =
      ((transcribeStep?.retry_policy?.max_attempts ?? 1) - 1) *
      (transcribeStep?.retry_policy?.backoff_ms ?? 0);
    expect(window).toBeGreaterThan(STT_INCOMPLETE_WAIT_MS);

    // The composed store read surface: audio capability stores + the deployment's product stores.
    const storeNames = composed.engineSpec.stores.map((s) => s.name);
    expect(storeNames).toContain('audio_sessions');
    expect(storeNames).toContain('audio_tracks');
    expect(storeNames).toContain('track_transcripts');
    expect(storeNames).toContain('note_artifacts');

    // ROUTE OWNERSHIP: the play-token route exists EXACTLY ONCE (the view owns it; the audio
    // capability's duplicate was dropped because the view DELEGATES to the same handler fn), and it
    // dispatches the view handler id.
    const playTokenRoutes = composed.engineSpec.api.filter(
      (r) => r.path === '/sessions/{session_id}/{track}/play-token' && r.method === 'POST',
    );
    expect(playTokenRoutes).toHaveLength(1);
    expect(playTokenRoutes[0]?.action).toEqual({
      kind: 'handler',
      handler: 'view_session_playback_token',
    });
    // The rest of the audio surface is intact (upload/status/finalize/playback-stream).
    const paths = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST /sessions/{session_id}/{track}/chunks/{chunk_index}');
    expect(paths).toContain('POST /sessions/{session_id}/{track}/finalize');
    expect(paths).toContain('GET /sessions/{session_id}/{track}/upload-status');
    expect(paths).toContain('GET /sessions/{session_id}/{track}/playback');

    // The merged handler map serves both mounts; the delegated view handler IS the capability fn.
    expect(composed.handlers.get('view_session_playback_token')?.fn).toBe(
      composed.handlers.get('media_playback_token')?.fn,
    );

    // The node registry wires EVERY compiled operation (fail-closed cross-checked in compose).
    const registry = composed.buildNodeRegistry({
      tdb: {} as TenantDb, // makeHandlerDb is lazy — construction touches nothing
      productTables: new Map(),
      tenantId: TENANT,
    });
    expect(registry.ids()).toEqual([
      'agent.note_extractor',
      'artifact.persist',
      'artifact.read',
      'grounding.check',
      // DELIBERATE: the declared-store step runtime is wired unconditionally
      // (spec-driven, fail-closed; a doc without store steps never dispatches these ops).
      'store.read',
      'store.write',
      'stt.transcribe_session',
      'validation.check',
    ]);
  });

  it('narrows the audio capability tracks to the DECLARED attribution vocabulary', async () => {
    // The fixture declares grounding.attribution_policy.tracks { mic, system } — the composed audio
    // capability must accept EXACTLY those lanes (the frozen legacy behavior), NOT the neutral
    // default id shape. Regression shape: with the default policy an accepted junk track becomes a
    // sealed track that poisons the session's single-flight durable run (stt fails terminally).
    const composed = composeProductDeploy(parseFixture(), rollout());
    const uploadStatus = composed.handlers.get('audio_input_upload_status');
    expect(uploadStatus).toBeTruthy();
    const init = {
      tenantId: TENANT,
      db: { select: async () => [] },
      params: { session_id: 's1', track: 'other' },
    };
    // Undeclared track → the capability's 400 envelope (never a row read).
    const rejected = (await uploadStatus?.fn(init as never)) as {
      status?: number;
      body?: { error?: string };
    };
    expect(rejected.status).toBe(400);
    expect(rejected.body?.error).toBe('bad_request');
    // A DECLARED track → the normal absent-shape 200 body (plain return).
    const accepted = (await uploadStatus?.fn({
      ...init,
      params: { session_id: 's1', track: 'mic' },
    } as never)) as Record<string, unknown>;
    expect(accepted.status).toBe('absent');
    expect(accepted.next_expected_index).toBe(0);
    // An EXPLICIT rollout override still wins over the declaration.
    const overridden = composeProductDeploy(
      parseFixture(),
      rollout({ audio: { capability: { allowedTracks: ['lane_x'] } } }),
    );
    const overriddenStatus = (await overridden.handlers
      .get('audio_input_upload_status')
      ?.fn({ ...init, params: { session_id: 's1', track: 'mic' } } as never)) as {
      status?: number;
    };
    expect(overriddenStatus.status).toBe(400);
  });

  it('threads the deployer STT adapter + enqueuer (no hidden instances)', () => {
    const enqueuer = new RecordingEnqueuer();
    const adapter = new FakeSttAdapter({ fixtures: [] });
    const composed = composeProductDeploy(parseFixture(), rollout({ enqueuer, stt: { adapter } }));
    expect(adapter.id).toBe(FAKE_STT_ADAPTER_ID);
    expect(composed.viewRoutes).toEqual(['POST /sessions/{session_id}/{track}/play-token']);
  });
});

describe('composeProductDeploy — declared stores + store steps (healthy)', () => {
  it('composes the fieldlog fixture: store steps compile onto store.read/store.write, the declared stores join the read surface, the store-sourced view mounts', () => {
    const composed = composeProductDeploy(parseFixture(FIELDLOG_YAML), fieldlogRollout());

    // The bridge compiled the two store steps onto the neutral capability/operation dispatch shape.
    const wf = composed.workflows.get('log_session');
    expect(wf?.steps.map((st) => `${st.capability}.${st.operation}`)).toEqual([
      'store.read',
      'store.write',
    ]);
    expect(wf?.trigger.event).toBe('audio_input.finalized_session');

    // The DECLARED stores are in the composed read surface (audio stores + derived declared stores).
    const storeNames = composed.engineSpec.stores.map((st) => st.name);
    expect(storeNames).toContain('equipment_catalog');
    expect(storeNames).toContain('session_log');

    // The store-sourced view over the DECLARED store mounted (the views path).
    expect(composed.viewRoutes).toEqual(['GET /field-sessions/{session_id}/log']);

    // The registry wires the two store nodes (the registeredOps cross-check passed by construction).
    const registry = composed.buildNodeRegistry({
      tdb: {} as TenantDb,
      productTables: new Map(),
      tenantId: TENANT,
    });
    expect(registry.has('store.read')).toBe(true);
    expect(registry.has('store.write')).toBe(true);
  });
});

describe('composeProductDeploy — partial-unlock honesty (fail-closed, section named)', () => {
  it('rejects a capability OUTSIDE the wired set, naming it', () => {
    const yaml = NOTETOOL_YAML.replace(
      'requires:\n  capabilities: [audio_input, media_playback, stt, grounding, validation, artifact]',
      'requires:\n  capabilities: [audio_input, media_playback, stt, grounding, validation, artifact, knowledge_base]',
    )
      .replace('artifacts:\n  - kind: digest', 'capabilities__KB__\nartifacts:\n  - kind: digest')
      .replace(
        'capabilities__KB__',
        '  - id: knowledge_base\n    tier: B\n    status: available\n    contracts: [knowledge_base.query]',
      );
    expectReject(yaml, rollout(), 'unsupported_spec', /capability 'knowledge_base' has no wired/);
  });

  it("rejects a capability that is not status 'available' on a MOUNT, naming it", () => {
    const yaml = NOTETOOL_YAML.replace(
      '  - id: stt\n    tier: B\n    status: available',
      '  - id: stt\n    tier: B\n    status: reserved',
    );
    expectReject(yaml, rollout(), 'unsupported_spec', /capability 'stt' is declared 'reserved'/);
  });

  it('a CODE-BUILT spec whose store step targets an undeclared store is rejected at compose (the shared checker re-run)', () => {
    // The parser/lint reject this at doc level; compose re-runs the SHARED checkProductStores as
    // defense-in-depth for a code-built spec that bypassed the parser — mutate post-parse.
    const spec = parseFixture(FIELDLOG_YAML);
    const wf = spec.workflows[0];
    if (!wf) throw new Error('fixture workflow missing');
    const mutated = {
      ...spec,
      workflows: [
        {
          ...wf,
          steps: wf.steps.map((s) => (s.id === 'catalog' ? { ...s, store: 'ghost_store' } : s)),
        },
      ],
    };
    let thrown: unknown;
    try {
      composeProductDeploy(mutated, fieldlogRollout());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('unsupported_spec');
    expect((thrown as ProductComposeError).message).toMatch(/ghost_store/);
  });

  it('a CODE-BUILT spec whose write values name a column outside the store contract is rejected at compose', () => {
    const spec = parseFixture(FIELDLOG_YAML);
    const wf = spec.workflows[0];
    if (!wf) throw new Error('fixture workflow missing');
    const mutated = {
      ...spec,
      workflows: [
        {
          ...wf,
          steps: wf.steps.map((s) =>
            s.id === 'log'
              ? { ...s, values: { ...s.values, ghost_col: { const: 'x' as const } } }
              : s,
          ),
        },
      ],
    };
    let thrown: unknown;
    try {
      composeProductDeploy(mutated, fieldlogRollout());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('unsupported_spec');
    expect((thrown as ProductComposeError).message).toMatch(/ghost_col/);
  });

  it('a declared store SHADOWING a capability-owned (audio) store is rejected by the compose re-run BEFORE derive/rollout — naming the collision', () => {
    // The doc-level parse CANNOT catch this (spec has no runtime store names — the parser passes no
    // capability set), so it parses clean; compose passes the REAL wired set (AUDIO_STORE_NAMES) to
    // the shared checker and must reject at 'unsupported_spec' — NOT stumble later into a confusing
    // rollout-contract error (the pre-fix behavior) and NOT depend on deriveProductStores (which a
    // hand-built rollout bypasses entirely).
    const yaml = FIELDLOG_YAML.replace(
      'stores:\n  - name: equipment_catalog',
      'stores:\n  - name: audio_sessions\n    columns:\n      - { name: shadow_ref, type: text }\n    key: [shadow_ref]\n  - name: equipment_catalog',
    );
    expectReject(yaml, fieldlogRollout(), 'unsupported_spec', /audio_sessions.*capability-owned/s);
  });

  it('a rollout.stores entry corresponding to NO declared/collection/transcript/audio store is rejected, naming the stray (roll out)', () => {
    // A stray rollout store would otherwise MATERIALIZE as a real table nothing declared — accepted
    // silently pre-fix. Fail-closed: every composed store must be inside the known union.
    const spec = parseFixture(FIELDLOG_YAML);
    const derived = deriveProductStores(spec, new Set(['audio_sessions', 'audio_tracks']));
    const stray = {
      name: 'stray_ledger',
      columns: [{ name: 'ref', type: 'text' as const, nullable: false, unique: true }],
      foreignKeys: [],
    };
    let thrown: unknown;
    try {
      composeProductDeploy(spec, fieldlogRollout({ stores: [...derived.stores, stray] }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('roll out');
    expect((thrown as ProductComposeError).message).toMatch(/stray_ledger/);
  });

  it('a rollout whose stores OMIT a declared store is rejected at compose, naming it (roll out)', () => {
    const spec = parseFixture(FIELDLOG_YAML);
    const derived = deriveProductStores(spec, new Set(['audio_sessions', 'audio_tracks']));
    const withoutCatalog = derived.stores.filter((s) => s.name !== 'equipment_catalog');
    let thrown: unknown;
    try {
      composeProductDeploy(spec, fieldlogRollout({ stores: withoutCatalog }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('roll out');
    expect((thrown as ProductComposeError).message).toMatch(
      /declared store 'equipment_catalog'.*not among the deployment's declared stores/,
    );
  });

  it('rejects an unwired grounding policy value, naming it', () => {
    const yaml = NOTETOOL_YAML.replace('on_invalid_citation: prune', 'on_invalid_citation: repair');
    expectReject(yaml, rollout(), 'unsupported_spec', /on_invalid_citation 'repair'/);
    const yaml2 = NOTETOOL_YAML.replace('on_empty_evidence: drop', 'on_empty_evidence: keep');
    expectReject(yaml2, rollout(), 'unsupported_spec', /on_empty_evidence 'keep'/);
  });

  it('rejects a grounding.check workflow without a declared grounding policy', () => {
    const yaml = NOTETOOL_YAML.replace(
      /grounding:\n {2}require_source_spans[\s\S]*?system: remote\n/,
      '',
    );
    expectReject(yaml, rollout(), 'unsupported_spec', /declares no grounding policy/);
  });

  it('rejects an undeliverable attribution role, naming track + role', () => {
    const yaml = NOTETOOL_YAML.replace('mic: local', 'mic: narrator');
    expectReject(yaml, rollout(), 'unsupported_spec', /tracks\['mic'\] = 'narrator'/);
  });

  it('rejects a declared stt.* step when the deployment supplies no adapter / no transcript sink', () => {
    expectReject(NOTETOOL_YAML, rollout({ stt: undefined }), 'unsupported_spec', /no STT adapter/);
    expectReject(
      NOTETOOL_YAML,
      rollout({ transcripts: undefined }),
      'unsupported_spec',
      /no transcript store binding/,
    );
  });

  it('rejects a declared extractor without a registered extraction executor, naming it', () => {
    expectReject(
      NOTETOOL_YAML,
      rollout({ agents: new InMemoryAgentHandlerRegistry() }),
      'unsupported_spec',
      /extractor 'note_extractor' has no registered extraction executor/,
    );
    expectReject(
      NOTETOOL_YAML,
      rollout({ agents: undefined }),
      'unsupported_spec',
      /extractors\[\]/,
    );
  });

  it('rejects a persist scope the TRIGGER payload contract cannot satisfy, naming artifact + scope + trigger', () => {
    // Declare scope 'project' on BOTH artifact kinds (artifact-level 4-space indent only — the
    // workflow trigger's own `scope: session` is 6-space and untouched)…
    const yaml = NOTETOOL_YAML.replaceAll('\n    scope: session', '\n    scope: project');
    // …and bind a store that DOES declare the 'project_id' scope column, so the store row-contract
    // check is satisfied: pre-fix this composed fully GREEN and every artifact.persist run would
    // have failed at runtime ('persist_scope_missing' — the trigger payload carries no project_id).
    const stores = fixtureStores().map((s) =>
      s.name === 'note_artifacts'
        ? {
            ...s,
            columns: s.columns.map((c) =>
              c.name === 'session_id' ? { ...c, name: 'project_id' } : c,
            ),
          }
        : s,
    );
    expectReject(
      yaml,
      rollout({ stores }),
      'unsupported_spec',
      /scope 'project'.*'audio_input\.finalized_session'.*'project_id'.*session_id, tenant_id, tracks, source_capability/s,
    );
  });

  it('rejects an unbound artifact collection, naming it', () => {
    expectReject(
      NOTETOOL_YAML,
      rollout({ artifactCollections: undefined }),
      'unsupported_spec',
      /collection 'note_artifacts' .* no bound store/,
    );
  });

  it('rejects a bound collection store missing a row-contract column (roll out)', () => {
    const stores = fixtureStores().map((s) =>
      s.name === 'note_artifacts'
        ? { ...s, columns: s.columns.filter((c) => c.name !== 'dismissed') }
        : s,
    );
    expectReject(
      NOTETOOL_YAML,
      rollout({ stores }),
      'roll out',
      /'note_artifacts' must declare column 'dismissed'/,
    );
  });

  it('rejects a capability-sourced view whose contract has no delegable handler, naming it', () => {
    const yaml = NOTETOOL_YAML.replace(
      'source:\n      kind: capability\n      ref: media_playback.token',
      'source:\n      kind: capability\n      ref: stt.transcript',
    );
    expectReject(
      yaml,
      rollout(),
      'unsupported_spec',
      /view 'session_playback_token' .* 'stt.transcript'.* no\s+delegable/s,
    );
  });

  it('rejects a basePath override that breaks the play-token route coincidence — never a silent second route', () => {
    // rollout.audio.basePath moves the audio capability's play-token route to
    // 'POST /media/{...}/play-token' while the delegated view still declares
    // 'POST /sessions/{...}/play-token'. Pre-fix the byte-equal route merge saw NO collision and
    // silently DOUBLE-EXPOSED the play-token surface (both routes mounted, same handler fn).
    expectReject(
      NOTETOOL_YAML,
      rollout({ audio: { basePath: '/media' } }),
      'roll out',
      /play-token route mismatch.*'POST \/sessions\/\{session_id\}\/\{track\}\/play-token'.*'POST \/media\/\{session_id\}\/\{track\}\/play-token'/s,
    );
  });

  it('a basePath override WITH a coinciding view route still composes (one play-token route)', () => {
    // The coincidence requirement rejects the MISMATCH, not the basePath feature itself: a view
    // declared at the overridden path composes fine and the route exists exactly once (view-owned).
    const yaml = NOTETOOL_YAML.replace(
      'path: "/sessions/{session_id}/{track}/play-token"',
      'path: "/media/{session_id}/{track}/play-token"',
    );
    const composed = composeProductDeploy(
      parseFixture(yaml),
      rollout({ audio: { basePath: '/media' } }),
    );
    const playTokenRoutes = composed.engineSpec.api.filter((r) => r.path.endsWith('/play-token'));
    expect(playTokenRoutes).toHaveLength(1);
    expect(playTokenRoutes[0]?.path).toBe('/media/{session_id}/{track}/play-token');
    expect(playTokenRoutes[0]?.action).toEqual({
      kind: 'handler',
      handler: 'view_session_playback_token',
    });
  });

  it('rejects a route collision with DIFFERENT owners (roll out)', () => {
    const yaml = NOTETOOL_YAML.replace(
      'route:\n      method: POST\n      path: "/sessions/{session_id}/{track}/play-token"',
      'route:\n      method: GET\n      path: "/sessions/{session_id}/{track}/upload-status"',
    );
    expectReject(yaml, rollout(), 'roll out', /route collision/);
  });
});

describe('composeProductDeploy — the trigger-event vocabulary', () => {
  it('builds the capability inventory events from the MOUNTED descriptors (no hardcode)', () => {
    const composed = composeProductDeploy(parseFixture(), rollout());
    // The dispatcher listens on EXACTLY the mounted capabilities' declared events — today the audio
    // descriptor, so the composed set is byte-identical to the original hardcode. Dropping a mounted
    // capability's descriptor breaks this (and the whole healthy-composition suite: the workflow's
    // trigger event would no longer compile against the inventory).
    expect(composed.triggerEvents).toEqual([...mountedTriggerEventDescriptors().keys()]);
    expect(composed.triggerEvents).toEqual(['audio_input.finalized_session']);
  });

  it('enqueues through the composed ingress with the EXACT byte-stable audio key (live run identity)', async () => {
    const enqueuer = new RecordingEnqueuer();
    const composed = composeProductDeploy(parseFixture(), rollout({ enqueuer }));
    const result = await composed.ingress.emit({
      id: 'tenant-a:sess-abc',
      type: 'audio_input.finalized_session',
      occurred_at: '2026-07-03T00:00:00.000Z',
      payload: {
        session_id: 'sess-abc',
        tenant_id: TENANT,
        tracks: [{ track: 'mic', committed_byte_len: 1 }],
        source_capability: 'audio_input',
      },
    });
    expect(result.enqueued).toHaveLength(1);
    expect(enqueuer.calls).toHaveLength(1);
    expect(enqueuer.calls[0]?.workflow.id).toBe('process_recording');
    expect(enqueuer.calls[0]?.tenantId).toBe(TENANT);
    // ★ THE LIVE RE-KEY GUARD: the live deployment's durable run ids derive from THIS string. Any format
    // drift re-keys live runs (a redelivered finalize would double-run). Byte-stable: the composed
    // trigger's EXPLICIT descriptor-derived key must be exactly `session_id:<id>:finalized`.
    expect(enqueuer.calls[0]?.idempotencyKey).toBe('session_id:sess-abc:finalized');
  });
});

describe('composeProductDeploy — the record_input capability (conditional mount + the generic key)', () => {
  /** The intake rollout: no stt/agents (the fixture uses neither); stores derived from the doc. */
  function intakeRollout(overrides: Partial<ProductYamlRollout> = {}): ProductYamlRollout {
    const spec = parseFixture(INTAKE_YAML);
    const derived = deriveProductStores(spec, new Set(['audio_sessions', 'audio_tracks']));
    return {
      tenantId: TENANT,
      enqueuer: new RecordingEnqueuer(),
      stores: derived.stores,
      artifactCollections: derived.artifactCollections,
      ...overrides,
    };
  }

  it('mounts the record capability WHEN DECLARED: store + submit route + handler + trigger event', () => {
    const composed = composeProductDeploy(parseFixture(INTAKE_YAML), intakeRollout());

    // The capability-owned store joins the composed read surface (engineSpec.stores).
    const storeNames = composed.engineSpec.stores.map((s) => s.name);
    expect(storeNames).toContain('record_submissions');
    expect(storeNames).toContain('intake_requests');

    // The ONE authenticated POST submit route is mounted; the view route rides alongside.
    const paths = composed.engineSpec.api.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST /records/{record_id}/submit');
    expect(composed.viewRoutes).toEqual(['GET /intake/{record_id}/status']);

    // The resolved handler map carries the capability handler (alongside the audio mount's).
    expect(composed.handlers.has('record_input_submit')).toBe(true);

    // The workflow compiled onto the canonical DEFAULT-join event; the dispatcher listens on it.
    expect(composed.workflows.get('log_request')?.trigger.event).toBe(
      'record_input.record_submitted',
    );
    expect(composed.triggerEvents).toEqual(['record_input.record_submitted']);
  });

  it('enqueues through the composed ingress with the CLEAN GENERIC key `record_id:<id>` (never the audio suffix)', async () => {
    const enqueuer = new RecordingEnqueuer();
    const composed = composeProductDeploy(parseFixture(INTAKE_YAML), intakeRollout({ enqueuer }));
    const result = await composed.ingress.emit({
      id: `${TENANT}:rec-1`,
      type: 'record_input.record_submitted',
      occurred_at: '2026-07-04T00:00:00.000Z',
      payload: {
        title: 'Fix the door',
        record_id: 'rec-1',
        tenant_id: TENANT,
        source_capability: 'record_input',
      },
    });
    expect(result.enqueued).toHaveLength(1);
    expect(enqueuer.calls[0]?.workflow.id).toBe('log_request');
    // ★ THE KEY PIN: the record event derives the generic `<field>:<value>` format — the
    // legacy ':finalized' suffix is audio-only (its own pin above stays byte-identical).
    expect(enqueuer.calls[0]?.idempotencyKey).toBe('record_id:rec-1');
  });

  it('does NOT mount the record surface when the doc does not declare record_input (the conditional)', () => {
    const composed = composeProductDeploy(parseFixture(), rollout());
    expect(composed.engineSpec.stores.map((s) => s.name)).not.toContain('record_submissions');
    expect(composed.engineSpec.api.map((r) => `${r.method} ${r.path}`)).not.toContain(
      'POST /records/{record_id}/submit',
    );
    expect(composed.handlers.has('record_input_submit')).toBe(false);
    expect(composed.triggerEvents).toEqual(['audio_input.finalized_session']);
  });

  it('the persist-scope check through the COMPOSE call site: a persisting workflow on the record event with a scope outside ITS payload keys is rejected naming the RECORD contract', () => {
    // The intake doc, evolved to persist an artifact with scope 'session' — satisfiable by the
    // AUDIO event's payload but NOT by the record event's (no 'session_id' among its keys). A
    // union-across-events (or an audio-hardcoded persist-scope argument) would compose this GREEN; the
    // per-event registry rejects it naming the record event's OWN payload keys.
    const yaml = INTAKE_YAML.replace(
      'contracts:\n  intake.request_row:',
      'contracts:\n  intake.note:\n    type: object\n  intake.request_row:',
    )
      .replace(
        `capabilities:
  - id: record_input
    tier: B
    status: available
    contracts: [record_input.record_submitted]`,
        `capabilities:
  - id: record_input
    tier: B
    status: available
    contracts: [record_input.record_submitted]
  - id: artifact
    tier: B
    status: available
    contracts: [artifact.persist, artifact.handle]
artifacts:
  - kind: note
    contract: intake.note
    scope: session
    collection: note_rows
    lifecycle:
      persist: true`,
      )
      .replace(
        `        outputs:
          row: intake.request_row`,
        `        outputs:
          row: intake.request_row
      - id: fetch
        type: store_read
        use: store.read
        store: intake_requests
        filter:
          record_id: { event: record_id }
        outputs:
          note: intake.note
      - id: persist
        type: artifact_persist
        use: artifact.persist
        depends_on: [fetch]
        inputs:
          note: intake.note
        outputs:
          handle: artifact.handle`,
      );
    const spec = parseFixture(yaml);
    const derived = deriveProductStores(spec, new Set(['audio_sessions', 'audio_tracks']));
    let thrown: unknown;
    try {
      composeProductDeploy(
        spec,
        intakeRollout({ stores: derived.stores, artifactCollections: derived.artifactCollections }),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect((thrown as ProductComposeError).step).toBe('unsupported_spec');
    // The message names the RECORD event and ITS OWN payload keys — proof compose passed the
    // registry (audio + record) descriptors to the persist-scope check, not a hardcoded audio contract.
    expect((thrown as ProductComposeError).message).toMatch(
      /scope 'session'.*'record_input\.record_submitted'.*'session_id'.*record_id, tenant_id, source_capability/s,
    );
  });

  it('through compose: a DECLARED store shadowing the record capability store is rejected when the capability is declared', () => {
    const yaml = INTAKE_YAML.replace(
      `stores:
  - name: intake_requests`,
      `stores:
  - name: record_submissions
    columns:
      - { name: some_col, type: text }
    key: [some_col]
  - name: intake_requests`,
    );
    let thrown: unknown;
    try {
      // Parse-level lint cannot know the mounted capability stores; compose passes them.
      // Bypass the parser's own store lint by parsing the doc as-is (the shadow name is
      // lint-legal at parse time) and let compose's checkProductStores(…, capability names) fire.
      const spec = parseFixture(yaml);
      composeProductDeploy(spec, intakeRollout());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ProductComposeError);
    expect(String((thrown as ProductComposeError).message)).toMatch(/record_submissions/);
  });
});

describe('composeProductDeploy — the wiring SOURCES the vocabulary (revert-nets, mocked registry)', () => {
  // Audio's descriptor values coincide byte-for-byte with the original hardcodes (that coincidence is
  // deliberate — live run identity), so no real-vocabulary test can distinguish "compose reads the
  // registry" from "compose reverted to the hardcodes". These two arms mock the registry into
  // shapes the hardcodes cannot produce.
  const AUDIO_DESCRIPTOR: TriggerEventDescriptor = {
    id: 'session_finalized',
    contract: 'audio_input.finalized_session',
    idempotency: 'session_scoped',
    payload_keys: ['session_id', 'tenant_id', 'tracks', 'source_capability'],
    idempotency_key_field: 'session_id',
  };

  afterEach(() => {
    vocabularyMock.override = undefined;
  });

  it('derives the enqueue idempotency key from the DESCRIPTOR — nets the trigger-registration wiring', async () => {
    // The audio descriptor with its key field moved to 'tenant_id' — still within payload_keys, so
    // every coherence/persist-scope check passes and the fixture composes. If compose's trigger registration
    // reverted to the original `({ workflow })`, the dispatcher's implicit default
    // (sessionScopedIdempotencyKey('session_id')) would enqueue 'session_id:sess-abc:finalized' — RED.
    vocabularyMock.override = () =>
      new Map([
        [AUDIO_DESCRIPTOR.contract, { ...AUDIO_DESCRIPTOR, idempotency_key_field: 'tenant_id' }],
      ]);
    const enqueuer = new RecordingEnqueuer();
    const composed = composeProductDeploy(parseFixture(), rollout({ enqueuer }));
    const result = await composed.ingress.emit({
      id: 'tenant-a:sess-abc',
      type: 'audio_input.finalized_session',
      occurred_at: '2026-07-03T00:00:00.000Z',
      payload: {
        session_id: 'sess-abc',
        tenant_id: TENANT,
        tracks: [{ track: 'mic', committed_byte_len: 1 }],
        source_capability: 'audio_input',
      },
    });
    expect(result.enqueued).toHaveLength(1);
    expect(enqueuer.calls[0]?.idempotencyKey).toBe(`tenant_id:${TENANT}:finalized`);
  });

  it('an EMPTY vocabulary fails compose through the descriptor-built INVENTORY — nets the events wiring', () => {
    // With an empty registry the descriptor-built inventory declares NO events, so the bridge
    // rejects the workflow's trigger fail-closed (unknown_trigger_event). The message assertion
    // pins the INVENTORY path specifically: if `inventory.events` reverted to the original hardcoded
    // set, the bridge would compile and the failure would instead come from
    // triggerRegistrationForWorkflow ('no mounted capability declares a descriptor') — RED here.
    //
    // HONEST SCOPE: beyond the inventory site this arm nets the descriptor-consumption sites
    // COLLECTIVELY, not each in isolation. A single-site revert of the OTHER consumers (the
    // trigger-registration argument at the dispatcher, or the persist-scope `descriptors:` argument) keeps
    // this arm green because compose still fails fail-closed at the remaining descriptor consumers
    // (triggerRegistrationForWorkflow's missing-descriptor rejection and/or
    // requirePersistScopeInTriggerPayload's missing-descriptor rejection). Those single-site
    // reverts are netted elsewhere: the trigger-registration wiring by the descriptor-derived-key
    // arm above; the persist-scope per-event FUNCTION logic by event-vocabulary.test.ts's union test (which
    // calls requirePersistScopeInTriggerPayload directly — compose's `descriptors:` ARGUMENT wiring
    // at the persist-scope call site is itself not compose-level netted; honest residual:
    // the single `eventDescriptors` var feeds all three consumers and arm 1 proves it is
    // registry-sourced, so an isolated persist-scope-argument hardcode has no natural revert target).
    vocabularyMock.override = () => new Map();
    expectReject(
      NOTETOOL_YAML,
      rollout(),
      'unsupported_spec',
      /workflow 'process_recording' does not compile onto the wired runtime \(unknown_trigger_event/,
    );
  });
});

describe('composeProductDeploy — the liveAgent extraction seam (item 1)', () => {
  const liveNode = () => async () =>
    ({ status: 'completed', artifact_refs: [], output: {} }) as const;

  it('selects the live executor over rollout.agents and builds the node PER RUN (tenant-bound)', () => {
    const built: Array<{ agentId: string; tenantId: string }> = [];
    const composed = composeProductDeploy(
      parseFixture(),
      rollout({
        agents: undefined,
        liveAgent: {
          agentIds: ['note_extractor'],
          buildNodeForAgent: (agentId: string, deps: { tdb: TenantDb; tenantId: string }) => {
            built.push({ agentId, tenantId: deps.tenantId });
            return liveNode();
          },
        },
      }),
    );
    const registry = composed.buildNodeRegistry({
      tdb: {} as TenantDb,
      productTables: new Map(),
      tenantId: TENANT,
    });
    // The live node is built at registry-build time (per run + per agent), closing over the run's
    // tenant AND the declared agent id (buildNodeForAgent is called once per declared agent).
    expect(built).toEqual([{ agentId: 'note_extractor', tenantId: TENANT }]);
    // The live branch registers the compiled `agent.<id>` op key (key-less proof, no provider
    // smoke needed) — mirrors the deterministic branch's registry.ids() assertion above.
    expect(registry.ids()).toEqual([
      'agent.note_extractor',
      'artifact.persist',
      'artifact.read',
      'grounding.check',
      // DELIBERATE: the declared-store step runtime is wired unconditionally
      // (spec-driven, fail-closed; a doc without store steps never dispatches these ops).
      'store.read',
      'store.write',
      'stt.transcribe_session',
      'validation.check',
    ]);
  });

  it('rejects BOTH rollout.agents AND rollout.liveAgent (no silent precedence)', () => {
    expectReject(
      NOTETOOL_YAML,
      rollout({ liveAgent: { agentIds: ['note_extractor'], buildNodeForAgent: () => liveNode() } }),
      'unsupported_spec',
      /BOTH rollout.agents .* AND rollout.liveAgent/,
    );
  });

  it('rejects a declared extractor not covered by liveAgent.agentIds, naming it', () => {
    expectReject(
      NOTETOOL_YAML,
      rollout({
        agents: undefined,
        liveAgent: { agentIds: ['other'], buildNodeForAgent: () => liveNode() },
      }),
      'unsupported_spec',
      /declared extractor 'note_extractor' has no registered/,
    );
  });

  it('registers a DISTINCT node per DECLARED agent (the per-agent map, not one shared node)', () => {
    // A 2-declared-agent document. The registration loop registers `agent.<id>` for EVERY declared
    // extractor (driven by spec.extractors, not workflow usage), so this exercises the per-agent map directly.
    // RED (before the per-agent map): a single shared buildNode registered the SAME node object under both ids; the
    // per-agent build calls buildNodeForAgent(agentId, …) once per agent, so each agent id maps to its OWN distinct node.
    const base = parseFixture();
    const firstAgent = base.extractors[0];
    if (!firstAgent) throw new Error('the fixture must declare at least one extractor');
    const twoAgents: ProductSpec = {
      ...base,
      extractors: [...base.extractors, { ...firstAgent, id: 'note_summarizer' }],
    };
    const perAgentCalls: string[] = [];
    const composed = composeProductDeploy(
      twoAgents,
      rollout({
        agents: undefined,
        liveAgent: {
          agentIds: ['note_extractor', 'note_summarizer'],
          // A FRESH node per call — a distinct object identity per agent id (multi-backend in prod:
          // each id would close over its OWN backend + config; here identity distinctness is the proof).
          buildNodeForAgent: (agentId: string) => {
            perAgentCalls.push(agentId);
            return liveNode();
          },
        },
      }),
    );
    const registry = composed.buildNodeRegistry({
      tdb: {} as TenantDb,
      productTables: new Map(),
      tenantId: TENANT,
    });
    // buildNodeForAgent was called once PER declared agent (both ids, order-preserved).
    expect(perAgentCalls).toEqual(['note_extractor', 'note_summarizer']);
    // BOTH compiled agent ops are registered as DISTINCT node instances (not one shared node).
    const nodeA = registry.get('agent.note_extractor');
    const nodeB = registry.get('agent.note_summarizer');
    expect(nodeA).not.toBe(nodeB);
    expect(registry.ids()).toContain('agent.note_extractor');
    expect(registry.ids()).toContain('agent.note_summarizer');
  });
});

describe('makeFailSoftMediaPrep — the FAIL-SOFT media-prep hook', () => {
  // A minimal ctx — the injected prepareTrackMedia ignores db/blob; only tenantId is read (for the log).
  const ctx = {
    tenantId: TENANT,
    db: {},
    config: resolveConfig(),
    blob: {},
  } as unknown as AudioBlobContext;

  it('LOGS loudly when prepareTrackMedia RETURNS err (the REAL ffmpeg-failure discard path) + stays fail-soft', async () => {
    const logged: string[] = [];
    let calledWith: { session_id: string; track: string } | undefined;
    const hook = makeFailSoftMediaPrep({
      // The REAL constraint the STT node's throw-fake could NOT reproduce: a RemuxError becomes a
      // RETURNED err(500) (media-prep.ts:98-99), never a throw. The pre-fix compose closure `await`ed
      // and DISCARDED this — so a broken ffmpeg produced NO operator log (the silent-swallow).
      prepareTrackMedia: async (_ctx, p) => {
        calledWith = p;
        return err(500, 'media_prep_failed', 'media prep failed (remux): ffmpeg exited 1');
      },
      ctx,
      logger: { error: (m) => logged.push(m) },
    });
    // Fail-soft: the hook RESOLVES (never throws) even though media prep failed.
    await expect(hook({ session_id: 's1', track: 'mic' })).resolves.toBeUndefined();
    expect(calledWith).toEqual({ session_id: 's1', track: 'mic' });
    // NEVER a silent swallow — exactly one loud structured line carrying status + error code.
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] as string)).toMatchObject({
      event: 'media_prep_failed',
      scope: 'product.compose.media_prep',
      tenant_id: TENANT,
      session_id: 's1',
      track: 'mic',
      status: 500,
      error: 'media_prep_failed',
    });
  });

  it('does NOT log on a successful (ok) media-prep', async () => {
    const logged: string[] = [];
    const hook = makeFailSoftMediaPrep({
      prepareTrackMedia: async () => ok({ ref: 'playable' }),
      ctx,
      logger: { error: (m) => logged.push(m) },
    });
    await hook({ session_id: 's1', track: 'mic' });
    expect(logged).toHaveLength(0);
  });
});
