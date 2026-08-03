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

/**
 * The collection-time refusal `live-smoke.test.ts` applies ON TOP of the per-block gate above: a live
 * run must never report success while exercising zero providers. Returns the message to throw, or
 * `null` when the run may proceed.
 *
 * `backendsRaw` is RAYSPEC_LIVE_BACKENDS verbatim; `credentialPresent` maps every supported backend
 * name to whether its credential is present, in the order the supported-name list should read.
 *
 *   • Named backends (comma-separated) are the backends this run MUST exercise. An unknown name is a
 *     typo that would silently shrink coverage → refuse, before looking at credentials. Any named
 *     backend whose credential is absent → refuse, naming the specific backend(s). (Under partial
 *     creds the runnable blocks still run and the not-required blocks legitimately self-skip.)
 *   • With the list empty (e.g. a bare local `pnpm test`), fall back to the COARSE guard: refuse only
 *     when NOT ONE credential is present, so partial local creds still skip the missing blocks. This
 *     is why the opt-in ALONE does not make a provider-backed skip impossible — naming the backends
 *     is what does, which is what CONTRIBUTING.md tells a contributor.
 *
 * The messages name `live-smoke.test.ts` because that is the file whose collection they fail; this
 * module holds no gate of its own.
 */
export function liveGateFailure(
  optIn: boolean,
  backendsRaw: string | undefined,
  credentialPresent: Record<string, boolean>,
): string | null {
  if (!optIn) return null;

  const required = (backendsRaw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (required.length > 0) {
    const unknown = required.filter((name) => !Object.hasOwn(credentialPresent, name));
    if (unknown.length > 0) {
      return `packages/test/parity/src/live-smoke.test.ts: RAYSPEC_LIVE_BACKENDS names unknown backend(s) [${unknown.join(', ')}] — supported: ${Object.keys(credentialPresent).join(', ')}. A typo must not silently shrink live coverage.`;
    }
    const missing = required.filter((name) => !credentialPresent[name]);
    if (missing.length > 0) {
      return `packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set and RAYSPEC_LIVE_BACKENDS requires [${required.join(', ')}], but the credential is absent for [${missing.join(', ')}] — refusing to green-skip a required live backend (openai/pi need OPENAI_API_KEY, anthropic needs CLAUDE_CODE_OAUTH_TOKEN, codex needs ~/.codex/auth.json).`;
    }
    return null;
  }

  if (Object.values(credentialPresent).every((present) => !present)) {
    return 'packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but NO live provider creds (OPENAI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ~/.codex/auth.json) are present — refusing to silently skip the entire live parity suite.';
  }

  return null;
}
