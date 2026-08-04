/**
 * The fail-closed boot-config abort, in a LEAF module.
 *
 * It lives here — and not beside the composition root that throws it most — for ONE reason: a caller
 * that has to fail closed BEFORE the boot closure is loaded needs to recognise the class without
 * importing that closure. `agent-tracing.ts` is exactly such a caller: `rayspec deploy` resolves the
 * trace-export posture before it imports `@rayspec/server`, so the refusal it can raise must be
 * catchable from a module that pulls in nothing.
 *
 * `composition-root.ts` re-exports it, so every existing import site — `@rayspec/server` and
 * `./composition-root.js` alike — keeps naming the SAME class object; `instanceof` therefore still
 * holds across the two entry points the deploy path imports.
 */

/** A missing/invalid env var → a fail-closed boot abort with an actionable message. */
export class BootConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootConfigError';
  }
}
