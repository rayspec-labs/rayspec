/**
 * The capability mount helper (the audio/record `rayspec/mount.ts` pattern) — turn the capability
 * into the declarative fragments a RaySpec deployment mounts: the neutral `stores[]`, the TWO
 * authenticated routes (the raw-byte PUT upload as a `{kind:'stream', mode:'ingest'}` route + the
 * JSON POST submit as a `{kind:'handler'}` route — behind the SAME auth/tenancy chain every route
 * uses; the stream interpreter gates ingest on `store:write` exactly like the audio capability),
 * and the resolved handler map the engine dispatches. ADDITIVE composition only — no kill-set file
 * is touched; a deployment supplies a mount base path + the event sink and gets a fully-wired
 * file-ingest capability.
 */
import type { RouteHandler } from '@rayspec/handler-sdk';
import type { ApiRouteSpec, StoreSpec } from '@rayspec/spec';
import { type FileCapabilityConfig, resolveFileConfig } from '../config.js';
import type { FileSubmittedSink } from '../events.js';
import { FILE_SUBMIT_ROUTE_SUBPATH, FILE_UPLOAD_ROUTE_SUBPATH } from '../manifest.js';
import { fileCapabilityStores } from '../stores.js';
import {
  type FileHandlersConfig,
  makeFileSubmitHandler,
  makeFileUploadHandler,
} from './handlers.js';

/** The stable handler ids the capability registers (neutral; override only if a product must). */
export interface FileHandlerIds {
  readonly fileUpload: string;
  readonly fileSubmit: string;
}

export const DEFAULT_FILE_HANDLER_IDS: FileHandlerIds = {
  fileUpload: 'file_input_upload',
  fileSubmit: 'file_input_submit',
};

/** The default route mount base path. */
export const DEFAULT_FILE_BASE_PATH = '/files';

export interface FileCapabilityMountConfig {
  /** The route mount base path (default `/files`). No trailing slash. */
  readonly basePath?: string;
  /** Core capability config (file-id shape, byte cap, content-type allowlist). */
  readonly capability?: FileCapabilityConfig;
  /** The sink `submit` emits `file_submitted` through — the workflow-ingress event seam. */
  readonly fileSubmittedSink: FileSubmittedSink;
  /** Override the registered handler ids (rarely needed). */
  readonly handlerIds?: Partial<FileHandlerIds>;
}

/** A resolved handler entry — always `route`-kind (a stream handler is a route-kind handler). */
export interface FileResolvedHandler {
  readonly kind: 'route';
  readonly fn: RouteHandler;
}

export interface MountedFileCapability {
  /** The capability's neutral stores (merge into the composed `stores[]`). */
  readonly stores: StoreSpec[];
  /** The capability's routes (merge into the composed `api[]`). */
  readonly api: ApiRouteSpec[];
  /** id → resolved route-kind handler (merge into the engine's resolved handler map). */
  readonly handlers: ReadonlyMap<string, FileResolvedHandler>;
  /** The resolved handler ids (defaults ⊕ overrides). */
  readonly handlerIds: FileHandlerIds;
  /** The mount base path used. */
  readonly basePath: string;
}

/**
 * Mount the file-ingest capability. Returns the declarative fragments + the resolved handler map —
 * the same `MountedAudioCapability` shape `composeProductDeploy` merges, so the composition treats
 * every capability uniformly. A stream handler's fn is stored as a `route`-kind entry (the
 * platform's loader/interpreter treats a stream handler as a route-kind handler that receives a
 * raw `Request` — the raw-vs-JSON init shape is a runtime concern, not a handler kind).
 */
export function mountFileCapability(config: FileCapabilityMountConfig): MountedFileCapability {
  const basePath = (config.basePath ?? DEFAULT_FILE_BASE_PATH).replace(/\/$/, '');
  const ids: FileHandlerIds = { ...DEFAULT_FILE_HANDLER_IDS, ...config.handlerIds };
  const resolved = resolveFileConfig(config.capability);

  const handlersConfig: FileHandlersConfig = {
    resolved,
    fileSubmittedSink: config.fileSubmittedSink,
  };

  // A stream handler is a route-kind handler at runtime; cast its typed fn into the route slot
  // (the SAME cast the platform's stream interpreter applies on invocation).
  const streamAsRoute = (fn: unknown): FileResolvedHandler => ({
    kind: 'route',
    fn: fn as RouteHandler,
  });
  const asRoute = (fn: RouteHandler): FileResolvedHandler => ({ kind: 'route', fn });

  const handlers = new Map<string, FileResolvedHandler>([
    [ids.fileUpload, streamAsRoute(makeFileUploadHandler(handlersConfig))],
    [ids.fileSubmit, asRoute(makeFileSubmitHandler(handlersConfig))],
  ]);

  const api: ApiRouteSpec[] = [
    {
      method: 'PUT',
      path: `${basePath}${FILE_UPLOAD_ROUTE_SUBPATH}`,
      action: { kind: 'stream', handler: ids.fileUpload, mode: 'ingest' },
    },
    {
      method: 'POST',
      path: `${basePath}${FILE_SUBMIT_ROUTE_SUBPATH}`,
      action: { kind: 'handler', handler: ids.fileSubmit },
    },
  ];

  return { stores: fileCapabilityStores(), api, handlers, handlerIds: ids, basePath };
}
