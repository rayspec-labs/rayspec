/**
 * `composeProductDeploy` — the Product-YAML deploy COMPOSITION.
 *
 * Turns ONE validated `ProductSpec` + ONE deployer-supplied `ProductYamlRollout` into the deployable
 * engine fragments, wiring EXISTING, reviewed packages together (zero new business meaning here —
 * the meaning is in the YAML; the runtimes are Tier A/B):
 *
 *   audio capability mount (@rayspec/audio-runtime/rayspec)
 *     └─ sessionFinalizedSink = WorkflowIngressSessionFinalizedSink (@rayspec/audio-workflow-bridge)
 *          └─ WorkflowEventDispatcher (@rayspec/workflow-durable), tenant-bound, triggers =
 *               the doc's workflows compiled by the REAL bridge (@rayspec/product-yaml-workflow-bridge)
 *                 └─ rollout.enqueuer (DBOS executor in production; the deployment owns the instance)
 *   declarative views mount (@rayspec/views-runtime) over the composed store read surface
 *   the tenant-bound NODE REGISTRY builder (stt / agent / grounding / validation / artifact nodes)
 *
 * This is the seam composition, promoted from the test recipes
 * (audio-workflow-seam.db.test.ts + views-seam.db.test.ts) into its production owner — invoked by
 * `deploy` (the single frozen-surface touch), which maps `ProductComposeError` onto `DeployError`.
 *
 * ── PARTIAL-UNLOCK HONESTY (fail-closed by construction) ────────────────────────────────────────
 * Everything the composition cannot SERVE rejects the deploy naming the section — never a silent
 * skip and never an inert mount:
 *   - a capability outside the wired set, or not `status: available`;
 *   - a workflow step type / operation without a wired node (`store_read`/`store_write` are WIRED
 *     — two tenant-bound nodes over the makeHandlerDb facade, store-nodes.ts);
 *   - a grounding policy value other than the executed `prune`/`drop` pair;
 *   - a declared agent without a registered extraction executor;
 *   - a persisted artifact collection / transcript sink without a bound store carrying the canonical
 *     row-contract columns;
 *   - a capability-sourced view whose contract has no delegable capability handler.
 */

import type { AgentRuntimeRegistry } from '@rayspec/agent-runtime';
import type {
  AudioBlobContext,
  AudioCapabilityConfig,
  AudioCapabilityResult,
  SessionFinalizedSink,
} from '@rayspec/audio-runtime';
// AUDIO_CAPABILITY_MANIFEST: the audio half of the mounted trigger-event vocabulary. The
// capability-owned store NAMES for the shared store checker come from the spec-aware
// composeCapabilityStores helper (capability-stores.ts).
import {
  AUDIO_CAPABILITY_MANIFEST,
  prepareTrackMedia,
  resolveConfig,
} from '@rayspec/audio-runtime';
import { type MountedAudioCapability, mountAudioCapability } from '@rayspec/audio-runtime/rayspec';
import {
  WorkflowIngressFileSubmittedSink,
  WorkflowIngressRecordSubmittedSink,
  WorkflowIngressSessionFinalizedSink,
  WorkflowIngressTurnSubmittedSink,
} from '@rayspec/capability-bridges';
// The conversational-ingress capability — mounted CONDITIONALLY, iff the doc declares
// `conversation_input` (the record/file conditional-mount law). The manifest feeds the trigger
// vocabulary; the bridge sink is the fail-closed tenant boundary (the audio/record/file mirror).
import {
  CONTEXT_FILTER_PAYLOAD_KEYS,
  CONVERSATION_CAPABILITY_MANIFEST,
  CONVERSATION_STORE_NAMES,
  type ConversationCapabilityConfig,
  type ConversationTurnResponderFactory,
} from '@rayspec/conversation-runtime';
import {
  type MountedConversationCapability,
  mountConversationCapability,
} from '@rayspec/conversation-runtime/rayspec';
import type { TenantDb } from '@rayspec/db';
// The generic byte-ingest capability — mounted CONDITIONALLY, iff the doc declares
// `file_input` (the record conditional-mount law). The manifest feeds the trigger vocabulary;
// the bridge sink is the fail-closed tenant boundary (the audio/record sink mirror).
import { FILE_CAPABILITY_MANIFEST, type FileCapabilityConfig } from '@rayspec/file-runtime';
import { type MountedFileCapability, mountFileCapability } from '@rayspec/file-runtime/rayspec';
import {
  type CapabilityNodeHandler,
  CapabilityRegistry,
  type WorkflowSpec,
} from '@rayspec/foundation';
import { createArtifactReadHandler } from '@rayspec/grounding-runtime';
import type { BlobStore } from '@rayspec/handler-sdk';
import { makeHandlerDb, type ResolvedHandler } from '@rayspec/platform';
import {
  type CapabilityInventory,
  compileProductYamlWorkflow,
  type ProductYamlBridgeInput,
  ProductYamlWorkflowBridgeError,
} from '@rayspec/product-yaml-workflow-bridge';
// The generic submit-ingress capability — mounted CONDITIONALLY, iff the doc
// declares `record_input`. The manifest feeds the trigger
// vocabulary; the bridge sink is the fail-closed tenant boundary (the audio sink's mirror).
import {
  RECORD_CAPABILITY_MANIFEST,
  RECORD_INPUT_CAPABILITY_ID,
  type RecordCapabilityConfig,
  type RecordNormalizerFactory,
} from '@rayspec/record-runtime';
import {
  type MountedRecordCapability,
  mountRecordCapability,
} from '@rayspec/record-runtime/rayspec';
// The SHARED store checker (product-lint.ts) — the SAME implementation `lintProductSpec` runs at
// parse time; compose re-runs it as defense-in-depth for a code-built spec that bypassed the parser.
import {
  type ApiRouteSpec,
  type ColumnType,
  checkProductStores,
  type ProductSpec,
  type RaySpec,
  STORE_READ_MAX_LIMIT,
  type StoreSpec,
} from '@rayspec/spec';
import type { SttAdapter } from '@rayspec/stt-port';
import { mountProductViews, type ViewResolvedHandler } from '@rayspec/views-runtime';
import {
  TenantDbArtifactStore,
  type WorkflowEnqueuer,
  WorkflowEventDispatcher,
  type WorkflowEventIngress,
} from '@rayspec/workflow-durable';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  composeCapabilityStores,
  declaresAudio,
  declaresConversationInput,
  declaresFileInput,
  declaresRecordInput,
} from './capability-stores.js';
import { ProductComposeError } from './errors.js';
import {
  mountedTriggerEventDescriptors,
  requirePersistScopeInTriggerPayload,
  triggerRegistrationForWorkflow,
} from './event-vocabulary.js';
import {
  type FileParseLimits,
  makeFileParseNode,
  type ResolvedFileParseLimits,
  resolveFileParseLimits,
} from './file-parse-node.js';
import {
  CONSOLE_MEDIA_PREP_LOGGER,
  type MediaPrepLogger,
  makeArtifactPersistNode,
  makeDeclaredAgentNode,
  makeGroundingPolicyNode,
  makeShapeValidationNode,
  makeSttTranscribeSessionNode,
  STT_TRANSCRIBE_RETRY_POLICY,
} from './nodes.js';
import { makeStoreReadNode, makeStoreWriteNode } from './store-nodes.js';

// ── the wired surface (what THIS composition can serve) ─────────────────────────────────────────

/** The Tier-B capabilities this composition serves (audio + record + file + conversation mounts / STT / grounding / validation / artifact). */
export const WIRED_CAPABILITIES: ReadonlySet<string> = new Set([
  'audio_input',
  'media_playback',
  'record_input',
  'file_input',
  'conversation_input',
  'stt',
  'grounding',
  'validation',
  'artifact',
]);

/** The non-agent node operations the registry wires. */
const WIRED_OPERATIONS = [
  'stt.transcribe_session',
  'grounding.check',
  'validation.check',
  'artifact.persist',
  'artifact.read',
  // The declared-store step runtime (store-nodes.ts over makeHandlerDb).
  'store.read',
  'store.write',
  // The durable blob→text parse node (file-parse-node.ts over the injected tenant-bound
  // blob reader). Bridge-compilable for any doc; ACTUALLY registered iff the doc declares
  // file_input AND the deployment supplies rollout.file.blob (fail-closed pre-checked below).
  'file_input.parse_text',
] as const;

/** The workflow step types the bridge compiles (store_read/store_write wired). */
const COMPILABLE_STEP_TYPES: ReadonlySet<string> = new Set([
  'capability',
  'agent',
  'validation',
  'artifact_persist',
  'artifact_read',
  'store_read',
  'store_write',
]);

/** capability contract → the audio mount handler that serves a `capability`-sourced view of it. */
function capabilityViewDelegate(
  contractRef: string,
  audio: MountedAudioCapability | undefined,
): { kind: 'route'; fn: unknown } | undefined {
  // Without a mounted audio capability (a non-audio doc) there is no delegable handler — the caller
  // fail-closes naming the wired contract, so a media_playback.token view on a doc that does not
  // declare the capability is rejected rather than silently unserved.
  if (audio && contractRef === 'media_playback.token') {
    return audio.handlers.get(audio.handlerIds.playToken);
  }
  return undefined;
}

/** The canonical artifact-collection row contract (materialize.ts) — column name → required type. */
export const COLLECTION_ROW_CONTRACT: ReadonlyArray<readonly [string, ColumnType]> = [
  ['artifact_kind', 'text'],
  ['payload', 'jsonb'],
  ['human_edited', 'boolean'],
  ['dismissed', 'boolean'],
  ['artifact_ref', 'text'],
];

/** The transcript-sink row contract (nodes.ts stt node) — column name → required type. */
export const TRANSCRIPT_ROW_CONTRACT: ReadonlyArray<readonly [string, ColumnType]> = [
  ['session_id', 'text'],
  ['track', 'text'],
  ['track_ref', 'text'],
  ['status', 'text'],
  ['model', 'text'],
  ['detected_language', 'text'],
  ['full_text', 'text'],
  ['word_count', 'integer'],
  ['payload', 'jsonb'],
];

// ── rollout config + result types ────────────────────────────────────────────────────────────────

/**
 * What the DEPLOYMENT supplies (the platform ships none of it — zero-product-code): the
 * deployment tenant, the durable enqueuer instance, the Tier-A product stores beyond the audio
 * capability's own, the artifact/transcript store bindings, the STT adapter, and the declared-agent
 * extraction executors.
 */
export interface ProductYamlRollout {
  /**
   * The deployment tenant every dispatched workflow run executes under (server-derived; the
   * single-deployment LOCAL posture — exactly like `DbosCronScheduler` / the i dispatcher).
   */
  readonly tenantId: string;
  /** The durable workflow enqueuer (production: `DbosWorkflowExecutor`; tests: an executing fake). */
  readonly enqueuer: WorkflowEnqueuer;
  /** Tier-A product stores beyond the audio capability's own (transcript + artifact collections). */
  readonly stores?: readonly StoreSpec[];
  /** Declared `artifacts[].collection` (or kind) → its backing store. */
  readonly artifactCollections?: ReadonlyMap<string, { readonly store: string }>;
  /** The transcript-row sink store (required iff an `stt.*` workflow step is declared). */
  readonly transcripts?: { readonly store: string };
  /** The neutral STT adapter instance (required iff an `stt.*` workflow step is declared). */
  readonly stt?: { readonly adapter: SttAdapter };
  /** Declared-extractor executors, keyed `agent.<id>` (required iff `extractors[]` is non-empty). */
  readonly agents?: AgentRuntimeRegistry;
  /**
   * The LIVE extraction executor seam (item 1; generalized to per-agent). When supplied it
   * SUPERSEDES `rollout.agents` for the declared agent nodes: `buildNodeRegistry` builds a per-run,
   * PER-AGENT node via `buildNodeForAgent(agentId, { tdb, tenantId })` (closing over the run's
   * tenant-bound db so `runAgent` journals cost, AND over the agent id so a multi-agent /
   * multi-backend deployment mounts a DISTINCT node — its own backend + config — per declared extractor).
   * `agentIds` lists the extractors this executor serves — compose fail-closed-verifies it covers every
   * `spec.extractors`. Exactly one of `agents` / `liveAgent` must be supplied when `spec.extractors` is
   * non-empty. (`buildNodeForAgent` builds a per-agent node — not one shared node for all agents;
   * deploy.ts (frozen surface) imports `ProductYamlRollout` but does NOT destructure `liveAgent`, so this
   * per-agent shape keeps deploy.ts compiling byte-unchanged.)
   */
  readonly liveAgent?: {
    readonly agentIds: readonly string[];
    readonly buildNodeForAgent: (
      agentId: string,
      deps: { tdb: TenantDb; tenantId: string },
    ) => CapabilityNodeHandler;
  };
  /** Audio capability mount options (base path, allowed tracks, TTL policy…). */
  readonly audio?: {
    readonly basePath?: string;
    readonly capability?: AudioCapabilityConfig;
  };
  /**
   * Record (submit-ingress) capability mount options (ADDITIVE/optional — deploy.ts consumes
   * this type; only relevant when the doc declares `record_input`).
   */
  readonly record?: {
    readonly basePath?: string;
    readonly capability?: RecordCapabilityConfig;
    /**
     * The tenant-bound record NORMALIZER factory (REQUIRED when the record_input capability declares
     * `input_normalize`): a submitted record is transformed by the declared agent before persist, so a
     * normalize-declaring doc without a wired normalizer fails closed at compose — the declared-agents
     * executor-coverage mirror. Production: `makeLiveRecordNormalizer` over the neutral agent path;
     * dev/tests inject a deterministic fake. Supplied without the declaration it is silently unused (the
     * same deployment-side-options posture as the sibling rollout blocks).
     */
    readonly normalizer?: RecordNormalizerFactory;
  };
  /**
   * File (byte-ingest) capability mount options (ADDITIVE/optional — deploy.ts consumes
   * `ProductYamlRollout` opaquely, so this block keeps it compiling byte-unchanged; only relevant
   * when the doc declares `file_input`). `capability` is the deployment's config-override seam
   * (byte cap, content-type allowlist, file-id shape — the `FileCapabilityConfig`).
   *
   * Additive: `blob(tenantId)` is the tenant-bound blob READER factory the
   * `file_input.parse_text` node resolves the sealed file bytes through (the `mediaPrep.blob`
   * mirror — the deployment's fs blob factory; NEVER a raw fs/db handle). Required iff a workflow
   * declares a `file_input.parse_text` step (fail-closed pre-checked). `parse` overrides the
   * parser-bomb bounds (page/char/timeout caps — validated fail-closed at compose, INCLUDING the
   * cross-check that `pdfParseTimeoutMs` stays under the compiled step's timeout_policy so
   * the typed `pdf_parse_timeout` wins over the generic engine timeout; file-parse-node.ts
   * documents the defaults + rationale).
   */
  readonly file?: {
    readonly basePath?: string;
    readonly capability?: FileCapabilityConfig;
    readonly blob?: (tenantId: string) => BlobStore;
    readonly parse?: FileParseLimits;
  };
  /**
   * Conversation (conversational-ingress) capability mount options (ADDITIVE/optional
   * deploy.ts consumes `ProductYamlRollout` opaquely, so this block keeps it compiling
   * byte-unchanged; only relevant when the doc declares `conversation_input`). `capability` is the
   * deployment's config-override seam (message byte cap WITHIN the construction-belted 64 KiB
   * ceiling, id shapes, history-window bounds — the `ConversationCapabilityConfig`;
   * every override is validated fail-closed AT COMPOSE via the real `resolveConversationConfig`).
   * No blob/byte-mover option: this capability moves no bytes (the message is a bounded DB
   * column). Supplied without the declaration it is silently unused — the silently-unused-rollout posture
   * (5b below) applies verbatim.
   */
  readonly conversation?: {
    readonly basePath?: string;
    readonly capability?: ConversationCapabilityConfig;
    /**
     * The tenant-bound turn responder factory (REQUIRED when the doc declares
     * `conversation_input`: a submitted turn produces a REAL reply, so a
     * conversation-declaring doc without a wired responder fails closed at compose, mirroring the
     * declared-agents executor-coverage law). Production: the boot's `makeLiveTurnResponder` over
     * the per-product `<agent_id>.responder.json`; tests inject a deterministic fake. A declared
     * `storeContext` is verified against the composed stores below (fail-closed at compose).
     */
    readonly responder?: ConversationTurnResponderFactory;
  };
  /**
   * The media-prep seam (item 3). When supplied, the STT node prepares each
   * finalized track's playable artifact (remux → registerPlayableArtifact) FAIL-SOFT after persisting
   * the transcript. `blob(tenantId)` returns the run's tenant-bound blob store (the deployment's fs
   * blob factory). Absent ⇒ no media prep (the deterministic CI path). Requires the audio capability's
   * chunks to exist in the blob store + ffmpeg on PATH.
   */
  readonly mediaPrep?: { readonly blob: (tenantId: string) => BlobStore };
}

/** The per-run bindings a `buildNodeRegistry` caller supplies (the DBOS resolver / a test enqueuer). */
export interface NodeRegistryBindings {
  /** The tenant-bound chokepoint handle for THIS run's tenant. */
  readonly tdb: TenantDb;
  /** Store name → runtime PgTable (the deployment's committed product-table instances — deploy verified them). */
  readonly productTables: ReadonlyMap<string, PgTable>;
  /** The run's tenant id (artifact_ref/track_ref namespacing). */
  readonly tenantId: string;
}

/** The composed deployable fragments `deploy()` mounts. */
export interface ComposedProductDeploy {
  /** The validated Product-YAML document this composition serves. */
  readonly product: ProductSpec;
  /**
   * The code-built engine spec the SHARED deploy pipeline consumes (stores = audio capability
   * stores + rollout stores; api = view routes + audio capability routes, ownership-resolved).
   */
  readonly engineSpec: RaySpec;
  /** The composed resolved handlers (audio capability + views) the engine dispatches. */
  readonly handlers: ReadonlyMap<string, ResolvedHandler>;
  /** Workflow id → the bridge-compiled Tier-A spec the dispatcher/enqueuer runs. */
  readonly workflows: ReadonlyMap<string, WorkflowSpec>;
  /** Build the tenant-bound node registry for one run (the DBOS `resolveWorkflowRun` seam). */
  readonly buildNodeRegistry: (bindings: NodeRegistryBindings) => CapabilityRegistry;
  /** The events the tenant-bound dispatcher listens on (boot banner / tests). */
  readonly triggerEvents: readonly string[];
  /** The mounted view routes (`METHOD path`), for the deploy log. */
  readonly viewRoutes: readonly string[];
  /**
   * The composed tenant-bound event ingress (the SAME dispatcher instance the mounted audio sink
   * feeds) — ADDITIVE exposure so a harness/test can emit a neutral `WorkflowInputEvent` and
   * observe the real trigger wiring (incl. the descriptor-derived idempotency keys) without driving
   * the full capability HTTP surface. Tenant-bound at construction; exposing it widens no external
   * surface (`deploy()` does not consume it).
   */
  readonly ingress: WorkflowEventIngress;
}

// ── the fail-soft media-prep hook ──────────────────────────────────────────────────────────

/**
 * Build the STT node's FAIL-SOFT media-prep hook. Runs `prepareTrackMedia` off the
 * transcript path and — this is the fix — INSPECTS its typed result: on `!ok` (the real
 * ffmpeg-failure path, where a RemuxError becomes `err(500 media_prep_failed)` that the node's own
 * try/catch never sees because the hook returns void) it emits a LOUD structured operator log. A broken
 * ffmpeg on the VPS MUST be operator-visible (forbids a silent swallow). Stays fail-soft:
 * a typed err is logged and swallowed (play-token then serves the honest `not_ready_409`); a genuine
 * THROW (a non-RemuxError fault `prepareTrackMedia` re-raises) propagates to the STT node's own
 * catch-and-log (defense-in-depth). `prepareTrackMedia` is a parameter (the real import at the call
 * site; a fake in the unit proof, which asserts the return-err path logs).
 */
export function makeFailSoftMediaPrep(deps: {
  readonly prepareTrackMedia: (
    ctx: AudioBlobContext,
    params: { session_id: string; track: string },
  ) => Promise<AudioCapabilityResult<unknown>>;
  readonly ctx: AudioBlobContext;
  readonly logger?: MediaPrepLogger;
}): (p: { session_id: string; track: string }) => Promise<void> {
  const logger = deps.logger ?? CONSOLE_MEDIA_PREP_LOGGER;
  return async (p) => {
    const result = await deps.prepareTrackMedia(deps.ctx, p);
    if (!result.ok) {
      logger.error(
        JSON.stringify({
          event: 'media_prep_failed',
          scope: 'product.compose.media_prep',
          tenant_id: deps.ctx.tenantId,
          session_id: p.session_id,
          track: p.track,
          status: result.status,
          error: result.error,
          detail: result.detail,
        }),
      );
    }
  };
}

// ── the composition ──────────────────────────────────────────────────────────────────────────────

function unsupported(message: string): never {
  throw new ProductComposeError('unsupported_spec', message);
}
function rolloutError(message: string): never {
  throw new ProductComposeError('roll out', message);
}

function columnTypes(store: StoreSpec): Map<string, ColumnType> {
  return new Map(store.columns.map((c) => [c.name, c.type]));
}

function requireStoreContract(
  stores: readonly StoreSpec[],
  storeName: string,
  contract: ReadonlyArray<readonly [string, ColumnType]>,
  forWhat: string,
): void {
  const store = stores.find((s) => s.name === storeName);
  if (!store) {
    rolloutError(
      `${forWhat}: bound store '${storeName}' is not among the deployment's declared stores.`,
    );
  }
  const cols = columnTypes(store);
  for (const [name, type] of contract) {
    if (cols.get(name) !== type) {
      rolloutError(
        `${forWhat}: bound store '${storeName}' must declare column '${name}' of type '${type}' ` +
          `(got ${cols.has(name) ? `'${cols.get(name)}'` : 'no such column'}).`,
      );
    }
  }
}

/**
 * The lowered engine target's version literal — FROZEN at the pre-merge engine-internal representation
 * (BYTE-IDENTITY LAW). The unified AUTHORING language bumped to `version:'1.0'`, but the engine
 * LOWERING did NOT: a product-meaning document still lowers to today's `RaySpec`, byte-for-byte, so
 * the front-end version merge is provably decoupled from the engine (pinned by the acme-notes compose
 * golden + `gate:byte-identity`). `deploy()` consumes this code-built spec DIRECTLY and never re-parses
 * it through the grammar (whose `version` is now `z.literal('1.0')`), so this frozen literal is the
 * engine identity, not an authored version. Typed `string` so the `as RaySpec['version']` cast
 * below reconciles it with the bumped literal type WITHOUT perturbing the golden.
 */
const FROZEN_ENGINE_SPEC_VERSION: string = '0.1';

/**
 * The NEUTRAL code-built engine spec the SHARED deploy pipeline consumes. Assembles a fixed
 * `RaySpec` skeleton (version FROZEN — see `FROZEN_ENGINE_SPEC_VERSION`) from the composed store
 * read surface + the ownership-merged route set + metadata — with NO capability-specific coupling, so a
 * doc that declares no audio composes a correct minimal spec, and an audio-declaring doc
 * composes BYTE-IDENTICALLY to the earlier `buildAudioCapabilitySpec({ ...audio, api: [] }, meta, {
 * stores, api })` output (that call only ever contributed `audio.stores` — merged here via
 * `composedStores` — plus the same empty arrays; the key ORDER below matches it exactly so the JSON
 * serialization is unchanged). Pinned by the compose golden (the live-stack freeze).
 */
export function buildProductEngineSpec(
  stores: StoreSpec[],
  api: ApiRouteSpec[],
  metadata: { name: string; description?: string },
): RaySpec {
  return {
    version: FROZEN_ENGINE_SPEC_VERSION as RaySpec['version'],
    metadata,
    stores,
    api,
    agents: [],
    tooling: [],
    triggers: [],
    handlers: [],
    extensions: [],
  };
}

export function composeProductDeploy(
  spec: ProductSpec,
  rollout: ProductYamlRollout,
): ComposedProductDeploy {
  // ── 1. capability wiredness + mount-status discipline ────────────────────────────────────────
  for (const cap of spec.capabilities) {
    if (!WIRED_CAPABILITIES.has(cap.id)) {
      unsupported(
        `capability '${cap.id}' has no wired Tier-B runtime in this composition (wired: ` +
          `${[...WIRED_CAPABILITIES].join(', ')}). A mounted Product-YAML doc declares only ` +
          'runtime-backed sections — remove it (declare it again when its runtime lands).',
      );
    }
    if (cap.status !== 'available') {
      unsupported(
        `capability '${cap.id}' is declared '${cap.status}', but a MOUNTED doc declares only ` +
          "runtime-backed capabilities — mark it 'available' (it IS wired in this composition) or " +
          'remove it from the mounted document.',
      );
    }
    // input_normalize is a RECORD-ingress feature: only the record_input submit path runs a declared
    // normalize step. A declaration on any OTHER capability has no wired runtime here — reject it
    // fail-closed (never a silently-ignored declaration).
    if (cap.input_normalize && cap.id !== RECORD_INPUT_CAPABILITY_ID) {
      unsupported(
        `capability '${cap.id}' declares 'input_normalize', but a declared input-normalize step is ` +
          `only wired for the '${RECORD_INPUT_CAPABILITY_ID}' submit-ingress capability in this ` +
          'composition — remove it (or declare it on record_input).',
      );
    }
  }

  // ── 2. workflow step-type + operation pre-checks (specific messages before the bridge) ───────
  for (const wf of spec.workflows) {
    for (const step of wf.steps) {
      if (!COMPILABLE_STEP_TYPES.has(step.type)) {
        unsupported(
          `workflow '${wf.id}' step '${step.id}' has type '${step.type}', which has NO wired ` +
            'runtime — remove the step or express it through a wired node.',
        );
      }
    }
  }

  // ── 2b. declared product stores + store steps — the SHARED spec checker, re-run here ──────────
  // `lintProductSpec` already ran this at parse time; re-running it fail-closed at compose guards a
  // CODE-BUILT spec that bypassed the parser (a store step targeting an undeclared store / a filter
  // or values column outside the store's declared columns / a write omitting the conflict key would
  // otherwise surface only as a run-time node failure — reject it at deploy instead). Compose
  // ALSO passes the wired capability-owned store names (parse time cannot), so a declared store
  // shadowing a capability store is rejected HERE, before derive/rollout ever run. The name set
  // is SPEC-AWARE (the shared composeCapabilityStores helper — record_submissions joins it iff the
  // doc declares record_input, so the shadow check tracks the actual mounts).
  const capabilityStores = composeCapabilityStores(spec);
  const withAudio = declaresAudio(spec);
  const withRecordInput = declaresRecordInput(spec);
  const withFileInput = declaresFileInput(spec);
  const withConversationInput = declaresConversationInput(spec);
  const storeErrors = checkProductStores(spec, capabilityStores.names);
  if (storeErrors.length > 0) {
    unsupported(
      'the declared product stores / store steps are invalid: ' +
        storeErrors.map((e) => `${e.message}${e.path ? ` (at ${e.path})` : ''}`).join('; '),
    );
  }

  // ── 3. grounding policy: only the EXECUTED pair is mountable ──────────────────────────────────
  const usesGroundingCheck = spec.workflows.some((wf) =>
    wf.steps.some((s) => s.use === 'grounding.check'),
  );
  if (usesGroundingCheck && !spec.grounding) {
    unsupported(
      "a workflow declares a 'grounding.check' step but the document declares no grounding policy " +
        '— the gate would have nothing declared to execute (fail-closed).',
    );
  }
  if (spec.grounding) {
    const g = spec.grounding;
    if (g.on_invalid_citation !== 'prune') {
      unsupported(
        `grounding.on_invalid_citation '${g.on_invalid_citation ?? '(undeclared)'}' has no wired ` +
          "runtime — the executed policy is 'prune' (out-of-set citations are removed).",
      );
    }
    if (g.on_empty_evidence !== 'drop') {
      unsupported(
        `grounding.on_empty_evidence '${g.on_empty_evidence ?? '(undeclared)'}' has no wired ` +
          "runtime — the executed policy is 'drop' (an evidence-less claim never persists).",
      );
    }
    if (g.require_source_spans !== true || !g.source_span_contract) {
      unsupported(
        'grounding.require_source_spans must be true with a declared source_span_contract — the ' +
          'executed gate is closed-span-set validation; a policy without a closed set is not wired.',
      );
    }
    for (const [track, role] of Object.entries(g.attribution_policy?.tracks ?? {})) {
      if (role !== 'local' && role !== 'remote' && role !== 'unknown') {
        unsupported(
          `grounding.attribution_policy.tracks['${track}'] = '${role}' is not an executable ` +
            'speaker role (wired vocabulary: local | remote | unknown).',
        );
      }
    }
  }

  // ── 4. deployment wiring requirements (named, actionable) ─────────────────────────────────────
  const usesStt = spec.workflows.some((wf) => wf.steps.some((s) => s.use.startsWith('stt.')));
  if (usesStt && !rollout.stt) {
    unsupported(
      "the document declares an 'stt.*' workflow step, but the deployment supplied no STT adapter " +
        '(rollout.stt.adapter) — supply one (fake or provider) to mount this document.',
    );
  }
  if (usesStt && !rollout.transcripts) {
    unsupported(
      "the document declares an 'stt.*' workflow step, but the deployment supplied no transcript " +
        'store binding (rollout.transcripts.store) — the transcript read surface would silently ' +
        'stay empty (fail-closed).',
    );
  }
  // A `file_input.parse_text` step needs the DECLARED file capability (its trigger payload
  // carries the blob key) AND the deployment's tenant-bound blob reader — both fail-closed with a
  // named, actionable message BEFORE the generic registered-ops cross-check. The parse-bound
  // overrides are validated here too (deploy-time loud — a malformed cap would silently disable a
  // parser-bomb bound at run time otherwise).
  const usesFileParse = spec.workflows.some((wf) =>
    wf.steps.some((s) => s.use === 'file_input.parse_text'),
  );
  if (usesFileParse && !withFileInput) {
    unsupported(
      "a workflow declares a 'file_input.parse_text' step, but the document does not declare the " +
        "'file_input' capability — the parse node reads the file_submitted trigger payload's blob " +
        'key, which only that capability emits (declare it or remove the step; fail-closed).',
    );
  }
  if (usesFileParse && !rollout.file?.blob) {
    unsupported(
      "a workflow declares a 'file_input.parse_text' step, but the deployment supplied no " +
        'tenant-bound blob reader (rollout.file.blob) — the node cannot resolve the uploaded ' +
        'bytes (fail-closed); supply the deployment blob factory to mount this document.',
    );
  }
  let fileParseLimits: ResolvedFileParseLimits | undefined;
  try {
    fileParseLimits = resolveFileParseLimits(rollout.file?.parse);
  } catch (e) {
    rolloutError(`rollout.file.parse is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (spec.extractors.length > 0) {
    if (rollout.agents && rollout.liveAgent) {
      unsupported(
        'the deployment supplied BOTH rollout.agents (deterministic) AND rollout.liveAgent (live) — ' +
          'exactly one extraction executor path must be chosen (fail-closed; no silent precedence).',
      );
    }
    if (!rollout.agents && !rollout.liveAgent) {
      unsupported(
        'the document declares extractors[], but the deployment supplied no extraction executors ' +
          '(neither rollout.agents nor rollout.liveAgent) — a declared extractor with no executor cannot ' +
          'run (fail-closed).',
      );
    }
    const liveIds = new Set(rollout.liveAgent?.agentIds ?? []);
    for (const extractor of spec.extractors) {
      const covered = rollout.liveAgent
        ? liveIds.has(extractor.id)
        : (rollout.agents?.has(`agent.${extractor.id}`) ?? false);
      if (!covered) {
        unsupported(
          `declared extractor '${extractor.id}' has no registered extraction executor ` +
            `(${rollout.liveAgent ? 'not in rollout.liveAgent.agentIds' : `'agent.${extractor.id}' missing from rollout.agents`}) — register one to mount this document.`,
        );
      }
    }
  }

  // ── 5. trigger vocabulary + workflow compile + the tenant-bound dispatcher (the i composition) ─
  const workflows = new Map<string, WorkflowSpec>();
  // The trigger-event vocabulary of the MOUNTED capabilities: the inventory's events, the persist-scope
  // payload contracts, and the per-trigger idempotency keys all derive from these descriptors — the
  // audio mount's `session_finalized` WHEN the doc declares audio (conditional, in lockstep with
  // the mount below) plus, WHEN DECLARED, the record mount's `record_submitted` and the file
  // mount's `file_submitted` and the conversation mount's `turn_submitted` (the DEFAULT
  // `${capability}.${event}` join, per-TURN `idempotency_key_field: 'turn_ref'`). An
  // UNDECLARED capability contributes no vocabulary, so a workflow triggering on its event without
  // declaring it fails compose fail-closed (`triggerRegistrationForWorkflow` → unknown_trigger_event).
  const eventDescriptors = mountedTriggerEventDescriptors([
    ...(withAudio ? AUDIO_CAPABILITY_MANIFEST.capabilities : []),
    ...(withRecordInput ? RECORD_CAPABILITY_MANIFEST.capabilities : []),
    ...(withFileInput ? FILE_CAPABILITY_MANIFEST.capabilities : []),
    ...(withConversationInput ? CONVERSATION_CAPABILITY_MANIFEST.capabilities : []),
  ]);
  const inventory: CapabilityInventory = {
    operations: new Set<string>([
      ...WIRED_OPERATIONS,
      ...spec.extractors.map((a) => `agent.${a.id}`),
    ]),
    contracts: new Set<string>([
      ...Object.keys(spec.contracts),
      ...spec.capabilities.flatMap((c) => c.contracts),
    ]),
    events: new Set<string>(eventDescriptors.keys()),
  };
  const bridgeInput: ProductYamlBridgeInput = {
    version: spec.version,
    product: spec.product,
    requires: spec.requires,
    capabilities: spec.capabilities,
    extractors: spec.extractors,
    workflows: spec.workflows,
    ...(spec.deployment_overrides ? { deployment_overrides: spec.deployment_overrides } : {}),
  };
  for (const wf of spec.workflows) {
    try {
      workflows.set(
        wf.id,
        compileProductYamlWorkflow(bridgeInput, {
          workflowId: wf.id,
          capabilityInventory: inventory,
          status: 'runtime_foundation',
        }),
      );
    } catch (e) {
      if (e instanceof ProductYamlWorkflowBridgeError) {
        unsupported(
          `workflow '${wf.id}' does not compile onto the wired runtime (${e.code} at ${e.path}): ` +
            e.message,
        );
      }
      throw e;
    }
  }

  // Dual-track completeness: the `stt.transcribe_session` node WAITS (retryable) for a still-recording
  // sibling track to seal before transcribing (see the node's completeness guard). That only works if
  // the compiled step actually re-invokes the node — so wire the completeness retry policy (backoff +
  // enough attempts to span the node's wait bound) here. The bridge compiler sets `max_attempts` but no
  // `backoff_ms`, which would make retries fire instantly and defeat the wait; this override owns the
  // stt step's retry semantics. Applied ONLY to the transcribe step; other steps keep their compiled
  // policy. See STT_TRANSCRIBE_RETRY_POLICY for why the window must exceed the node's bound.
  for (const wf of workflows.values()) {
    for (const step of wf.steps) {
      if (step.capability === 'stt' && step.operation === 'transcribe_session') {
        step.retry_policy = { ...STT_TRANSCRIBE_RETRY_POLICY };
      }
    }
  }

  // The parse node's TYPED `pdf_parse_timeout` must fire BEFORE the engine's
  // generic step timeout — an override at/above the compiled step's timeout_policy would silently
  // demote the named failure to a generic engine timeout. The default relation (20s < 30s) is
  // unit-pinned; overrides are cross-checked here against the COMPILED value (the compiler owns
  // the constant — never a duplicated literal), fail-closed at compose.
  if (fileParseLimits) {
    for (const wf of workflows.values()) {
      for (const step of wf.steps) {
        if (step.capability !== 'file_input' || step.operation !== 'parse_text') continue;
        const stepTimeoutMs = step.timeout_policy?.timeout_ms;
        if (stepTimeoutMs !== undefined && fileParseLimits.pdfParseTimeoutMs >= stepTimeoutMs) {
          rolloutError(
            `rollout.file.parse is invalid: pdfParseTimeoutMs (${fileParseLimits.pdfParseTimeoutMs}) ` +
              `must stay UNDER the compiled parse step's ${stepTimeoutMs} ms timeout_policy ` +
              `(step '${step.id}' of workflow '${wf.id}') — at/above it the generic engine timeout ` +
              "preempts the typed 'pdf_parse_timeout' failure (fail-closed at compose).",
          );
        }
      }
    }
  }

  const dispatcher = new WorkflowEventDispatcher({
    tenantId: rollout.tenantId,
    enqueuer: rollout.enqueuer,
    // EVERY registration carries an EXPLICIT descriptor-derived idempotencyKeyForEvent (single-flight by
    // construction — never the dispatcher's implicit default). Audio stays byte-identical:
    // `session_id:<id>:finalized` (test-pinned; live run identity).
    triggers: [...workflows.values()].map((workflow) =>
      triggerRegistrationForWorkflow(workflow, eventDescriptors),
    ),
  });
  // ── 5a. audio capability mount — CONDITIONAL on declaration ───────────────────────────────────
  // The audio mount (stores/routes/handlers/media) joins the composition iff the doc declares
  // `audio_input`/`media_playback`; a non-audio doc mounts NOTHING audio-shaped (no stores, no
  // routes, no handlers, no `session_finalized` trigger vocabulary). A doc that declares audio
  // mounts exactly as before — byte-identical (the compose golden). The sink + the declared-
  // track narrowing are audio-only, so they live inside the guard.
  let audio: MountedAudioCapability | undefined;
  if (withAudio) {
    const sink: SessionFinalizedSink = new WorkflowIngressSessionFinalizedSink({
      ingress: dispatcher,
      tenantId: rollout.tenantId,
    });
    // The DECLARED track vocabulary narrows the audio capability's accepted lanes:
    // `grounding.attribution_policy.tracks` names the product's tracks (e.g. mic/system),
    // and the audio capability's neutral default (`DEFAULT_TRACK_ID_RE`) would otherwise
    // accept ANY well-formed track id. Worse than a loose contract, an accepted junk track
    // becomes a SEALED track the
    // `stt.transcribe_session` node re-reads as authoritative, so one junk-track chunk POISONS the
    // session's single-flight durable run (terminal failure — the session never processes). The
    // declaration is the source of truth; an explicit `rollout.audio.capability.allowedTracks` still
    // wins; a document without an attribution policy keeps the neutral default.
    const declaredTracks = Object.keys(spec.grounding?.attribution_policy?.tracks ?? {});
    audio = mountAudioCapability({
      sessionFinalizedSink: sink,
      ...(rollout.audio?.basePath !== undefined ? { basePath: rollout.audio.basePath } : {}),
      capability: {
        ...(declaredTracks.length > 0 ? { allowedTracks: declaredTracks } : {}),
        ...(rollout.audio?.capability ?? {}),
      },
    });
  }

  // ── 5b. the record (submit-ingress) capability mount — CONDITIONAL on declaration ────────────
  // The sink is the SAME tenant-bound dispatcher the audio sink feeds (one ingress, one single-flight
  // authority), behind the record bridge's fail-closed cross-tenant assertion. A doc that does not
  // declare `record_input` mounts NOTHING record-shaped (no store, no route, no handler, no
  // trigger vocabulary — the conditional-mount law this establishes; audio follows the same law).
  //
  // DELIBERATE: a `rollout.record` supplied WITHOUT the doc declaring `record_input`
  // is silently unused — the DECLARATION is the mount authority, rollout blocks are deployment-
  // side OPTIONS for whatever the doc mounts (the audio mirror: `rollout.audio` is likewise only
  // consumed by the audio mount). This is the single-deployment-tenant beta posture's static
  // wiring — a deployment's rollout config may legitimately carry options for capabilities its
  // CURRENT doc revision does not declare (e.g. across an update boot), so an unused block is not
  // an error. compose is a pure function with no warn channel; if that changes, a loud
  // rollout-block-without-declaration notice belongs here.
  // A declared input-normalize step transforms each submitted record via an agent before persist, so a
  // normalize-declaring doc REQUIRES a wired normalizer factory (the declared-agents executor-coverage
  // mirror, step 4 above): composing the submit surface without one would mount a route that 502s at
  // request time — fail-closed at compose instead (deploy-time loud).
  const recordNormalizeDecl = withRecordInput
    ? spec.capabilities.find((c) => c.id === RECORD_INPUT_CAPABILITY_ID)?.input_normalize
    : undefined;
  if (recordNormalizeDecl && rollout.record?.normalizer === undefined) {
    rolloutError(
      "the record_input capability declares 'input_normalize' but rollout.record.normalizer is " +
        `absent — a submitted record is transformed by the declared agent '${recordNormalizeDecl.agent}' ` +
        'before persist (production: makeLiveRecordNormalizer over the neutral agent path; dev/tests: ' +
        'the deterministic injection seam). Fail-closed.',
    );
  }
  const record: MountedRecordCapability | undefined = withRecordInput
    ? mountRecordCapability({
        recordSubmittedSink: new WorkflowIngressRecordSubmittedSink({
          ingress: dispatcher,
          tenantId: rollout.tenantId,
        }),
        ...(rollout.record?.basePath !== undefined ? { basePath: rollout.record.basePath } : {}),
        ...(rollout.record?.capability !== undefined
          ? { capability: rollout.record.capability }
          : {}),
        // Wire the normalizer iff the doc declares input_normalize AND the deployment supplied one (the
        // fail-closed guard above guarantees a declaration has a matching factory here).
        ...(recordNormalizeDecl && rollout.record?.normalizer !== undefined
          ? { recordNormalizer: rollout.record.normalizer }
          : {}),
      })
    : undefined;

  // ── 5c. the file (byte-ingest) capability mount — CONDITIONAL on declaration ────────
  // The SAME conditional-mount law as record (5b): the sink is the SAME tenant-bound dispatcher
  // (one ingress, one single-flight authority), behind the file bridge's fail-closed cross-tenant assertion.
  // A doc that does not declare `file_input` mounts NOTHING file-shaped (no store, no routes, no
  // handlers, no trigger vocabulary). `rollout.file` is the deployment-side OPTIONS block for the
  // mount (base path + the config-override seam: byte cap / content-type allowlist); supplied
  // without the declaration it is silently unused — the silently-unused-rollout posture above applies verbatim.
  const file: MountedFileCapability | undefined = withFileInput
    ? mountFileCapability({
        fileSubmittedSink: new WorkflowIngressFileSubmittedSink({
          ingress: dispatcher,
          tenantId: rollout.tenantId,
        }),
        ...(rollout.file?.basePath !== undefined ? { basePath: rollout.file.basePath } : {}),
        ...(rollout.file?.capability !== undefined ? { capability: rollout.file.capability } : {}),
      })
    : undefined;

  // ── 5d. the conversation (conversational-ingress) capability mount — CONDITIONAL ────────
  // The SAME conditional-mount law as record/file (5b/5c): the sink is the SAME tenant-bound
  // dispatcher (one ingress, one single-flight authority), behind the conversation bridge's fail-closed
  // cross-tenant assertion. The per-TURN enqueue idempotency key derives EXPLICITLY from the
  // manifest descriptor via `triggerRegistrationForWorkflow` above (`turn_ref` →
  // `payloadFieldIdempotencyKey` — the generic format; never the dispatcher default, never
  // conversation-scoped: a conversation-scoped key would dedupe every later turn into the first
  // durable run). A doc that does not declare `conversation_input` mounts NOTHING
  // conversation-shaped (no stores, no routes, no handlers, no trigger vocabulary).
  // `rollout.conversation` is the deployment-side OPTIONS block (base path + the
  // config-override seam, compose-validated fail-closed by the real `resolveConversationConfig`);
  // supplied without the declaration it is silently unused — the silently-unused-rollout posture (5b) verbatim.
  // A conversation-declaring doc REQUIRES a wired responder (the declared-agents
  // executor-coverage mirror, step 4b above): POST .../turns produces a REAL reply, so
  // composing the surface without a responder would mount a route that 500s at request time —
  // fail-closed at compose instead (deploy-time loud).
  if (withConversationInput && rollout.conversation?.responder === undefined) {
    rolloutError(
      "the document declares 'conversation_input' but rollout.conversation.responder is absent — " +
        'a submitted turn produces a real agent reply, so the deployment must wire a turn ' +
        'responder (production: makeLiveTurnResponder over the per-product ' +
        '<agent_id>.responder.json; dev/CI: the deterministic injection seam). Fail-closed.',
    );
  }
  const conversation: MountedConversationCapability | undefined = withConversationInput
    ? mountConversationCapability({
        turnSubmittedSink: new WorkflowIngressTurnSubmittedSink({
          ingress: dispatcher,
          tenantId: rollout.tenantId,
        }),
        // Present by the fail-closed guard above (the non-null assertion is guard-established).
        turnResponder: rollout.conversation?.responder as ConversationTurnResponderFactory,
        ...(rollout.conversation?.basePath !== undefined
          ? { basePath: rollout.conversation.basePath }
          : {}),
        ...(rollout.conversation?.capability !== undefined
          ? { capability: rollout.conversation.capability }
          : {}),
      })
    : undefined;

  // ── 6. the composed store read surface + row-contract verification ───────────────────────────
  // The capability-owned prefix comes from the ONE shared `composeCapabilityStores` helper (the
  // SAME source the server boot's DDL derivation uses) — killing the boot↔compose lockstep
  // structurally: both sides now compute the capability store set (audio iff declared + record iff
  // declared) from one function, so they can never diverge on which capability stores exist. The
  // mount fragments (`audio.stores` / `record.stores`) are content-identical to it by construction
  // (each mount returns exactly its capability's `*CapabilityStores()`).
  const composedStores: StoreSpec[] = [...capabilityStores.stores, ...(rollout.stores ?? [])];
  if (usesStt && rollout.transcripts) {
    requireStoreContract(
      composedStores,
      rollout.transcripts.store,
      TRANSCRIPT_ROW_CONTRACT,
      'transcript sink',
    );
  }
  // Every DECLARED product store must be bound in the composed read surface with its declared
  // column contract (the deployment's rollout.stores normally carries them via deriveProductStores —
  // a hand-built rollout that omits one is rejected here, naming the store, never an inert mount
  // whose store steps fail at run time).
  for (const declared of spec.stores) {
    requireStoreContract(
      composedStores,
      declared.name,
      declared.columns.map((c) => [c.name, c.type] as const),
      `declared store '${declared.name}'`,
    );
  }
  // A responder's DECLARED bounded store-context read must resolve against THIS
  // deployment's composed stores (fail-closed at compose — never a turn route whose context read
  // 500s at request time). The declaration is constant across tenants; read it off a
  // deployment-tenant-bound instance. Boot-side validation owns the config SHAPE (limit bounds,
  // filter keys); this is the compose-time cross-reference the boot cannot do (it has no store set).
  if (conversation && rollout.conversation?.responder) {
    const declared = rollout.conversation.responder(rollout.tenantId).storeContext;
    if (declared) {
      // The capability-owned conversation stores are NEVER a context
      // source. The bounded history window (assemble.ts) is the ONLY sanctioned ledger read — a
      // store-context read of `conversations`/`conversation_turns` would feed OTHER conversations'
      // raw turns/titles into the model input (a cross-conversation leak class) outside the
      // history bounds. Fail-closed at compose; declare a product store instead.
      if (CONVERSATION_STORE_NAMES.has(declared.store)) {
        rolloutError(
          `the conversation responder's store-context read targets the capability-owned store ` +
            `'${declared.store}' — the conversation head/ledger stores are never a context ` +
            'source (the bounded history window is the only sanctioned ledger read; a ' +
            "store-context read there would leak other conversations' turns into the model " +
            'input). Declare a product store instead. Fail-closed.',
        );
      }
      const store = composedStores.find((s) => s.name === declared.store);
      if (!store) {
        rolloutError(
          `the conversation responder declares a store-context read of '${declared.store}', ` +
            "which is not among the deployment's composed stores — declare the store or remove " +
            'the store_context. Fail-closed.',
        );
      }
      if (
        !Number.isSafeInteger(declared.limit) ||
        declared.limit <= 0 ||
        declared.limit > STORE_READ_MAX_LIMIT
      ) {
        rolloutError(
          `the conversation responder's store-context limit (${String(declared.limit)}) must be ` +
            `a positive integer ≤ ${STORE_READ_MAX_LIMIT} (the STORE_READ cap discipline). Fail-closed.`,
        );
      }
      const cols = columnTypes(store);
      for (const [column, key] of Object.entries(declared.filter ?? {})) {
        if (!(CONTEXT_FILTER_PAYLOAD_KEYS as readonly string[]).includes(key)) {
          rolloutError(
            `the conversation responder's store-context filter maps column '${column}' to ` +
              `'${String(key)}' — only the closed turn-payload keys ` +
              `(${CONTEXT_FILTER_PAYLOAD_KEYS.join(', ')}) are addressable. Fail-closed.`,
          );
        }
        if (cols.get(column) !== 'text') {
          rolloutError(
            `the conversation responder's store-context filter column '${column}' must be a ` +
              `'text' column of store '${declared.store}' (got ${
                cols.has(column) ? `'${cols.get(column)}'` : 'no such column'
              }) — the filter values are id strings. Fail-closed.`,
          );
        }
      }
    }
  }
  const persisting = spec.artifacts.filter((a) => a.lifecycle?.persist !== false);
  if (persisting.length > 0 && spec.workflows.length > 0) {
    const scopes = [...new Set(persisting.map((a) => a.scope))];
    if (scopes.length !== 1 || typeof scopes[0] !== 'string' || scopes[0].length === 0) {
      unsupported(
        'every persisted artifact kind must declare the SAME non-empty scope (the materializer ' +
          `scopes rows by '<scope>_id'); got: ${scopes.map((s) => s ?? '(none)').join(', ')}.`,
      );
    }
    const scope = scopes[0];
    const scopeColumn = `${scope}_id`;
    // Per-event: the persist node scopes rows by the TRIGGER payload's `<scope>_id`, and
    // each persisting workflow's scope key is validated against ITS OWN trigger event's descriptor
    // `payload_keys` (the event-vocabulary registry; for the audio event that contract is coupled
    // fail-the-fix to the seam adapter's emitted payload). NEVER a union across events — a union
    // would re-admit a scope the actual triggering event cannot satisfy: every persist would fail
    // 'persist_scope_missing' at run time; rejected fail-closed at deploy instead of a green mount.
    for (const [id, wf] of workflows) {
      if (!wf.steps.some((s) => s.capability === 'artifact' && s.operation === 'persist')) continue;
      requirePersistScopeInTriggerPayload({
        workflowId: id,
        triggerEvent: wf.trigger.event,
        scope,
        persistingKinds: persisting.map((a) => a.kind),
        descriptors: eventDescriptors,
      });
    }
    for (const artifact of persisting) {
      const collection = artifact.collection;
      if (!collection) {
        unsupported(
          `artifact kind '${artifact.kind}' declares lifecycle.persist but no collection — a ` +
            'persisted kind must name its collection.',
        );
      }
      const binding = rollout.artifactCollections?.get(collection);
      if (!binding) {
        unsupported(
          `artifact collection '${collection}' (kind '${artifact.kind}') has no bound store — ` +
            'supply rollout.artifactCollections to mount this document.',
        );
      }
      requireStoreContract(
        composedStores,
        binding.store,
        [[scopeColumn, 'text'], ...COLLECTION_ROW_CONTRACT],
        `artifact collection '${collection}'`,
      );
    }
  }
  // Fail-closed, after the binds: every composed store must be accounted for by the KNOWN
  // union — the audio capability stores + the declared product stores + the bound transcript sink +
  // the bound artifact-collection stores. A stray rollout.stores entry corresponding to NOTHING
  // would otherwise MATERIALIZE as a real table no declaration owns (silent pre-fix); reject it
  // naming the stray.
  const knownStoreNames = new Set<string>([
    // The capability-owned names from the SAME shared helper that seeds composedStores.
    ...capabilityStores.names,
    ...spec.stores.map((s) => s.name),
    ...(rollout.transcripts ? [rollout.transcripts.store] : []),
    ...[...(rollout.artifactCollections?.values() ?? [])].map((b) => b.store),
  ]);
  for (const store of composedStores) {
    if (!knownStoreNames.has(store.name)) {
      rolloutError(
        `rollout.stores contains '${store.name}', which corresponds to NO declared store, artifact ` +
          'collection, transcript sink, or audio capability store — a stray store would materialize ' +
          'as a real table nothing declared (fail-closed); remove it from the rollout.',
      );
    }
  }

  // ── 7. views mount (delegates resolved per capability CONTRACT, never per product view id) ────
  const delegates = new Map<string, ViewResolvedHandler>();
  /** Views delegating the play-token capability handler (route coincidence enforced below). */
  const delegatedPlayTokenViews: Array<{ id: string; key: string }> = [];
  for (const view of spec.views) {
    if (view.source?.kind !== 'capability') continue;
    const delegate = capabilityViewDelegate(view.source.ref, audio);
    if (!delegate) {
      unsupported(
        `view '${view.id}' is sourced from capability contract '${view.source.ref}', which has no ` +
          'delegable capability handler in this composition (wired: media_playback.token).',
      );
    }
    if (view.source.ref === 'media_playback.token') {
      delegatedPlayTokenViews.push({
        id: view.id,
        key: `${view.route.method} ${view.route.path}`,
      });
    }
    delegates.set(view.id, delegate as ViewResolvedHandler);
  }
  let views: ReturnType<typeof mountProductViews>;
  try {
    views = mountProductViews({
      views: spec.views,
      contracts: spec.contracts,
      artifacts: spec.artifacts,
      capabilities: spec.capabilities,
      stores: composedStores,
      ...(rollout.artifactCollections ? { artifactBindings: rollout.artifactCollections } : {}),
      capabilityViewHandlers: delegates,
    });
  } catch (e) {
    rolloutError(
      `views mount failed against the composed read surface: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // ── 8. route ownership + handler merge (deterministic, collision-fail-closed) ────────────────
  const api: ApiRouteSpec[] = [];
  const claimedBy = new Map<string, string>(); // `METHOD path` → view handler id
  for (const route of views.api) {
    const key = `${route.method} ${route.path}`;
    api.push(route);
    if (route.action.kind === 'handler') claimedBy.set(key, route.action.handler);
  }
  for (const route of audio?.api ?? []) {
    const key = `${route.method} ${route.path}`;
    const claimingViewHandler = claimedBy.get(key);
    if (claimingViewHandler === undefined) {
      api.push(route);
      continue;
    }
    // A declared view may OWN a capability route iff it DELEGATES to the same capability handler
    // (the play-token case: the view declares the read contract; the capability code serves it).
    const audioHandlerId =
      route.action.kind === 'handler' || route.action.kind === 'stream'
        ? route.action.handler
        : undefined;
    const audioFn = audioHandlerId ? audio?.handlers.get(audioHandlerId)?.fn : undefined;
    const viewFn = views.handlers.get(claimingViewHandler)?.fn;
    if (audioFn !== undefined && audioFn === viewFn) continue; // the view route owns it
    rolloutError(
      `route collision: '${key}' is declared by both a view and the audio capability with ` +
        'DIFFERENT handlers — a route must have exactly one owner.',
    );
  }
  // The record capability's routes join the merge. NO delegation exists for a submit route (it
  // is a write, views are reads), so ANY coincidence with an already-mounted route key is a
  // fail-closed collision naming both owners — never a silent second owner.
  const mountedRouteKeys = new Set(api.map((r) => `${r.method} ${r.path}`));
  for (const route of record?.api ?? []) {
    const key = `${route.method} ${route.path}`;
    if (claimedBy.has(key) || mountedRouteKeys.has(key)) {
      rolloutError(
        `route collision: '${key}' is declared by both the record capability and another mount ` +
          '(view or audio) — a route must have exactly one owner (no delegation for a submit route).',
      );
    }
    api.push(route);
    mountedRouteKeys.add(key);
  }
  // The file capability's routes join the merge under the SAME law — NO delegation exists
  // for a byte-ingest upload or a submit route, so any coincidence with an already-mounted route
  // key is a fail-closed collision naming both owners.
  for (const route of file?.api ?? []) {
    const key = `${route.method} ${route.path}`;
    if (claimedBy.has(key) || mountedRouteKeys.has(key)) {
      rolloutError(
        `route collision: '${key}' is declared by both the file capability and another mount ` +
          '(view, audio, or record) — a route must have exactly one owner (no delegation for a ' +
          'byte-ingest route).',
      );
    }
    api.push(route);
    mountedRouteKeys.add(key);
  }
  // The conversation capability's routes join the merge under the SAME law — NO
  // delegation exists for the idempotent create or the turn submit (both are writes, views are
  // reads), so any coincidence with an already-mounted route key is a fail-closed collision
  // naming both owners.
  for (const route of conversation?.api ?? []) {
    const key = `${route.method} ${route.path}`;
    if (claimedBy.has(key) || mountedRouteKeys.has(key)) {
      rolloutError(
        `route collision: '${key}' is declared by both the conversation capability and another ` +
          'mount (view, audio, record, or file) — a route must have exactly one owner (no ' +
          'delegation for a conversational-ingress route).',
      );
    }
    api.push(route);
    mountedRouteKeys.add(key);
  }

  // The play-token surface must exist EXACTLY ONCE. The merge above dedupes on byte-equal
  // `METHOD path` keys only, so a `rollout.audio.basePath` override that moves the audio
  // capability's play-token route away from the delegated view's declared route would silently
  // DOUBLE-EXPOSE it (two mounted routes onto one capability handler). Fail-closed: when a
  // delegated play-token view exists, its route key MUST coincide with the audio capability's
  // play-token route key — a mismatch is a compose rejection naming BOTH paths, never a second route.
  const audioPlayTokenRoute = audio?.api.find(
    (r) =>
      (r.action.kind === 'handler' || r.action.kind === 'stream') &&
      r.action.handler === audio?.handlerIds.playToken,
  );
  if (audioPlayTokenRoute) {
    const audioKey = `${audioPlayTokenRoute.method} ${audioPlayTokenRoute.path}`;
    for (const v of delegatedPlayTokenViews) {
      if (v.key !== audioKey) {
        rolloutError(
          `play-token route mismatch: view '${v.id}' delegates the play-token capability handler ` +
            `at '${v.key}', but the audio capability serves it at '${audioKey}' (a ` +
            'rollout.audio.basePath override breaks the coincidence) — the delegation requires ONE ' +
            'coinciding route; refusing to mount a silent second play-token route.',
        );
      }
    }
  }

  const handlers = new Map<string, ResolvedHandler>();
  for (const [id, h] of audio?.handlers ?? []) handlers.set(id, h as ResolvedHandler);
  for (const [id, h] of record?.handlers ?? []) {
    if (handlers.has(id)) {
      rolloutError(
        `handler id collision: '${id}' is registered by both the record and audio mounts.`,
      );
    }
    handlers.set(id, h as ResolvedHandler);
  }
  for (const [id, h] of file?.handlers ?? []) {
    if (handlers.has(id)) {
      rolloutError(
        `handler id collision: '${id}' is registered by both the file and another capability mount.`,
      );
    }
    handlers.set(id, h as ResolvedHandler);
  }
  for (const [id, h] of conversation?.handlers ?? []) {
    if (handlers.has(id)) {
      rolloutError(
        `handler id collision: '${id}' is registered by both the conversation and another ` +
          'capability mount.',
      );
    }
    handlers.set(id, h as ResolvedHandler);
  }
  for (const [id, h] of views.handlers) {
    if (handlers.has(id)) {
      rolloutError(
        `handler id collision: '${id}' is registered by both the views and a capability mount.`,
      );
    }
    handlers.set(id, h as ResolvedHandler);
  }

  // ── 9. the engine spec the SHARED deploy pipeline consumes ────────────────────────────────────
  // A NEUTRAL spec builder (no audio coupling) over composedStores + the ownership-merged route
  // set. Store order == composedStores (capability stores when declared + rollout stores) — the boot
  // path's DDL derives the SAME order via composeCapabilityStores. For an audio-declaring doc this is byte-identical
  // to the earlier `buildAudioCapabilitySpec` output (which only ever contributed `audio.stores`,
  // already inside composedStores, plus the same empty 0.1 arrays); pinned by the compose golden.
  const engineSpec: RaySpec = buildProductEngineSpec(composedStores, api, {
    name: `product:${spec.product.id}`,
    ...(spec.product.description !== undefined ? { description: spec.product.description } : {}),
  });

  // ── 10. the tenant-bound node registry builder (the DBOS resolveWorkflowRun seam) ────────────
  const buildNodeRegistry = (bindings: NodeRegistryBindings): CapabilityRegistry => {
    const registry = new CapabilityRegistry();
    const db = makeHandlerDb(bindings.tdb, bindings.productTables);
    // The FAIL-SOFT media-prep hook: build a per-run tenant-bound blob context and
    // prepare each finalized track's playable artifact. A remux failure surfaces as a typed
    // err(media_prep_failed) — `makeFailSoftMediaPrep` INSPECTS the result and LOGS it loudly
    // (a broken ffmpeg must be operator-visible), then swallows it (play-token stays not_ready_409);
    // a genuine throw propagates to the STT node's own catch-and-log. Media prep never poisons extraction.
    const mediaPrepBlob = rollout.mediaPrep?.blob;
    const mediaPrep = mediaPrepBlob
      ? makeFailSoftMediaPrep({
          prepareTrackMedia,
          ctx: {
            tenantId: bindings.tenantId,
            db,
            config: resolveConfig(),
            blob: mediaPrepBlob(bindings.tenantId),
          },
        })
      : undefined;
    if (rollout.stt && rollout.transcripts) {
      registry.register(
        'stt.transcribe_session',
        makeSttTranscribeSessionNode({
          spec,
          adapter: rollout.stt.adapter,
          db,
          tenantId: bindings.tenantId,
          transcriptStore: rollout.transcripts.store,
          ...(mediaPrep ? { mediaPrep } : {}),
        }),
      );
    }
    if (rollout.liveAgent) {
      // The LIVE extraction node is built PER RUN AND PER AGENT — `buildNodeForAgent` closes over
      // this run's tenant-bound db (so `runAgent` journals usage/cost under the run's tenant, ledger
      // 1.2) AND the declared agent id, so a multi-agent / multi-backend deployment registers a
      // DISTINCT node — its own backend + config — for EACH declared agent (not one shared node).
      const buildFor = rollout.liveAgent.buildNodeForAgent;
      for (const extractor of spec.extractors) {
        registry.register(
          `agent.${extractor.id}`,
          buildFor(extractor.id, { tdb: bindings.tdb, tenantId: bindings.tenantId }),
        );
      }
    } else if (rollout.agents) {
      const agentNode = makeDeclaredAgentNode(rollout.agents);
      for (const extractor of spec.extractors)
        registry.register(`agent.${extractor.id}`, agentNode);
    }
    if (spec.grounding) registry.register('grounding.check', makeGroundingPolicyNode(spec));
    registry.register('validation.check', makeShapeValidationNode(spec));
    const artifactStore = new TenantDbArtifactStore(bindings.tdb);
    registry.register(
      'artifact.persist',
      makeArtifactPersistNode({
        spec,
        db,
        tenantId: bindings.tenantId,
        collectionStores: rollout.artifactCollections ?? new Map(),
        artifactStore,
      }),
    );
    registry.register('artifact.read', createArtifactReadHandler({ store: artifactStore }));
    // The declared-store step runtime — two tenant-bound nodes over the SAME makeHandlerDb
    // facade (fail-closed on undeclared stores/columns; store.write = db.upsert EXCLUSIVELY on the
    // store's declared conflict key — the single-flight/at-least-once law; see store-nodes.ts).
    registry.register('store.read', makeStoreReadNode({ spec, db }));
    registry.register('store.write', makeStoreWriteNode({ spec, db }));
    // The durable blob→text parse node, per-run TENANT-BOUND through the deployment's
    // blob-reader factory (the mediaPrep.blob mirror) — registered in LOCKSTEP with the
    // registeredOps cross-check below (withFileInput + rollout.file.blob), so a compiled
    // parse_text step can never come up capability_unavailable at run time.
    const fileBlob = rollout.file?.blob;
    if (withFileInput && fileBlob) {
      registry.register(
        'file_input.parse_text',
        makeFileParseNode({
          blob: fileBlob(bindings.tenantId),
          ...(fileParseLimits ? { limits: fileParseLimits } : {}),
        }),
      );
    }
    return registry;
  };

  // Fail-closed cross-check: every compiled step operation must have a registered node — a compiled
  // op that would come up `capability_unavailable` at RUN time is a DEPLOY error, caught here.
  const registeredOps = new Set<string>([
    ...(rollout.stt && rollout.transcripts ? ['stt.transcribe_session'] : []),
    ...(rollout.agents || rollout.liveAgent ? spec.extractors.map((a) => `agent.${a.id}`) : []),
    ...(spec.grounding ? ['grounding.check'] : []),
    'validation.check',
    'artifact.persist',
    'artifact.read',
    'store.read',
    'store.write',
    // Mirrors the buildNodeRegistry registration condition EXACTLY (declared file_input +
    // a supplied blob reader) — the specific pre-check above already named the actionable fix.
    ...(withFileInput && rollout.file?.blob ? ['file_input.parse_text'] : []),
  ]);
  for (const [id, wf] of workflows) {
    for (const step of wf.steps) {
      const op = `${step.capability}.${step.operation}`;
      if (!registeredOps.has(op)) {
        unsupported(
          `workflow '${id}' step '${step.id}' uses operation '${op}', which has no wired node in ` +
            'this composition — the run would fail capability_unavailable; rejected at deploy instead.',
        );
      }
    }
  }

  return {
    product: spec,
    engineSpec,
    handlers,
    workflows,
    buildNodeRegistry,
    triggerEvents: dispatcher.triggerEvents,
    viewRoutes: views.api.map((r) => `${r.method} ${r.path}`),
    ingress: dispatcher,
  };
}
