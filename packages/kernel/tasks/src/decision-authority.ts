/**
 * WHO MAY DECIDE — the one predicate behind both human decision doors (approvals, reviews).
 *
 * An approval row's `approver` and a review row's `reviewer` are ACCOUNTABILITY FACTS: the engine
 * journals them (`workforce.approval.requested{approver}`, `workforce.review.decided{reviewer}`)
 * and the timeout sweep MINTS one when an approval escalates to the requester's declared superior
 * (approvals.ts — `approver: escalatedTo`). A door that lets any principal resolve such a row
 * writes an authorization it does not keep: `decided_by` would be free to contradict the very fact
 * the journal recorded, and an audit trail the next write can contradict is worse than no claim.
 * So the decider is compared against the row, HERE, on every path.
 *
 * TWO NAMESPACES MEET on these columns and the predicate has to speak both:
 *
 *  - the DECLARATION namespace — the sentinel `'user'`, or a declared employee id, which is a
 *    `SafeIdentifier` (`/^[a-z_][a-z0-9_]*$/`, @rayspec/spec identifier.ts);
 *  - the PRINCIPAL namespace — what a server derives from an authenticated request:
 *    `user:<userId>` / `api-key:<apiKeyId>` (api-auth's `actorFrom`), and in-engine callers that
 *    journal the bare employee id (the turn path passes `task.owner`).
 *
 * `'user'` is the OPEN SENTINEL and stays open: it means "the deployment's human operator surface",
 * every shipped example declares exactly that (`approver: user` is the only spelling the grammar
 * admits, workforce-grammar.ts), and the single-operator posture depends on any permitted principal
 * being able to answer it. Only a row that NAMES someone binds.
 *
 * The scheme set is CLOSED — `user:` and `api-key:` and nothing else — so the closed
 * `principal:unresolved` sentinel can never satisfy a named decider, and a future scheme has to be
 * added here deliberately rather than matching by accident. The identity half must be the WHOLE
 * remainder: `user:ops_leader` never satisfies `ops_lead`.
 *
 * Break-glass lives at the CALLER, never here: this module answers "is this the named decider",
 * and the doors decide whether an authorized override may proceed anyway (recording it in the
 * journal, so the trail stays honest about what happened).
 */

/**
 * The sentinel that means "any authenticated human on the deployment's operator surface". It is the
 * only `approver` value the declared grammar admits (`workforce-grammar.ts`) and the value the
 * request_approval tool hardcodes (`workforce-tools` toolset.ts), so this string is the shipped
 * posture, not a special case.
 */
export const ANY_AUTHENTICATED_DECIDER = 'user';

/**
 * The CLOSED set of scheme prefixes a server-derived principal string may carry. Adding one is a
 * deliberate widening of who can satisfy a named decider — never an accident of string shape.
 */
const PRINCIPAL_SCHEMES = ['user:', 'api-key:'] as const;

/** Does the row's recorded decider name every principal, rather than one? */
export function isOpenDecider(named: string): boolean {
  return named === ANY_AUTHENTICATED_DECIDER;
}

/**
 * May `actor` resolve a row whose recorded decider is `named`?
 *
 * True when the row names EVERY principal (the `'user'` sentinel), or when the actor IS the named
 * decider — bare, or under one of the two closed principal schemes.
 */
export function mayDecide(named: string, actor: string): boolean {
  if (isOpenDecider(named)) return true;
  if (actor === named) return true;
  for (const scheme of PRINCIPAL_SCHEMES) {
    if (actor.startsWith(scheme) && actor.slice(scheme.length) === named) return true;
  }
  return false;
}
