/**
 * The fail-closed composition error. `deploy` maps it 1:1 onto its `DeployError` step
 * vocabulary, so the ONE frozen-surface file stays a thin mapping and every decision about WHAT is
 * unsupported lives here (reviewable outside the frozen surface):
 *
 *  - `unsupported_spec` — the document is VALID Product-YAML, but it declares a section/policy/step
 *    this composition has no runtime for (or a section whose required deployment wiring was not
 *    supplied). The message ALWAYS names the offending section and what would make it deployable —
 *    the partial-unlock honesty rule: a declared-but-unserved section REJECTS the deploy, never a
 *    silent skip.
 *  - `roll out` — the document and the composition agree, but the deployment wiring is inconsistent
 *    (a store binding names a store that does not exist / lacks the contract columns, a route
 *    collision, a handler-id collision, …).
 */
export class ProductComposeError extends Error {
  constructor(
    readonly step: 'unsupported_spec' | 'roll out',
    message: string,
  ) {
    super(message);
    this.name = 'ProductComposeError';
  }
}

/** Convenience guard. */
export function isProductComposeError(e: unknown): e is ProductComposeError {
  return e instanceof ProductComposeError;
}
