/**
 * Derive the un-spoofable `created_by` actor string from a resolved route principal.
 *
 * The value is SERVER-DERIVED from the authenticated principal on the request context — never
 * client-settable — so it can be stamped onto a `created_by` column as the trustworthy record of who
 * created a row:
 *   - a user/session principal ⇒ `user:<userId>`;
 *   - an api-key / m2m principal (no user identity) ⇒ `key:<apiKeyId>`.
 * Returns `undefined` when neither identity is present (e.g. an unauthenticated context), in which
 * case the caller stamps nothing.
 *
 * This is the ONE canonical derivation shared by every server-side `created_by` stamp (the declarative
 * store.create path and the escape-hatch handler store facade), so the two can never drift.
 */
import type { AuthContext } from '../app-context.js';

export function principalActor(principal: AuthContext | undefined): string | undefined {
  if (principal?.kind === 'user' && principal.userId) return `user:${principal.userId}`;
  if (principal?.apiKeyId) return `key:${principal.apiKeyId}`;
  return undefined;
}
