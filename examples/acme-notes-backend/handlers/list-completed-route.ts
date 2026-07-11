/**
 * Escape-hatch ROUTE handler for the neutral acme-notes backend.
 *
 * A declared `{ kind:'handler' }` route resolves this. Unlike a tool handler, a route handler runs
 * INSIDE the engine's `TenantDb.transaction()` (the GUC seam); the `HandlerDb` it receives is bound
 * to that transaction + tenant. It returns the JSON response body.
 *
 * Imports `@rayspec/handler-sdk` TYPE-ONLY (erased at runtime); this dir is in no tsconfig, so tsc
 * never compiles it, and the `gate:handler-imports` tripwire confirms it imports nothing else.
 *
 * Untrusted-content boundary: rows read from a store are DATA the handler returns as a response body — a route handler
 * does NOT call the model, so there is no path here that turns a store row into a system/user turn.
 */
import type { RouteHandler, RouteHandlerInit } from '@rayspec/handler-sdk';

/**
 * List this tenant's COMPLETED notebooks (a read, returned as DATA). Demonstrates the route-handler
 * path: tenant-scoped store access inside a transaction, returning neutral JSON. The `?limit` query
 * param (if present) bounds the result client-side (params are DATA — server-parsed strings).
 */
export const listCompleted: RouteHandler = async (init: RouteHandlerInit) => {
  const rows = await init.db.select('notebooks', { completed: true });
  const limit = init.params.limit ? Number.parseInt(init.params.limit, 10) : undefined;
  const items = limit && Number.isFinite(limit) ? rows.slice(0, limit) : rows;
  return { count: items.length, notebooks: items };
};
