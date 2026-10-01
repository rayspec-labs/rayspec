/**
 * Scoped handler rights: a handler that declares `uses` gets exactly those capabilities, and a
 * deployment that cannot grant one of them is refused before anything runs.
 *
 * THREE CHECKS, EACH BEFORE ACTIVATION.
 *  1. The grammar refuses a right outside the closed vocabulary when the document is parsed, and the
 *     lint refuses one the handler's kind never receives (both in `@rayspec/spec`).
 *  2. `assertHandlerRights` refuses a boot whose deployment does not grant a declared right — `stt`
 *     without a speech provider, `emit` without the event bus — naming the handler, the right and
 *     what is missing. Under the managed hosting posture it also refuses a handler that declares
 *     nothing: there every handler states what it uses.
 *  3. `scopeResolvedHandler` wraps a declaring handler so the init it receives carries only its
 *     declared rights: a capability it did not declare reads as a getter that throws
 *     `ToolRightNotGrantedError`, so a handler reaching for one fails where it asks instead of
 *     receiving `undefined`.
 *
 * A handler that declares nothing receives, outside the managed posture, every capability the
 * deployment configured — as before. None of this is a sandbox: handler code runs in the runtime
 * process and can reach Node's globals.
 */
import type { RouteHandler, TriggerHandler } from '@rayspec/handler-sdk';
import type { HandlerRight, HandlerSpec } from '@rayspec/spec';
import type { ResolvedHandler } from './handler-runtime.js';

/** The init fields a right governs, by right. */
export const HANDLER_RIGHT_FIELDS: Readonly<Record<HandlerRight, string>> = {
  blob: 'blob',
  fsSource: 'fsSource',
  stt: 'stt',
  tts: 'tts',
  emit: 'emit',
  enqueue: 'enqueue',
  mintPlayToken: 'mintPlayToken',
  bindings: 'bindings',
};

/** A capability a handler reached for without declaring it. */
export class ToolRightNotGrantedError extends Error {
  readonly handler: string;
  readonly right: string;

  constructor(handler: string, right: string) {
    super(
      `handler '${handler}' reached for init.${right}, a right it does not declare in uses; ` +
        `declare '${right}' in its uses to receive it`,
    );
    this.name = 'ToolRightNotGrantedError';
    this.handler = handler;
    this.right = right;
  }
}

/** A boot refused because a declared right is not granted, or a handler declares none. */
export class HandlerRightsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandlerRightsError';
  }
}

/**
 * Copy `init` with every capability field the handler did not declare replaced by a getter that
 * throws. A field the deployment did not configure stays absent, declared or not: the boot check
 * refuses a declared right that is not granted before any handler runs.
 */
export function scopeInit<T extends object>(init: T, handler: string, uses: readonly string[]): T {
  const scoped = { ...init } as Record<string, unknown>;
  for (const [right, field] of Object.entries(HANDLER_RIGHT_FIELDS)) {
    if (uses.includes(right) || !(field in scoped)) continue;
    delete scoped[field];
    Object.defineProperty(scoped, field, {
      enumerable: false,
      get() {
        throw new ToolRightNotGrantedError(handler, right);
      },
    });
  }
  return scoped as T;
}

/** Wrap a resolved handler so every init it is invoked with is scoped to `spec.uses`. */
export function scopeResolvedHandler(
  resolved: ResolvedHandler,
  spec: HandlerSpec,
): ResolvedHandler {
  const uses = spec.uses;
  if (uses === undefined) return resolved;
  switch (resolved.kind) {
    case 'tool': {
      const fn = resolved.fn;
      return {
        ...resolved,
        fn: (args, init) => fn(args, scopeInit(init, spec.id, uses)),
      };
    }
    case 'route': {
      const fn = resolved.fn;
      const scoped: RouteHandler = (init) => fn(scopeInit(init, spec.id, uses));
      return { ...resolved, fn: scoped };
    }
    case 'trigger': {
      const fn = resolved.fn;
      const scoped: TriggerHandler = (init) => fn(scopeInit(init, spec.id, uses));
      return { ...resolved, fn: scoped };
    }
  }
}

/**
 * What the deployment grants: for each right, `null` when it is granted, else what is missing
 * (named so the operator knows what to set).
 */
export type GrantedRights = Readonly<Record<HandlerRight, string | null>>;

/**
 * Refuse a boot whose handlers ask for a right the deployment does not grant, naming the handler,
 * the right and what is missing; under the managed posture, also one whose handler declares no
 * rights at all.
 */
export function assertHandlerRights(
  handlers: readonly HandlerSpec[],
  granted: GrantedRights,
  opts: { managedPosture: boolean },
): void {
  const problems: string[] = [];
  for (const handler of handlers) {
    if (handler.uses === undefined) {
      if (opts.managedPosture) {
        problems.push(
          `handler '${handler.id}' declares no rights; under RAYSPEC_HOSTING_POSTURE=managed every ` +
            'handler lists the capabilities it uses in `uses` (an empty list when it uses none)',
        );
      }
      continue;
    }
    for (const right of handler.uses) {
      const missing = granted[right];
      if (missing !== null) {
        problems.push(
          `handler '${handler.id}' asks for the right '${right}', which this deployment does not ` +
            `grant: ${missing}`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new HandlerRightsError(
      `Boot aborted — ${problems.join('; ')}. A handler gets only the rights it declares and the ` +
        'deployment grants; nothing is degraded silently. Fail-closed.',
    );
  }
}
