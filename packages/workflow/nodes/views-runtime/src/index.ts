/**
 * @rayspec/views-runtime — the declarative view INTERPRETER.
 *
 * Turns validated Product-YAML view declarations into a mountable route surface: compile-verified
 * against the deployment's read surface (fail-closed), interpreted read-only through the
 * tenant-bound `HandlerDb` facade over the real `TenantDb` chokepoint, composition-homed exactly
 * like the platform's Tier-B capability mounts. PRODUCT-NEUTRAL: no product-specific or provider
 * concept appears anywhere in this package — product shapes live in the declarations (and test
 * fixtures); a scan test enforces the invariant.
 *
 *   - compile.ts   — mount-time validation (re-runs the parser's view lint + read-surface checks).
 *   - interpret.ts — the request-time interpreter (params → read → projection → DTO/ETag/absent).
 *   - mount.ts     — `mountProductViews` (api[] fragments + the resolved handler map).
 *   - openapi.ts   — `emitProductViewsOpenApi` (the inspectable API-contract document).
 */
export {
  type ArtifactBinding,
  buildStoreIndex,
  type CompiledProductViews,
  type CompiledView,
  compileProductViews,
  DEFAULT_AUTH_POLICIES,
  DEFAULT_AUTH_POLICY_ENFORCEMENT,
  type StoreIndex,
  type ViewAuthEnforcement,
  type ViewsCompileConfig,
} from './compile.js';
export { makeViewRouteHandler } from './interpret.js';
export {
  DEFAULT_VIEW_HANDLER_ID_PREFIX,
  type MountedProductViews,
  mountProductViews,
  type ViewResolvedHandler,
  type ViewsMountConfig,
} from './mount.js';
export {
  emitProductViewsOpenApi,
  producibleViewResponseStatuses,
  type ViewsOpenApiDocument,
} from './openapi.js';
