/**
 * @rayspec/views-runtime — the COMPOSITION MOUNT.
 *
 * `mountProductViews(config)` turns validated Product-YAML view declarations into the declarative
 * fragments a RaySpec deployment mounts — EXACTLY the `mountAudioCapability` pattern
 * (@rayspec/audio-runtime/rayspec/mount.ts): an `api[]` route set of `{ kind:'handler' }` actions
 * plus the resolved handler map the declared-routes engine dispatches. ADDITIVE composition only —
 * no kill-set file is touched; the engine's `registerDeclaredRoutes` puts every view route behind
 * the SAME ordered chain every route uses (`requireAuth → resolveTenant → requirePermission`), and
 * `invokeRouteHandler` runs the view inside `TenantDb.transaction()` with the tenant-bound,
 * name-keyed `HandlerDb` facade — so every view read carries the STRUCTURAL tenant predicate.
 *
 * NOTE (deliberate boundary): this mount produces fragments a DEPLOYMENT composes in code
 * (like the audio capability's). The Product-YAML deploy path (`deploy.ts`) keeps REJECTING
 * Product-YAML mounts — unlocking views at deploy time is a separate concern, not this module.
 *
 * FAIL-CLOSED: `compileProductViews` re-runs the parser's view lint + the mount-only read-surface
 * checks and THROWS on any violation. A `capability`-sourced view must have a DELEGATED handler
 * injected (the capability's own mount owns its behavior — e.g. a media capability's token-mint
 * route); a missing delegate aborts the mount. Nothing is ever skipped.
 */
import type { RouteHandler } from '@rayspec/handler-sdk';
import type { ApiRouteSpec, ProductViewSpec } from '@rayspec/spec';
import { compileProductViews, type ViewsCompileConfig } from './compile.js';
import { makeViewRouteHandler } from './interpret.js';

/** A resolved view handler entry — always `route`-kind (mirrors the audio capability's map shape). */
export interface ViewResolvedHandler {
  readonly kind: 'route';
  readonly fn: RouteHandler;
}

export interface ViewsMountConfig extends ViewsCompileConfig {
  /**
   * DELEGATES for `capability`-sourced views (view id → the capability-provided route handler).
   * A capability view's behavior IS capability code (e.g. a media capability's token mint) —
   * the views runtime never interprets it; it only routes it. REQUIRED for every declared
   * capability view: a missing delegate aborts the mount (never a silently-dropped route).
   */
  readonly capabilityViewHandlers?: ReadonlyMap<string, ViewResolvedHandler>;
  /** Handler-id prefix (default `view_`) — override only on a collision with other mounted ids. */
  readonly handlerIdPrefix?: string;
}

export interface MountedProductViews {
  /** The view routes (merge into the deployment spec's `api[]`). */
  readonly api: ApiRouteSpec[];
  /** id → resolved route-kind handler (pass as `engineHandlers` / the declared-routes handler map). */
  readonly handlers: ReadonlyMap<string, ViewResolvedHandler>;
  /** view id → registered handler id. */
  readonly handlerIds: ReadonlyMap<string, string>;
  /** The views that mounted (interpreted + delegated) — for docs/OpenAPI emission. */
  readonly views: readonly ProductViewSpec[];
}

export const DEFAULT_VIEW_HANDLER_ID_PREFIX = 'view_';

/**
 * Mount the declared views. Returns the declarative fragments + the resolved handler map, or THROWS
 * with the full aggregated violation list (fail-closed — a mis-declared view never mounts partially).
 */
export function mountProductViews(config: ViewsMountConfig): MountedProductViews {
  const compiled = compileProductViews(config);
  const prefix = config.handlerIdPrefix ?? DEFAULT_VIEW_HANDLER_ID_PREFIX;

  const api: ApiRouteSpec[] = [];
  const handlers = new Map<string, ViewResolvedHandler>();
  const handlerIds = new Map<string, string>();
  const mounted: ProductViewSpec[] = [];
  const errors: string[] = [];

  for (const c of compiled.interpreted) {
    const handlerId = `${prefix}${c.view.id}`;
    handlers.set(handlerId, { kind: 'route', fn: makeViewRouteHandler(c, compiled.stores) });
    handlerIds.set(c.view.id, handlerId);
    api.push({
      method: c.view.route.method,
      path: c.view.route.path,
      action: { kind: 'handler', handler: handlerId },
    });
    mounted.push(c.view);
  }

  for (const view of compiled.delegated) {
    const delegate = config.capabilityViewHandlers?.get(view.id);
    if (!delegate) {
      errors.push(
        `view '${view.id}' is capability-sourced ('${view.source?.ref}') but no delegated handler ` +
          'was injected (capabilityViewHandlers) — a capability view routes capability code; the ' +
          'mount is fail-closed, never a silently-dropped route',
      );
      continue;
    }
    const handlerId = `${prefix}${view.id}`;
    handlers.set(handlerId, delegate);
    handlerIds.set(view.id, handlerId);
    api.push({
      method: view.route.method,
      path: view.route.path,
      action: { kind: 'handler', handler: handlerId },
    });
    mounted.push(view);
  }

  if (errors.length > 0) {
    throw new Error(
      `mountProductViews: ${errors.length} violation(s) — the mount is fail-closed:\n` +
        errors.map((e) => `  - ${e}`).join('\n'),
    );
  }

  return { api, handlers, handlerIds, views: mounted };
}
