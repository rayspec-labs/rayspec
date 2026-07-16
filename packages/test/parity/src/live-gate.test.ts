/**
 * The live-parity opt-in gate: credential presence is NECESSARY but NOT SUFFICIENT.
 *
 * Locks the invariant that closed the implicit-live-call hole — a live block runs ONLY when the
 * operator explicitly opted in (RAYSPEC_REQUIRE_LIVE_TESTS=true) AND the backend credential is present.
 * A regression to credential-only gating (a developer's ambient OPENAI_API_KEY silently spending on
 * `pnpm gate:parity`) turns the second case below RED.
 */
import { describe, expect, it } from 'vitest';
import { liveTestEnabled } from './live-gate.js';

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
