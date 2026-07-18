/**
 * The `triggers` seam — PARSE/REGISTER ONLY.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS (and is NOT).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A `spec.triggers[]` entry is a cron/webhook/event/manual DESCRIPTOR pointing at an `action`
 * (an agent run or a declared trigger-handler). We REGISTER those descriptors into an
 * in-memory `TriggerRegistry` and RESOLVE each `action`'s reference FAIL-CLOSED at boot (a dangling
 * agent/handler ref ABORTS the deploy — never a silently dead trigger). That is the whole scope of this seam.
 *
 * The durable cron/event WORKER that would actually FIRE these is a later stage (DBOS). That stage ships
 * the cron firing runtime with an IDEMPOTENT, at-MOST-once-per-instant guarantee (it never double-fires;
 * a crash in the reserve→dispatch window can DROP an instant — at-least-once delivery is later work).
 * So a runtime attempt to FIRE a trigger is FAIL-CLOSED-REJECTED (`fireTrigger` throws a clear
 * `TriggerDeferredError` naming the deferral) — never a silent no-op, never a half-run. This is the binding
 * resolution: `async:true` / cron-fire is reserved + rejected until the durable worker lands.
 *
 * PRODUCT-AGNOSTIC: everything is derived from the validated spec + the injected handler/agent
 * registries at boot. No product trigger, name, or schedule lives in platform source.
 *
 * The registered descriptor is exactly the shape the durable worker will consume — registration is the
 * stable contract; the worker is the second consumer added behind it without changing this seam.
 */
import type { RaySpec, TriggerKind } from '@rayspec/spec';
import type { ResolvedHandler } from '../handlers/handler-runtime.js';

/**
 * A trigger's resolved action — the discriminated `spec.triggers[].action`, but with its reference
 * RESOLVED at boot:
 *  - `agent`   → the declared agent id (verified present in the agent id set);
 *  - `handler` → the declared handler id + the loaded `ResolvedHandler` (verified kind `trigger`).
 * Keeping the resolved handler ON the descriptor means the durable worker fires it WITHOUT re-resolving
 * (the boot fail-closed already happened); the agent action carries only the id (the worker resolves
 * it against the live agent registry at fire time, like every run).
 */
export type ResolvedTriggerAction =
  | { kind: 'agent'; agentId: string; persistTo?: string }
  | { kind: 'handler'; handlerId: string; handler: ResolvedHandler };

/** A registered trigger descriptor — the stable contract the durable worker consumes. */
export interface TriggerDescriptor {
  /** The declared trigger name (unique within `triggers[]`; lint-enforced). */
  readonly name: string;
  /** cron | webhook | event | manual. */
  readonly kind: TriggerKind;
  /** The cron expression (present iff `kind:'cron'`; lint-enforced). NOT evaluated at register time. */
  readonly schedule?: string;
  /** The logical event name (present iff `kind:'event'`; lint-enforced). */
  readonly event?: string;
  /**
   * Opt-in MISSED-INTERVAL CATCH-UP (make-up work) for a `cron` trigger. When `true`, the durable cron
   * worker registers this trigger's scheduled-workflow in the make-up-work mode, so intervals that
   * SHOULD have fired while the deployment was DOWN are replayed on the next startup — each missed
   * interval fired exactly once (the worker reuses its tenant-scoped firing reserve, so a replayed
   * interval that already fired is a no-op), bounded by a look-back window (unbounded history is NOT
   * replayed). Default (undefined/false) = fire once per interval WHILE ACTIVE only (no make-up work).
   *
   * The durable worker CONSUMES this field. `registerTriggers` populates it from `spec.triggers[].catchUp`
   * (the spec grammar carries an optional `catchUp` field on a trigger; lint rejects it on a non-cron
   * kind), so a YAML-declared cron trigger can request catch-up declaratively; a code-built descriptor
   * may also set it directly. Ignored for non-cron kinds.
   */
  readonly catchUp?: boolean;
  /** The boot-resolved action (agent id / handler id+fn). */
  readonly action: ResolvedTriggerAction;
}

/** Thrown when a trigger's `action` reference cannot be resolved at boot (dangling ref → abort). */
export class TriggerRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriggerRegistrationError';
  }
}

/**
 * Thrown when a trigger is FIRED at runtime. Triggers are parse/register-only here; the
 * durable cron/event worker is a later stage. Fail-closed — never a silent no-op or half-run.
 */
export class TriggerDeferredError extends Error {
  constructor(triggerName: string, reason: string) {
    super(
      `trigger '${triggerName}' cannot be fired synchronously: ${reason}. ` +
        'Trigger firing (cron/webhook/event/async) is deferred to the durable worker. ' +
        'This is a fail-closed rejection, not a no-op.',
    );
    this.name = 'TriggerDeferredError';
  }
}

/** The inputs the deploy/composition root supplies to resolve trigger actions at boot. */
export interface RegisterTriggersConfig {
  /** Boot-loaded handler id → resolved fn + kind (path-jailed; `loadHandlers`). */
  readonly handlers: ReadonlyMap<string, ResolvedHandler>;
  /** The set of declared agent ids an `{agent}` trigger action may reference. */
  readonly agentIds: ReadonlySet<string>;
}

/**
 * The in-memory registry of every registered trigger descriptor, keyed by name. Built once at boot
 * by `registerTriggers`; the durable worker reads it to schedule/fire. `fireTrigger` is the fail-closed
 * runtime edge.
 */
export class TriggerRegistry {
  private readonly byName: Map<string, TriggerDescriptor>;

  constructor(descriptors: TriggerDescriptor[]) {
    this.byName = new Map(descriptors.map((d) => [d.name, d]));
  }

  /** All registered descriptors (declared order preserved by the underlying Map insertion order). */
  list(): TriggerDescriptor[] {
    return [...this.byName.values()];
  }

  /** Look up one descriptor by name (undefined if not registered). */
  get(name: string): TriggerDescriptor | undefined {
    return this.byName.get(name);
  }

  /** The number of registered triggers. */
  get size(): number {
    return this.byName.size;
  }

  /**
   * FAIL-CLOSED runtime fire. Triggers are parse/register-only here — the durable worker is a later stage.
   * ALWAYS throws `TriggerDeferredError` (after checking the trigger exists, so an unknown name is a
   * distinct, equally-loud error). Never a silent no-op, never a partial run.
   */
  fireTrigger(name: string): never {
    const descriptor = this.byName.get(name);
    if (!descriptor) {
      throw new TriggerRegistrationError(
        `fireTrigger: no registered trigger named '${name}' (cannot fire an unknown trigger).`,
      );
    }
    throw new TriggerDeferredError(
      name,
      `it is a '${descriptor.kind}' trigger and this seam registers triggers but does not run them`,
    );
  }
}

/**
 * Register `spec.triggers[]` into a `TriggerRegistry`, RESOLVING each action's reference FAIL-CLOSED:
 *  - an `{agent}` action's agent id must be a declared agent (in `config.agentIds`);
 *  - a `{handler}` action's handler id must be a loaded handler whose kind is `trigger`.
 * A dangling/mistyped reference THROWS `TriggerRegistrationError` (the deploy aborts at boot) — never
 * a registered-but-dead trigger that would fail only when the durable worker later tries to fire it.
 *
 * The `lint` pass already resolved these cross-refs against the spec; this is the deploy-WIRING check
 * (the loaded handlers + the agent registry are the RUNTIME artifacts, which lint cannot see) +
 * defense-in-depth for a code-built spec that bypassed `parseSpec`.
 *
 * Empty `triggers[]` → an empty registry (a stores/api/agents-only spec). PRODUCT-AGNOSTIC.
 */
export function registerTriggers(spec: RaySpec, config: RegisterTriggersConfig): TriggerRegistry {
  const { handlers, agentIds } = config;
  const descriptors: TriggerDescriptor[] = [];

  for (const trigger of spec.triggers) {
    let action: ResolvedTriggerAction;
    if (trigger.action.kind === 'agent') {
      const agentId = trigger.action.agent;
      if (!agentIds.has(agentId)) {
        throw new TriggerRegistrationError(
          `trigger '${trigger.name}' references agent '${agentId}' which is not a declared agent ` +
            '(the deployment must declare it in agents[] / register its backend). Fail-closed at boot.',
        );
      }
      action = {
        kind: 'agent',
        agentId,
        ...(trigger.action.persistTo !== undefined ? { persistTo: trigger.action.persistTo } : {}),
      };
    } else {
      const handlerId = trigger.action.handler;
      const resolved = handlers.get(handlerId);
      if (!resolved) {
        throw new TriggerRegistrationError(
          `trigger '${trigger.name}' references handler '${handlerId}' but no loaded handler was ` +
            'supplied (the deployment must loadHandlers(escapeHatchRoot, spec.handlers) and pass the ' +
            'map). Fail-closed at boot.',
        );
      }
      if (resolved.kind !== 'trigger') {
        throw new TriggerRegistrationError(
          `trigger '${trigger.name}' references handler '${handlerId}' of kind '${resolved.kind}', ` +
            "expected 'trigger' (a trigger action must point at a trigger-kind handler). Fail-closed.",
        );
      }
      action = { kind: 'handler', handlerId, handler: resolved };
    }

    descriptors.push({
      name: trigger.name,
      kind: trigger.kind,
      ...(trigger.schedule ? { schedule: trigger.schedule } : {}),
      ...(trigger.event ? { event: trigger.event } : {}),
      // Thread the opt-in cron catch-up flag onto the descriptor the durable worker consumes
      // (`catchUpSchedulerMode` → DBOS make-up-work mode). Conditional spread so an absent flag
      // yields NO `catchUp` key (never `catchUp: undefined`) — additive, byte-unchanged otherwise.
      ...(trigger.catchUp !== undefined ? { catchUp: trigger.catchUp } : {}),
      action,
    });
  }

  return new TriggerRegistry(descriptors);
}
