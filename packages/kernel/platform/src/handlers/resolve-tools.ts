/**
 * Declared-`tooling` → `NeutralTool` resolver (the tool-resolution site).
 *
 * Builds the `NeutralTool[]` the EXISTING `makeDispatchTool` chokepoint runs — from the spec's
 * `tooling[]` + the boot-loaded escape-hatch handlers. dispatch.ts stays BYTE-UNCHANGED: it still
 * calls `tool.handler(rawArgs, signal)` with NO db/ctx. The NEW code is HERE, where the
 * `NeutralTool` is built — the new code lives in the resolver that builds the NeutralTool,
 * not in the chokepoint.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The handler gets its TenantDb via the engine-built `HandlerInit`, NOT from dispatchTool.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * dispatchTool calls `tool.handler(rawArgs, signal)`. An escape-hatch tool handler, however, has the
 * SDK signature `(args, init: ToolHandlerInit) => data`. The resolver BRIDGES them: it wraps the
 * escape-hatch fn in a `(rawArgs, signal) => ...` closure that, when dispatchTool invokes it,
 *   1. builds the `ToolHandlerInit` (the per-RUN, per-TENANT `HandlerDb` facade over the run's
 *      TenantDb + the declared product tables — store-facade.ts), and
 *   2. invokes the handler through the SINGLE `HandlerRuntime` indirection (handler-runtime.ts) so
 *      a future isolate impl can swap in with zero handler/spec change.
 * The closure RETURNS the handler's neutral data unchanged; dispatchTool then validates it against
 * the tool's `outputSchema`, opaque-wraps it, and journals one step — all UNCHANGED.
 *
 * TRANSACTION BOUNDARY: a tool handler gets NO implicit outer transaction (the `HandlerDb` is
 * built over a plain `TenantDb`). A tool needing atomicity calls `init.db.transaction(...)` itself.
 * This is intentional: an agent fires several tools in parallel under the dispatch Semaphore, so an
 * implicit wrapping tx would hold a DB connection open across model latency.
 *
 * PER-RUN BINDING: the `HandlerDb` closes over a TENANT-bound `TenantDb`, so `NeutralTool`s cannot be
 * static — they are built PER RUN from the run's tenant. This module exports a FACTORY
 * (`buildToolFactory`) the run surface calls with the run's `TenantDb` to produce the run's tools.
 */
import type { NeutralTool } from '@rayspec/core';
import type { TenantDb } from '@rayspec/db';
import type {
  BlobStoreFactory,
  FsSourceFactory,
  ToolHandler,
  ToolHandlerInit,
} from '@rayspec/handler-sdk';
import type { RaySpec, ToolSpecConfig } from '@rayspec/spec';
import type { PgTable } from 'drizzle-orm/pg-core';
import { getHandlerRuntime, type ResolvedHandler } from './handler-runtime.js';
import { makeHandlerDb } from './store-facade.js';

/** A factory that builds the run's `NeutralTool[]` from the run's tenant-bound `TenantDb`. */
export type ToolFactory = (tdb: TenantDb) => NeutralTool[];

/**
 * Build ONE `NeutralTool` from a declared tool + its resolved escape-hatch handler + the run's
 * tenant-bound `TenantDb`. The handler is invoked through the `HandlerRuntime` single indirection
 * with an engine-built `ToolHandlerInit` (per-run `HandlerDb` over the run's tenant).
 *
 * An OPTIONAL `blobFactory` adds `init.blob` — the tenant-bound blob capability, built
 * per run via `blobFactory(tdb.tenantId)` so the handle is bound to the run's SERVER-DERIVED tenant
 * (the run's `TenantDb.tenantId`, NEVER a tool/arg-supplied value) — EXACTLY as `invokeRouteHandler`
 * builds a route handler's `init.blob`. Omitted ⇒ `init.blob` is ABSENT (a stores/api-only deploy
 * wires no blob backend; a tool that needs it then fail-closes loudly on `undefined`, like a route).
 *
 * An OPTIONAL `fsSourceFactory` adds `init.fsSource` — the READ-ONLY, path-jailed local-file reader,
 * built per run via `fsSourceFactory()` (no tenant argument: the source root is a shared, deployment-
 * static read root, jailed by construction). Omitted ⇒ `init.fsSource` is ABSENT (no source root
 * configured; a tool that needs it fail-closes loudly on `undefined`, like `init.blob`).
 */
function buildNeutralTool(
  tool: ToolSpecConfig,
  fn: ToolHandler,
  tdb: TenantDb,
  productTables: ReadonlyMap<string, PgTable>,
  blobFactory?: BlobStoreFactory,
  fsSourceFactory?: FsSourceFactory,
): NeutralTool {
  return {
    spec: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as Record<string, unknown>,
    },
    // dispatchTool calls THIS with (rawArgs, signal) — UNCHANGED chokepoint contract. We build the
    // per-run init here and route through the single HandlerRuntime indirection (swappable).
    handler: async (rawArgs: unknown): Promise<unknown> => {
      const init: ToolHandlerInit = {
        tenantId: tdb.tenantId,
        db: makeHandlerDb(tdb, productTables),
        // The tenant-bound blob handle, built from the run's SERVER-DERIVED tenant. Spread so
        // the field is ABSENT (not `undefined`) when no factory is injected — keeping the init shape
        // exact. Mirrors invokeRouteHandler exactly (same factory, same server-derived tenant).
        ...(blobFactory ? { blob: blobFactory(tdb.tenantId) } : {}),
        // The READ-ONLY, path-jailed fs-source handle (shared deployment-static root, no tenant arg).
        // Spread so ABSENT when no source root is configured — keeping the init shape exact.
        ...(fsSourceFactory ? { fsSource: fsSourceFactory() } : {}),
      };
      return getHandlerRuntime().invokeTool(fn, rawArgs, init);
    },
    // The tool's input contract: the declared `parameters` JSON-Schema (validate-in in dispatchTool).
    inputSchema: tool.parameters as Record<string, unknown>,
    // The optional output contract (validate-out + cached-replay re-validation in dispatchTool).
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
    timeoutMs: tool.timeoutMs,
    // The REQUIRED, reviewed replay-safety declaration (the whole dispatchTool replay contract keys
    // off this one author-supplied boolean — no platform-side verification, by design).
    idempotent: tool.idempotent,
  };
}

/**
 * Build the run's tool factory for the tools an agent references. Resolves each tool id in
 * `toolIds` against the spec's `tooling[]` + the boot-loaded handlers, fail-closed (an unresolved
 * tool/handler aborts the BOOT here, never a runtime 500). The returned factory is called per run
 * with the run's `TenantDb` to produce the `NeutralTool[]`.
 *
 * @param spec          the validated RaySpec (its `tooling[]` is the source of the tool defs).
 * @param handlers      the boot-loaded id → ResolvedHandler map (loader.ts).
 * @param productTables declared store name → runtime PgTable (for the per-run HandlerDb facade).
 * @param toolIds       the tool ids the agent references (agents[].tools) — empty ⇒ a no-tool factory.
 * @param blobFactory   OPTIONAL composition-root `BlobStoreFactory` — when wired, each
 *                      tool init carries `init.blob` bound to the run's server-derived tenant; absent
 *                      on a no-blob-backend deploy (the tool's `init.blob` is then undefined).
 * @param fsSourceFactory OPTIONAL composition-root `FsSourceFactory` — when wired, each tool init
 *                      carries `init.fsSource` (the READ-ONLY, path-jailed local-file reader over the
 *                      deployment's shared source root); absent on a no-source-root deploy.
 */
export function buildToolFactory(
  spec: RaySpec,
  handlers: ReadonlyMap<string, ResolvedHandler>,
  productTables: ReadonlyMap<string, PgTable>,
  toolIds: readonly string[],
  blobFactory?: BlobStoreFactory,
  fsSourceFactory?: FsSourceFactory,
): ToolFactory {
  const toolById = new Map(spec.tooling.map((t) => [t.id, t]));

  // Resolve + validate every referenced tool ONCE at boot (fail-closed), capturing the tool def + fn.
  const resolved: Array<{ tool: ToolSpecConfig; fn: ToolHandler }> = [];
  for (const toolId of toolIds) {
    const tool = toolById.get(toolId);
    if (!tool) {
      // lint resolves agents[].tools against tooling[], so this only fires on a code-built spec.
      throw new Error(`buildToolFactory: agent references undeclared tool '${toolId}'.`);
    }
    const handler = handlers.get(tool.handler);
    if (!handler) {
      throw new Error(
        `buildToolFactory: tool '${tool.id}' references unloaded handler '${tool.handler}' — the ` +
          'handler loader must have resolved it at boot (fail-closed).',
      );
    }
    if (handler.kind !== 'tool') {
      // lint also enforces tool→tool-kind, so this is the defense-in-depth boot guard.
      throw new Error(
        `buildToolFactory: tool '${tool.id}' references handler '${tool.handler}' of kind ` +
          `'${handler.kind}', expected 'tool' (fail-closed).`,
      );
    }
    resolved.push({ tool, fn: handler.fn as ToolHandler });
  }

  return (tdb: TenantDb): NeutralTool[] =>
    resolved.map(({ tool, fn }) =>
      buildNeutralTool(tool, fn, tdb, productTables, blobFactory, fsSourceFactory),
    );
}
