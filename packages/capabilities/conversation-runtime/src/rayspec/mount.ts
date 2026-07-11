/**
 * The capability mount helper (the record/file `rayspec/mount.ts` pattern) — turn the capability
 * into the declarative fragments a RaySpec deployment mounts: the neutral `stores[]`, the TWO
 * authenticated routes (the PUT idempotent create + the POST turn submit, both plain
 * `{kind:'handler'}` JSON routes — behind the SAME auth/tenancy chain every route uses), and the
 * resolved handler map the engine dispatches. ADDITIVE composition only — no kill-set file is
 * touched; a deployment supplies a mount base path + the event sink and gets a fully-wired
 * conversational-ingress capability. (S1 ships the fragments UNMOUNTED; the conditional compose
 * mount is S2.)
 */
import type { RouteHandler } from '@rayspec/handler-sdk';
import type { ApiRouteSpec, StoreSpec } from '@rayspec/spec';
import { type ConversationCapabilityConfig, resolveConversationConfig } from '../config.js';
import type { TurnSubmittedSink } from '../events.js';
import { CONVERSATION_CREATE_ROUTE_SUBPATH, TURN_SUBMIT_ROUTE_SUBPATH } from '../manifest.js';
import type { ConversationTurnResponderFactory } from '../responder.js';
import { conversationCapabilityStores } from '../stores.js';
import {
  type ConversationHandlersConfig,
  makeConversationCreateHandler,
  makeTurnSubmitHandler,
} from './handlers.js';

/** The stable handler ids the capability registers (neutral; override only if a product must). */
export interface ConversationHandlerIds {
  readonly conversationCreate: string;
  readonly turnSubmit: string;
}

export const DEFAULT_CONVERSATION_HANDLER_IDS: ConversationHandlerIds = {
  conversationCreate: 'conversation_input_create',
  turnSubmit: 'conversation_input_turn_submit',
};

/** The default route mount base path. */
export const DEFAULT_CONVERSATION_BASE_PATH = '/conversations';

export interface ConversationCapabilityMountConfig {
  /** The route mount base path (default `/conversations`). No trailing slash. */
  readonly basePath?: string;
  /** Core capability config (id shapes, message byte cap, history window bounds). */
  readonly capability?: ConversationCapabilityConfig;
  /** The sink turn-submit emits `turn_submitted` through — the workflow-ingress event seam. */
  readonly turnSubmittedSink: TurnSubmittedSink;
  /**
   * The tenant-bound turn responder factory (REQUIRED — a submitted turn produces a real
   * reply). Built boot-side from the per-product `<agent_id>.responder.json`; the binding invokes
   * it per request with the SERVER-DERIVED tenant.
   */
  readonly turnResponder: ConversationTurnResponderFactory;
  /** Override the registered handler ids (rarely needed). */
  readonly handlerIds?: Partial<ConversationHandlerIds>;
}

/**
 * A resolved handler entry — always `route`-kind (both routes are plain handler routes).
 * `routeTx`: the OPTIONAL engine tx-posture flag (structurally the platform
 * `ResolvedHandler` route member's field) — set to `'handler-managed'` on the TURN-SUBMIT entry
 * only, so the engine opens no route transaction and the binding owns the three-leg choreography
 * (handlers.ts module header). The create entry stays on the default engine-tx posture.
 */
export interface ConversationResolvedHandler {
  readonly kind: 'route';
  readonly fn: RouteHandler;
  readonly routeTx?: 'handler-managed';
}

export interface MountedConversationCapability {
  /** The capability's neutral stores (merge into the composed `stores[]`). */
  readonly stores: StoreSpec[];
  /** The capability's routes (merge into the composed `api[]`). */
  readonly api: ApiRouteSpec[];
  /** id → resolved route-kind handler (merge into the engine's resolved handler map). */
  readonly handlers: ReadonlyMap<string, ConversationResolvedHandler>;
  /** The resolved handler ids (defaults ⊕ overrides). */
  readonly handlerIds: ConversationHandlerIds;
  /** The mount base path used. */
  readonly basePath: string;
}

/**
 * Mount the conversational-ingress capability. Returns the declarative fragments + the resolved
 * handler map — the same `MountedAudioCapability` shape `composeProductDeploy` merges, so the
 * composition treats every capability uniformly.
 */
export function mountConversationCapability(
  config: ConversationCapabilityMountConfig,
): MountedConversationCapability {
  const basePath = (config.basePath ?? DEFAULT_CONVERSATION_BASE_PATH).replace(/\/$/, '');
  const ids: ConversationHandlerIds = { ...DEFAULT_CONVERSATION_HANDLER_IDS, ...config.handlerIds };
  const resolved = resolveConversationConfig(config.capability);

  const handlersConfig: ConversationHandlersConfig = {
    resolved,
    turnSubmittedSink: config.turnSubmittedSink,
    turnResponder: config.turnResponder,
  };

  const asRoute = (fn: RouteHandler): ConversationResolvedHandler => ({ kind: 'route', fn });

  const handlers = new Map<string, ConversationResolvedHandler>([
    [ids.conversationCreate, asRoute(makeConversationCreateHandler(handlersConfig))],
    // The TURN route runs on the handler-managed tx posture: the engine opens NO route
    // transaction — the binding commits the intake first, runs the model with no tx held, and
    // persists the reply in its own short tx (handlers.ts module header).
    [
      ids.turnSubmit,
      { kind: 'route', fn: makeTurnSubmitHandler(handlersConfig), routeTx: 'handler-managed' },
    ],
  ]);

  const api: ApiRouteSpec[] = [
    {
      method: 'PUT',
      path: `${basePath}${CONVERSATION_CREATE_ROUTE_SUBPATH}`,
      action: { kind: 'handler', handler: ids.conversationCreate },
    },
    {
      method: 'POST',
      path: `${basePath}${TURN_SUBMIT_ROUTE_SUBPATH}`,
      action: { kind: 'handler', handler: ids.turnSubmit },
    },
  ];

  return { stores: conversationCapabilityStores(), api, handlers, handlerIds: ids, basePath };
}
