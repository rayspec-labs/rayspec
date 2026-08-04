/**
 * The live-parity opt-in gate: credential presence is NECESSARY but NOT SUFFICIENT.
 *
 * Locks the invariant that closed the implicit-live-call hole — a live block runs ONLY when the
 * operator explicitly opted in (RAYSPEC_REQUIRE_LIVE_TESTS=true) AND the backend credential is present.
 * A regression to credential-only gating (a developer's ambient OPENAI_API_KEY silently spending on
 * `pnpm gate:parity`) turns the second case below RED.
 */
import { describe, expect, it } from 'vitest';
import { liveGateFailure, liveTestEnabled, strayAnthropicKeyRefusal } from './live-gate.js';

describe('liveTestEnabled — the live opt-in gate', () => {
  it('runs only when opted in AND the credential is present', () => {
    expect(liveTestEnabled(true, true)).toBe(true);
  });

  it('SKIPS when the credential is present but the operator did NOT opt in (the closed hole)', () => {
    expect(liveTestEnabled(false, true)).toBe(false);
  });

  it('SKIPS when opted in but the credential is absent', () => {
    expect(liveTestEnabled(true, false)).toBe(false);
  });

  it('SKIPS when neither the opt-in nor the credential is present', () => {
    expect(liveTestEnabled(false, false)).toBe(false);
  });
});

/**
 * The collection-time refusal the live smoke applies on top of the per-block gate above.
 *
 * These cases pin WHICH credential configurations are rejected and which are accepted, so neither
 * branch can change without a red test. The one that is easy to change by accident is the fallback:
 * with `RAYSPEC_LIVE_BACKENDS` empty the refusal fires only when NOT ONE credential is present, so a
 * box holding a single provider credential is ACCEPTED and the blocks whose credential is absent
 * self-skip. That is deliberate — it keeps a partial local credential set usable — and it is the
 * reason `RAYSPEC_LIVE_BACKENDS` is what makes a "nothing skips" run true. Widening or narrowing that
 * fallback (requiring every backend, or dropping the check) turns the one-credential cases below RED.
 *
 * The messages are asserted in full because they are the operator-facing contract: each one names the
 * variable to set and the credential each backend needs.
 */
const SUPPORTED = 'openai, pi, anthropic, codex';

/**
 * The credential map exactly as the live smoke builds it, in its declared key order. `pi` runs on the
 * SAME credential as `openai`, so it is never independently present — passing `openai` sets both.
 */
function creds(present: {
  openai?: boolean;
  anthropic?: boolean;
  codex?: boolean;
}): Record<string, boolean> {
  return {
    openai: present.openai === true,
    pi: present.openai === true,
    anthropic: present.anthropic === true,
    codex: present.codex === true,
  };
}

describe('liveGateFailure — which credential configurations the live suite refuses', () => {
  it('refuses nothing without the opt-in, whatever the credentials or the backend list say', () => {
    expect(liveGateFailure(false, undefined, creds({}))).toBeNull();
    expect(liveGateFailure(false, 'openai,anthropic', creds({}))).toBeNull();
  });

  describe('with RAYSPEC_LIVE_BACKENDS empty — the coarse fallback', () => {
    it('REFUSES when not one provider credential is present', () => {
      expect(liveGateFailure(true, undefined, creds({}))).toBe(
        'packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but NO live provider creds (OPENAI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ~/.codex/auth.json) are present — refusing to silently skip the entire live parity suite.',
      );
    });

    it('REFUSES the same way for an empty string and for separators only', () => {
      const zeroCreds = creds({});
      const noCredsMessage = liveGateFailure(true, undefined, zeroCreds);
      expect(liveGateFailure(true, '', zeroCreds)).toBe(noCredsMessage);
      expect(liveGateFailure(true, ' , , ', zeroCreds)).toBe(noCredsMessage);
    });

    it('ACCEPTS a box holding exactly ONE credential — the rest green-skip', () => {
      expect(liveGateFailure(true, undefined, creds({ codex: true }))).toBeNull();
      expect(liveGateFailure(true, undefined, creds({ openai: true }))).toBeNull();
      expect(liveGateFailure(true, undefined, creds({ anthropic: true }))).toBeNull();
    });

    it('ACCEPTS a box holding every credential', () => {
      expect(
        liveGateFailure(true, undefined, creds({ openai: true, anthropic: true, codex: true })),
      ).toBeNull();
    });
  });

  describe('with RAYSPEC_LIVE_BACKENDS naming backends — the strict path', () => {
    it('REFUSES a named backend whose credential is absent, naming that backend', () => {
      expect(liveGateFailure(true, 'openai', creds({ codex: true }))).toBe(
        'packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set and RAYSPEC_LIVE_BACKENDS requires [openai], but the credential is absent for [openai] — refusing to green-skip a required live backend (openai/pi need OPENAI_API_KEY, anthropic needs CLAUDE_CODE_OAUTH_TOKEN, codex needs ~/.codex/auth.json).',
      );
    });

    it('REFUSES a partial credential set, naming every missing backend', () => {
      expect(liveGateFailure(true, 'openai,pi,anthropic', creds({ openai: true }))).toBe(
        'packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set and RAYSPEC_LIVE_BACKENDS requires [openai, pi, anthropic], but the credential is absent for [anthropic] — refusing to green-skip a required live backend (openai/pi need OPENAI_API_KEY, anthropic needs CLAUDE_CODE_OAUTH_TOKEN, codex needs ~/.codex/auth.json).',
      );
    });

    it('trims surrounding whitespace and drops empty entries before deciding', () => {
      expect(liveGateFailure(true, ' openai , ', creds({ codex: true }))).toBe(
        liveGateFailure(true, 'openai', creds({ codex: true })),
      );
    });

    it('REFUSES an unknown name, listing the supported ones', () => {
      expect(liveGateFailure(true, 'opanai', creds({ openai: true }))).toBe(
        `packages/test/parity/src/live-smoke.test.ts: RAYSPEC_LIVE_BACKENDS names unknown backend(s) [opanai] — supported: ${SUPPORTED}. A typo must not silently shrink live coverage.`,
      );
    });

    it('reports the unknown name before the missing credential', () => {
      expect(liveGateFailure(true, 'opanai,anthropic', creds({}))).toBe(
        `packages/test/parity/src/live-smoke.test.ts: RAYSPEC_LIVE_BACKENDS names unknown backend(s) [opanai] — supported: ${SUPPORTED}. A typo must not silently shrink live coverage.`,
      );
    });

    it('ACCEPTS when every named backend has its credential — the one-credential box, narrowed', () => {
      expect(liveGateFailure(true, 'codex', creds({ codex: true }))).toBeNull();
      expect(liveGateFailure(true, 'openai,pi', creds({ openai: true }))).toBeNull();
    });
  });
});

/**
 * The billing refusal. The anthropic live blocks assert `authMode === 'subscription-oauth-official-harness'`,
 * and the adapter resolves that mode from the ambient environment (`ANTHROPIC_API_KEY` first, then
 * `CLAUDE_CODE_OAUTH_TOKEN`). With both set the run authenticates as `api-key`: it BILLS the API and
 * only then fails the equality. This refusal moves the failure BEFORE the spend.
 *
 * The two accept cases are the ones easy to break by tightening: a stray key with NO subscription token
 * self-skips every anthropic block, so it must not block a contributor's openai/codex live run, and
 * nothing at all is refused without the opt-in.
 */
describe('strayAnthropicKeyRefusal — refusing to bill the API on a subscription live run', () => {
  it('REFUSES when opted in with BOTH the subscription token and a stray ANTHROPIC_API_KEY', () => {
    expect(strayAnthropicKeyRefusal(true, true, true)).toBe(
      'packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set and CLAUDE_CODE_OAUTH_TOKEN is present, but ANTHROPIC_API_KEY is ALSO set — the SDK credential precedence is ANTHROPIC_API_KEY > CLAUDE_CODE_OAUTH_TOKEN, so the anthropic live blocks would BILL the API instead of using the $0 subscription harness. Unset ANTHROPIC_API_KEY for this run.',
    );
  });

  it('ACCEPTS a stray key when the subscription token is absent — the anthropic blocks self-skip', () => {
    expect(strayAnthropicKeyRefusal(true, false, true)).toBeNull();
  });

  it('ACCEPTS without the opt-in, whatever the environment carries', () => {
    expect(strayAnthropicKeyRefusal(false, true, true)).toBeNull();
    expect(strayAnthropicKeyRefusal(false, false, true)).toBeNull();
  });

  it('ACCEPTS the sanctioned live configuration — subscription token, no API key', () => {
    expect(strayAnthropicKeyRefusal(true, true, false)).toBeNull();
  });
});
