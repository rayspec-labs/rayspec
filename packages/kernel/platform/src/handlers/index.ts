/**
 * The escape-hatch handler execution model (Option A).
 *
 * Public surface of the platform's handler mechanism — composed by the api-auth declarative engine
 * (the `{handler}` route + the declared-`agents`/`tooling` wiring) and the durable trigger
 * worker. Everything here is PRODUCT-AGNOSTIC platform mechanism; no product handler, store, or name
 * lives in platform source. The pieces:
 *
 *  - loader.ts          (a) path-jailed, fail-closed boot resolution of `handlers[]` → functions.
 *  - handler-runtime.ts (d) the SINGLE indirection every handler is invoked through (a swappable
 *                           per-tenant isolate seam) + the in-process impl + the install/restore seam.
 *  - store-facade.ts        the serializable-shaped `HandlerDb` over the real `TenantDb` chokepoint
 *                           (the engine builds the init, dispatch.ts is UNCHANGED).
 *  - resolve-tools.ts   (2) declared `tooling[]` → `NeutralTool[]` factory (per-run, tenant-bound).
 *  - route-init.ts          builders for the route/trigger `HandlerInit` (the A2 transaction-wrapped
 *                           route/trigger path).
 */
export {
  getHandlerRuntime,
  type HandlerRuntime,
  InProcessHandlerRuntime,
  type ResolvedHandler,
  setHandlerRuntime,
} from './handler-runtime.js';
export {
  defaultImporter,
  HandlerLoadError,
  jailModulePath,
  loadHandlers,
  loadHandlersMultiRoot,
  type ModuleImporter,
} from './loader.js';
export { buildToolFactory, type ToolFactory } from './resolve-tools.js';
export {
  invokeRouteHandler,
  invokeRouteHandlerDetached,
  invokeStreamRouteHandler,
  invokeTriggerHandler,
} from './route-init.js';
export { makeHandlerDb } from './store-facade.js';
