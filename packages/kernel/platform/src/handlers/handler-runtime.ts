/**
 * HandlerRuntime — the SINGLE named indirection through which EVERY escape-hatch handler is
 * invoked (the load-bearing design, reserved-not-built).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE SEAM (why this exists).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A handler runs IN OUR PROCESS (the `InProcessHandlerRuntime` below — the ONE implementation
 * that exists today). The external-exposure per-tenant sandbox is a SECOND implementation of this SAME
 * interface (an isolate / worker / subprocess) — added WITHOUT changing a single handler or spec,
 * because:
 *   - a handler receives only a capability-scoped, SERIALIZABLE-shaped `HandlerInit` (name-keyed
 *     store access + plain rows — see @rayspec/handler-sdk), and
 *   - a handler returns only neutral data,
 * so an in-process call can become a cross-isolate call with no contract change. Adding the sandbox
 * is a second `HandlerRuntime`, NOT a re-architecture.
 *
 * ONE CALL SITE: every handler invocation in the platform funnels through `getHandlerRuntime().invoke(...)`.
 * The seam-works acceptance test installs a SECOND no-op `HandlerRuntime` via `setHandlerRuntime`
 * and asserts that BOTH a tool dispatch AND a route/trigger invocation route through that one
 * runtime — proving there is exactly one call site to swap for the isolate.
 *
 * SEAM SCOPE (honest): the `HandlerInit` is serializable-SHAPED (name-keyed db calls +
 * plain rows) so the in-process call becomes a cross-isolate call with no handler change — with ONE
 * exception: `HandlerInit.db.transaction(fn)` takes a CLOSURE callback, which does not cross an
 * isolate boundary by serialization. The cross-isolate TRANSACTION model is therefore an isolate design
 * point (an explicit begin/commit protocol, or running the whole handler inside one isolate-side tx);
 * do NOT claim the transaction path is already isolate-ready. The single-call-site seam itself IS
 * complete — the isolate swaps the runtime here; the transaction marshalling is the open sub-problem.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TRUSTED-AUTHOR, NOT SANDBOXED (binding posture).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `InProcessHandlerRuntime` simply CALLS the handler function in our process. The capability
 * scoping on `HandlerInit` is a DECLARATION + INJECTION SEAM — it is **cosmetic as ENFORCEMENT**:
 * the in-process handler can still reach `fs`/`fetch`/`process.env` via Node globals regardless of
 * what its `HandlerInit` exposes. Real enforcement is the external-exposure second implementation.
 * Therefore handlers are TRUSTED-AUTHOR ONLY and external-exposure hardening is an absolute gate (no
 * untrusted/customer handler on shared infra until the isolate exists). Do NOT build the per-store
 * TenantDb-wrapper enforcement here — that defends against a threat (untrusted handlers) that does not
 * exist until external exposure (premature platforming).
 */
import type {
  HandlerInit,
  RouteHandler,
  RouteHandlerInit,
  ToolHandler,
  ToolHandlerInit,
  TriggerHandler,
  TriggerHandlerInit,
} from '@rayspec/handler-sdk';

/**
 * A resolved escape-hatch handler symbol + its kind, as produced by the boot loader. The `fn` is the
 * exported function the loader resolved from the path-jailed `escapeHatchRoot`. Kept as one tagged
 * union so the runtime invokes it with the RIGHT init shape (a tool gets `ToolHandlerInit`, etc.).
 *
 * `routeTx` (OPTIONAL — route entries only): the route-transaction POSTURE honored
 * EXCLUSIVELY by the plain `{kind:'handler'}` route interpreter (api-auth's route-handlers.ts,
 * which picks `invokeRouteHandlerDetached` over `invokeRouteHandler`). The STREAM route
 * interpreters (stream-routes.ts ingest/playback) IGNORE it — a stream handler always runs inside
 * the engine's tenant transaction via `invokeStreamRouteHandler`. ABSENT (every loader-resolved
 * handler + every existing capability entry) = today's behavior byte-identical: the engine opens
 * ONE `TenantDb.transaction` around the handler. `'handler-managed'` = the engine opens NO
 * transaction — the handler manages its own short transactions via `init.db.transaction(...)`
 * (the conversational turn route needs this to commit its intake BEFORE an in-request model run
 * and to hold no tx across it). This is a CODE-LEVEL entry field (set by a capability mount),
 * never grammar — the loader never sets it.
 */
export type ResolvedHandler =
  | { kind: 'tool'; fn: ToolHandler }
  | { kind: 'route'; fn: RouteHandler; routeTx?: 'handler-managed' }
  | { kind: 'trigger'; fn: TriggerHandler };

/**
 * The single indirection. ONE method per handler kind, so the call site is type-precise and the
 * second (isolate) implementation overrides exactly these three. A `HandlerRuntime` is the ONLY thing that
 * ever calls a handler function — the in-process impl calls it directly; the isolate impl marshals the
 * (serializable-shaped) init across the isolate boundary and calls it there.
 */
export interface HandlerRuntime {
  /** Invoke a tool handler with the model args + the engine-built `ToolHandlerInit`. */
  invokeTool(fn: ToolHandler, args: unknown, init: ToolHandlerInit): Promise<unknown>;
  /** Invoke a route handler with the engine-built `RouteHandlerInit`; returns the response body. */
  invokeRoute(fn: RouteHandler, init: RouteHandlerInit): Promise<unknown>;
  /** Invoke a trigger handler with the engine-built `TriggerHandlerInit`. */
  invokeTrigger(fn: TriggerHandler, init: TriggerHandlerInit): Promise<void>;
}

/**
 * The in-process implementation — the ONE that exists today. It simply calls the handler in our
 * process (trusted-author, not sandboxed). `await` normalizes a sync-or-async handler return. This
 * is the body the external-exposure isolate replaces; the contract (above) does not move.
 */
export class InProcessHandlerRuntime implements HandlerRuntime {
  async invokeTool(fn: ToolHandler, args: unknown, init: ToolHandlerInit): Promise<unknown> {
    return await fn(args, init);
  }
  async invokeRoute(fn: RouteHandler, init: RouteHandlerInit): Promise<unknown> {
    return await fn(init);
  }
  async invokeTrigger(fn: TriggerHandler, init: TriggerHandlerInit): Promise<void> {
    await fn(init);
  }
}

/**
 * The process-wide active runtime. Defaults to the in-process impl. The seam is a SINGLE swappable
 * slot (not threaded through every call) so there is provably ONE place the isolate changes — and the
 * seam-works test can install a second impl + assert every invocation funnels through it.
 *
 * (A process-global is deliberate + correct: there is exactly one runtime per process, and
 * the isolate impl is likewise process-wide. It is never per-tenant — the per-TENANT scoping is
 * carried by the `HandlerInit` the runtime is GIVEN, not by which runtime runs.)
 */
let active: HandlerRuntime = new InProcessHandlerRuntime();

/** The single accessor every call site uses. Returns the active `HandlerRuntime`. */
export function getHandlerRuntime(): HandlerRuntime {
  return active;
}

/**
 * Install a `HandlerRuntime` (the external-exposure isolate impl wires here; the seam-works test installs a
 * counting no-op). Returns a `restore()` thunk so a test can put the in-process default back.
 */
export function setHandlerRuntime(runtime: HandlerRuntime): () => void {
  const previous = active;
  active = runtime;
  return () => {
    active = previous;
  };
}

/** Re-export the init type so callers building an init reference one source. */
export type { HandlerInit };
