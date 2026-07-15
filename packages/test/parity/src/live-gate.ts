/**
 * The opt-in gate for the LIVE parity smoke suites.
 *
 * A live block calls REAL providers (real API spend / a real subscription). It must run ONLY when the
 * operator EXPLICITLY opted in (RAYSPEC_REQUIRE_LIVE_TESTS=true — the CI live lane sets it; the
 * deterministic lanes and a bare local `pnpm test` do not) AND the backend credential is present.
 *
 * Credential presence is NECESSARY but NOT SUFFICIENT: gating on the credential alone means a developer
 * who merely has OPENAI_API_KEY (or ~/.codex/auth.json) in their environment silently burns real calls
 * on a bare `pnpm gate:parity`. Requiring the explicit opt-in closes that.
 */
export function liveTestEnabled(optIn: boolean, hasCredential: boolean): boolean {
  return optIn && hasCredential;
}
