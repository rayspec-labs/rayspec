/**
 * The ONE pre-run auth resolution, in one place.
 *
 * run-core resolves the run's auth mode exactly once, BEFORE the backend runs, and threads the answer
 * onto the RunContext so every journaled step of the run attributes to one mode by construction. That
 * ordering is right for a local adapter, which needs no run identity to know how it authenticates. A
 * REMOTE backend cannot work that way: at `resolveAuth()` time it has no runId, no tenantId and no
 * agent identity, so it cannot select a tenant- or run-scoped credential — it can only report a mode
 * it has not yet BOUND.
 *
 * This module owns the seam that fixes that without moving the resolution point: a backend that
 * implements the optional `preflightAuth()` is asked there INSTEAD, with the server-derived run
 * identity, and the mode it returns is the run's authoritative pre-run mode. A backend that does not
 * takes the path it always took.
 *
 * Deliberately NOT exported from the package barrel: the barrel re-exports what a composition
 * consumer needs, and this is run-core-internal (the tests import it by relative path).
 */
import { AuthMode, type Backend, type RunAuthPreflight } from '@rayspec/core';

/** What run-core knows about the run at the single pre-run resolution point. */
export interface PreRunAuthIdentity {
  readonly runId: string;
  readonly tenantId: string;
  readonly agentName: string;
  readonly model: string;
  readonly credentialBindingRef?: string;
}

/**
 * Resolve the run's pre-run auth mode: the backend's context-aware preflight when it has one, the
 * legacy `resolveAuth()` otherwise. Throws (fail-closed) when a preflight refuses or answers outside
 * the neutral vocabulary — at the call site that is before the header transition, before the
 * cancellation controller is armed and before `backend.run()`, so the refusal writes nothing of its
 * own: no `runs` row, no journal row, no event. On the synchronous run surface that leaves nothing
 * behind at all; a run enqueued through the API keeps the `enqueued` header that path wrote before
 * handing the job over, untouched.
 */
export async function resolvePreRunAuthMode(
  backend: Backend,
  identity: PreRunAuthIdentity,
): Promise<AuthMode> {
  // BYTE-IDENTITY: a backend without the optional preflight takes exactly the path it always took —
  // one `resolveAuth()`, answer returned verbatim and UNVALIDATED. The asymmetry with the preflight
  // arm below is deliberate, and it is NOT about which modes are acceptable (every member of the
  // vocabulary, 'unauthenticated' included, passes that check). `resolveAuth()` is declared to return
  // an `AuthMode` and its answer has always been used as given, so validating it here would INVENT a
  // failure the contract never had: a third-party backend that returns an off-vocabulary value at
  // runtime — types are erased — completes today and would be refused tomorrow. A preflight's answer
  // has no such history, so the guard costs nobody anything there. The presence test is
  // `typeof … !== 'function'` rather than `in`, so a backend carrying an explicit
  // `preflightAuth: undefined` is a backend WITHOUT a preflight, not one with a broken seam.
  const preflight = backend.preflightAuth;
  if (typeof preflight !== 'function') return await backend.resolveAuth();

  // A fresh, DIRECTLY ANNOTATED object literal: this is what makes TypeScript's excess-property check
  // reject a future edit that tries to add a field (say `apiKey`) to the payload. Freezing the RESULT
  // of Object.freeze into the annotated const would lose that check — Object.freeze returns
  // `Readonly<inferred>`, which is no longer a fresh literal — so build first, freeze after.
  const payload: RunAuthPreflight = {
    runId: identity.runId,
    tenantId: identity.tenantId,
    agentName: identity.agentName,
    model: identity.model,
    // A conditional spread, not `credentialBindingRef: identity.credentialBindingRef`: this repo does
    // not set exactOptionalPropertyTypes, so the latter would put an EXPLICIT `undefined` key on the
    // payload. Absent must mean ABSENT — the backend sees no key at all.
    ...(identity.credentialBindingRef === undefined
      ? {}
      : { credentialBindingRef: identity.credentialBindingRef }),
  };
  Object.freeze(payload);

  // Called as a member (via `.call`) so `this` survives for a class-based backend. A THROW propagates
  // VERBATIM — the identical treatment a `resolveAuth()` throw gets today, so the run surface's error
  // classification sees exactly what it sees now.
  const bound = await preflight.call(backend, payload);

  // FAIL CLOSED on anything outside the neutral vocabulary. The rejected VALUE is NEVER interpolated:
  // a backend that mistakenly hands back its credential must not get it written into an error
  // message, a log line or an HTTP body. This matters concretely because `runs.auth_mode` and
  // `journal_steps.auth_mode` are plain text NOT NULL columns with no CHECK constraint — this guard
  // is the only thing standing between a fabricated mode and the audit record.
  if (!AuthMode.safeParse(bound).success) {
    throw new Error(
      `run ${identity.runId}: the backend's auth preflight returned a value outside the neutral AuthMode vocabulary`,
    );
  }
  return bound;
}
