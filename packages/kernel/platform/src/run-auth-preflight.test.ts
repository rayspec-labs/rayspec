/**
 * The context-aware auth preflight — pure unit coverage (no Postgres, no LLM).
 *
 * Covers the three properties of the seam that do not need a database to be true:
 *
 *  - THE PAYLOAD SHAPE. The preflight receives a closed set of plain string identifiers the PLATFORM
 *    minted, and nothing else. The backend under test deliberately HOLDS credential bytes (and the
 *    same bytes sit in the two provider environment variables an adapter would read), so a payload
 *    that carried credential material — directly or by accident — is visible as a sentinel in the
 *    serialized payload.
 *  - ORDERING. When a backend implements the preflight it REPLACES the pre-run `resolveAuth()`; the
 *    two are never both called, so there is no disagreement to arbitrate.
 *  - FAIL-CLOSED. A returned value outside the neutral `AuthMode` vocabulary is refused, and the
 *    refusal message never repeats the rejected value back (a backend that mistakenly hands back its
 *    credential must not get it written into an error message, a log line or an HTTP body).
 *
 * The omission arms here are the cheapest possible pin on `typeof backend.preflightAuth !==
 * 'function'`: a backend carrying an EXPLICIT `preflightAuth: undefined` must still take the legacy
 * path, which an `in` test would get wrong.
 */
import type { AuthMode, Backend, RunAuthPreflight, RunResult } from '@rayspec/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PreRunAuthIdentity, resolvePreRunAuthMode } from './run-auth-preflight.js';

/** Credential bytes the fake backend holds. Nothing this suite inspects may ever contain them. */
const SENTINEL = 'SECRET_preflight_credential_bytes_42';

const IDENTITY: PreRunAuthIdentity = {
  runId: 'preflight-unit-run',
  tenantId: '00000000-0000-0000-0000-00000000000a',
  agentName: 'preflight_agent',
  model: 'gpt-4.1-mini',
  credentialBindingRef: 'lease/2026-08-02/9f3c',
};

/**
 * A backend that holds a credential and records every payload its preflight is handed. `bound` is
 * typed `unknown` on purpose: the fail-closed arms need to return values a well-typed backend could
 * never return, which is precisely the case the runtime guard exists for.
 */
class RecordingBackend implements Backend {
  readonly id = 'openai' as const;
  resolveAuthCalls = 0;
  preflightCalls = 0;
  readonly payloads: RunAuthPreflight[] = [];
  /** The credential this backend would redeem out-of-band. Never crosses the seam. */
  readonly credential = SENTINEL;
  bound: unknown = 'subscription-oauth-official-harness';

  async resolveAuth(): Promise<AuthMode> {
    this.resolveAuthCalls += 1;
    return 'api-key';
  }

  async preflightAuth(preflight: RunAuthPreflight): Promise<AuthMode> {
    this.preflightCalls += 1;
    this.payloads.push(preflight);
    return this.bound as AuthMode;
  }

  async run(): Promise<RunResult> {
    throw new Error('this suite never executes a run');
  }
}

/**
 * A legacy backend as an object LITERAL rather than a class: the explicit-undefined arm below spreads
 * it, and a class instance's methods live on the prototype (a spread would drop them).
 */
function makeLegacyBackend(authMode: AuthMode = 'api-key') {
  const calls = { resolveAuth: 0 };
  const backend: Backend & { calls: typeof calls } = {
    id: 'openai',
    calls,
    async resolveAuth(): Promise<AuthMode> {
      calls.resolveAuth += 1;
      return authMode;
    },
    async run(): Promise<RunResult> {
      throw new Error('this suite never executes a run');
    },
  };
  return backend;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Plant the same bytes where a real adapter reads its credential from, so a payload that scraped
  // the environment (rather than carrying only platform-minted identity) is caught by the same
  // sentinel search.
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    savedEnv[key] = process.env[key];
    process.env[key] = SENTINEL;
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the preflight payload is server-derived run identity and NOTHING else', () => {
  it('carries exactly the five identity keys, all strings, frozen, and no credential material', async () => {
    const backend = new RecordingBackend();
    const mode = await resolvePreRunAuthMode(backend, IDENTITY);

    expect(mode).toBe('subscription-oauth-official-harness');
    expect(backend.payloads).toHaveLength(1);
    const payload = backend.payloads[0] as RunAuthPreflight;

    // The CLOSED key set. A future field added to the payload fails here as well as at the type
    // level, so the shape cannot widen unnoticed.
    expect(Object.keys(payload).sort()).toEqual([
      'agentName',
      'credentialBindingRef',
      'model',
      'runId',
      'tenantId',
    ]);
    for (const value of Object.values(payload)) expect(typeof value).toBe('string');
    expect(Object.isFrozen(payload)).toBe(true);

    expect(payload.runId).toBe(IDENTITY.runId);
    expect(payload.tenantId).toBe(IDENTITY.tenantId);
    expect(payload.agentName).toBe(IDENTITY.agentName);
    expect(payload.model).toBe(IDENTITY.model);
    // Byte-identical: the platform forwards the deployment's handle, it never rewrites or decorates it.
    expect(payload.credentialBindingRef).toBe(IDENTITY.credentialBindingRef);

    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
  });

  it('OMITS the binding-reference key entirely when the deployment supplied none', async () => {
    const backend = new RecordingBackend();
    const { credentialBindingRef: _omitted, ...withoutRef } = IDENTITY;
    await resolvePreRunAuthMode(backend, withoutRef);

    const payload = backend.payloads[0] as RunAuthPreflight;
    expect(Object.keys(payload).sort()).toEqual(['agentName', 'model', 'runId', 'tenantId']);
    // ABSENT, not present-and-undefined. This repo does not set exactOptionalPropertyTypes, so a
    // plain assignment would have written an explicit `undefined` key here.
    expect('credentialBindingRef' in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain(SENTINEL);
  });
});

describe('the preflight REPLACES the pre-run resolveAuth(), it does not race it', () => {
  it('calls the preflight exactly once and resolveAuth() not at all', async () => {
    const backend = new RecordingBackend();
    await resolvePreRunAuthMode(backend, IDENTITY);

    expect(backend.preflightCalls).toBe(1);
    expect(backend.resolveAuthCalls).toBe(0);
  });

  it('a backend WITHOUT the preflight takes the legacy path: one resolveAuth(), answer verbatim', async () => {
    const backend = makeLegacyBackend('api-key');
    expect(await resolvePreRunAuthMode(backend, IDENTITY)).toBe('api-key');
    expect(backend.calls.resolveAuth).toBe(1);

    // The legacy answer is returned UNVALIDATED: 'unauthenticated' is a mode a backend legitimately
    // reports today, and validating this path would change what such a run does.
    const anonymous = makeLegacyBackend('unauthenticated');
    expect(await resolvePreRunAuthMode(anonymous, IDENTITY)).toBe('unauthenticated');
    expect(anonymous.calls.resolveAuth).toBe(1);
  });

  it('a backend carrying an EXPLICIT preflightAuth: undefined still takes the legacy path', async () => {
    const legacy = makeLegacyBackend('api-key');
    const backend = { ...legacy, preflightAuth: undefined };

    expect(await resolvePreRunAuthMode(backend, IDENTITY)).toBe('api-key');
    expect(legacy.calls.resolveAuth).toBe(1);
  });
});

describe('a preflight answer outside the neutral vocabulary ends the run CLOSED', () => {
  it.each([
    ['the backend’s own credential', SENTINEL],
    ['a fabricated mode', 'bound-somehow'],
    ['a non-string', 7],
    ['nothing at all', undefined],
  ])('refuses %s without repeating the rejected value', async (_label, bound) => {
    const backend = new RecordingBackend();
    backend.bound = bound;

    const refusal = await resolvePreRunAuthMode(backend, IDENTITY).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(refusal?.message).toMatch(/outside the neutral AuthMode vocabulary/);
    // The refusal names the run, never the value: a backend that handed back credential bytes must
    // not get them echoed into an error message, a log line or an HTTP body.
    expect(refusal?.message).not.toContain(SENTINEL);
    expect(refusal?.message).not.toContain(String(bound));
    expect(refusal?.message).toContain(IDENTITY.runId);
  });

  it('propagates a preflight THROW verbatim — the same treatment a resolveAuth() throw gets today', async () => {
    const backend = new RecordingBackend();
    const failure = new Error('cloud: no binding for tenant');
    backend.preflightAuth = async (): Promise<AuthMode> => {
      throw failure;
    };

    await expect(resolvePreRunAuthMode(backend, IDENTITY)).rejects.toBe(failure);
  });

  it('accepts every member of the neutral vocabulary, including an honest anonymous run', async () => {
    for (const mode of [
      'api-key',
      'subscription-oauth-official-harness',
      'codex-subscription-oauth',
      'unauthenticated',
      'subscription-oauth-thirdparty-DISALLOWED',
    ] satisfies AuthMode[]) {
      const backend = new RecordingBackend();
      backend.bound = mode;
      expect(await resolvePreRunAuthMode(backend, IDENTITY)).toBe(mode);
    }
  });
});
