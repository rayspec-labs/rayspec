/**
 * The capability mount helper (the audio `rayspec/mount.ts` pattern) — turn the capability into
 * the declarative fragments a RaySpec deployment mounts: the neutral `stores[]`, the ONE
 * authenticated POST submit route (behind the SAME auth/tenancy chain every route uses), and the
 * resolved handler map the engine dispatches. ADDITIVE composition only — no kill-set file is
 * touched; a deployment supplies a mount base path + the event sink and gets a fully-wired
 * submit-ingress capability.
 */
import type { RouteHandler } from '@rayspec/handler-sdk';
import type { ApiRouteSpec, StoreSpec } from '@rayspec/spec';
import { type RecordCapabilityConfig, resolveRecordConfig } from '../config.js';
import type { RecordSubmittedSink } from '../events.js';
import { recordCapabilityStores } from '../stores.js';
import { makeRecordSubmitHandler, type RecordHandlersConfig } from './handlers.js';

/** The stable handler id the capability registers (neutral; override only if a product must). */
export interface RecordHandlerIds {
  readonly recordSubmit: string;
}

export const DEFAULT_RECORD_HANDLER_IDS: RecordHandlerIds = {
  recordSubmit: 'record_input_submit',
};

/** The default route mount base path. */
export const DEFAULT_RECORD_BASE_PATH = '/records';

export interface RecordCapabilityMountConfig {
  /** The route mount base path (default `/records`). No trailing slash. */
  readonly basePath?: string;
  /** Core capability config (record-id shape, payload byte cap). */
  readonly capability?: RecordCapabilityConfig;
  /** The sink `submit` emits `record_submitted` through — the workflow-ingress event seam. */
  readonly recordSubmittedSink: RecordSubmittedSink;
  /** Override the registered handler ids (rarely needed). */
  readonly handlerIds?: Partial<RecordHandlerIds>;
}

/** A resolved handler entry — always `route`-kind (this capability mounts no stream routes). */
export interface RecordResolvedHandler {
  readonly kind: 'route';
  readonly fn: RouteHandler;
}

export interface MountedRecordCapability {
  /** The capability's neutral stores (merge into the composed `stores[]`). */
  readonly stores: StoreSpec[];
  /** The capability's routes (merge into the composed `api[]`). */
  readonly api: ApiRouteSpec[];
  /** id → resolved route-kind handler (merge into the engine's resolved handler map). */
  readonly handlers: ReadonlyMap<string, RecordResolvedHandler>;
  /** The resolved handler ids (defaults ⊕ overrides). */
  readonly handlerIds: RecordHandlerIds;
  /** The mount base path used. */
  readonly basePath: string;
}

/**
 * Mount the submit-ingress capability. Returns the declarative fragments + the resolved handler
 * map — the same `MountedAudioCapability` shape `composeProductDeploy` merges, so the composition
 * treats both capabilities uniformly.
 */
export function mountRecordCapability(
  config: RecordCapabilityMountConfig,
): MountedRecordCapability {
  const basePath = (config.basePath ?? DEFAULT_RECORD_BASE_PATH).replace(/\/$/, '');
  const ids: RecordHandlerIds = { ...DEFAULT_RECORD_HANDLER_IDS, ...config.handlerIds };
  const resolved = resolveRecordConfig(config.capability);

  const handlersConfig: RecordHandlersConfig = {
    resolved,
    recordSubmittedSink: config.recordSubmittedSink,
  };

  const handlers = new Map<string, RecordResolvedHandler>([
    [ids.recordSubmit, { kind: 'route', fn: makeRecordSubmitHandler(handlersConfig) }],
  ]);

  const api: ApiRouteSpec[] = [
    {
      method: 'POST',
      path: `${basePath}/{record_id}/submit`,
      action: { kind: 'handler', handler: ids.recordSubmit },
    },
  ];

  return { stores: recordCapabilityStores(), api, handlers, handlerIds: ids, basePath };
}
