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
import type { HandlerPrincipal } from '@rayspec/platform';
import type { AuthContext } from '../app-context.js';

export function principalActor(principal: AuthContext | undefined): string | undefined {
  if (principal?.kind === 'user' && principal.userId) return `user:${principal.userId}`;
  if (principal?.apiKeyId) return `key:${principal.apiKeyId}`;
  return undefined;
}

/**
 * Derive the plain-value `init.principal` a route/stream handler receives from the SAME resolved
 * route principal `principalActor` derives the `created_by` actor from — one source, branch for
 * branch, so the identity a handler sees can never drift from the stamp:
 *   - a user/session principal ⇒ `{ kind: 'user', id: userId, role? }` (`role` only when the
 *     principal carries a live org role claim — a cookie session has none);
 *   - an api-key / m2m principal ⇒ `{ kind: 'apikey' | 'm2m', id: apiKeyId }` (no user identity,
 *     no role — the same disambiguation the middleware makes on `type === 'm2m_client'`).
 * Returns `undefined` when neither identity is present (e.g. an unauthenticated context), in which
 * case the caller injects nothing — the init field stays absent, never fabricated.
 */
export function handlerPrincipal(principal: AuthContext | undefined): HandlerPrincipal | undefined {
  if (principal?.kind === 'user' && principal.userId) {
    return {
      kind: 'user',
      id: principal.userId,
      ...(principal.role !== undefined ? { role: principal.role } : {}),
    };
  }
  if (principal?.apiKeyId) {
    return { kind: principal.kind === 'm2m' ? 'm2m' : 'apikey', id: principal.apiKeyId };
  }
  return undefined;
}
