/**
 * LIVE cross-backend smoke tests — SELF-SKIPPING unless explicitly opted in (see below).
 *
 * Runs the REAL adapters live (no DB; in-memory journal via the harness) and asserts the live
 * RunResult satisfies the SAME shape parity the committed fixtures encode — so a real SDK change
 * that breaks the neutral shape fails HERE locally (and re-recording the fixture is required).
 *
 * A live block runs ONLY when the operator EXPLICITLY opts in — RAYSPEC_REQUIRE_LIVE_TESTS=true — AND
 * the backend credential is present. Credential presence is NECESSARY but NOT SUFFICIENT: without the
 * opt-in every block below self-skips, so a bare `pnpm gate:parity` (or `pnpm test`) can never burn a
 * real API call / subscription just because a developer happens to have OPENAI_API_KEY or
 * ~/.codex/auth.json in their environment. The deterministic fixture suite (parity.test.ts) is the
 * standing gate; the live lane sets the provider creds AND RAYSPEC_REQUIRE_LIVE_TESTS=true (both
 * forwarded through turbo's `test.env` allowlist), so these suites RUN there and a missing credential
 * fails LOUDLY.
 *
 * When the opt-in IS set, the guard below additionally turns a missing/blind REQUIRED backend into a
 * hard fail — a live run can never report success while exercising zero providers.
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter } from '@rayspec/adapter-anthropic';
import { CodexAdapter } from '@rayspec/adapter-codex';
import { OpenAIAdapter } from '@rayspec/adapter-openai';
import { PiAdapter } from '@rayspec/adapter-pi';
import type { AuthMode, Backend } from '@rayspec/core';
import { RunResult } from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { captureRun } from './harness.js';
import { runResultShape, scenarioShape } from './index.js';
import { liveTestEnabled } from './live-gate.js';
import { scenariosForModel } from './scenarios.js';

const openaiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
// Codex runs on the ChatGPT OAuth subscription (no key) — present iff ~/.codex/auth.json exists.
// The precise OAuth-vs-api-key distinction is resolveAuth()'s job (asserted in the codex block below).
const codexModel = process.env.CODEX_MODEL || 'gpt-5.5';
const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');

const hasOpenAI = Boolean(openaiKey);
const hasAnthropic = Boolean(oauthToken);
// `hasCodex` is deliberately derived from the mere PRESENCE of the auth file, NOT from the resolved
// auth form. This is the BROAD gate: any present `auth.json` makes the codex block RUN, and the block
// then hard-fails if `resolveAuth()` does not return the subscription form (see the codex block below).
// Deriving `hasCodex` from the resolved form instead would turn that hard-fail into a silent self-skip
// (a non-subscription auth.json would set `hasCodex=false`, the block would never run, and the
// zero-provider-coverage regression would go unreported) — so the presence check is what ENABLES the
// downstream correctness enforcement.
const hasCodex = existsSync(join(codexHome, 'auth.json'));

// The backends this file can exercise live, each mapped to whether its credential is present. `pi`
// runs on the OpenAI key (the SAME credential as `openai`); anthropic on the subscription OAuth token;
// codex on the ChatGPT OAuth session file. This is the authoritative set of supported backend names.
const LIVE_CRED_PRESENT: Record<string, boolean> = {
  openai: hasOpenAI,
  pi: hasOpenAI,
  anthropic: hasAnthropic,
  codex: hasCodex,
};

// The EXPLICIT opt-in for any live-provider call. Credential presence is necessary but NOT sufficient
// (see the file header): every live block below additionally requires this, so a bare `pnpm gate:parity`
// with a provider cred in the ambient env never silently spends. The CI live lane sets it.
const liveOptIn = process.env.RAYSPEC_REQUIRE_LIVE_TESTS === 'true';

// A live run must never report success while exercising zero providers. When RAYSPEC_REQUIRE_LIVE_TESTS
// is set, a missing/blind backend is a HARD FAIL:
//   • RAYSPEC_LIVE_BACKENDS names the backends this run MUST exercise (comma-separated). An unknown
//     name is a typo that would silently shrink coverage → fail. Any named backend whose credential is
//     absent → fail, naming the specific backend(s). (Under partial creds the runnable blocks still run
//     and the not-required blocks legitimately self-skip.)
//   • With RAYSPEC_LIVE_BACKENDS empty (e.g. a bare local `pnpm test`), fall back to the coarse guard:
//     fail only when NOT ONE cred is present, so partial local creds still skip the missing blocks.
if (liveOptIn) {
  const required = (process.env.RAYSPEC_LIVE_BACKENDS ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (required.length > 0) {
    const unknown = required.filter((name) => !Object.hasOwn(LIVE_CRED_PRESENT, name));
    if (unknown.length > 0) {
      throw new Error(
        `packages/test/parity/src/live-smoke.test.ts: RAYSPEC_LIVE_BACKENDS names unknown backend(s) [${unknown.join(', ')}] — supported: ${Object.keys(LIVE_CRED_PRESENT).join(', ')}. A typo must not silently shrink live coverage.`,
      );
    }
    const missing = required.filter((name) => !LIVE_CRED_PRESENT[name]);
    if (missing.length > 0) {
      throw new Error(
        `packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set and RAYSPEC_LIVE_BACKENDS requires [${required.join(', ')}], but the credential is absent for [${missing.join(', ')}] — refusing to green-skip a required live backend (openai/pi need OPENAI_API_KEY, anthropic needs CLAUDE_CODE_OAUTH_TOKEN, codex needs ~/.codex/auth.json).`,
      );
    }
  } else if (!(hasOpenAI || hasAnthropic || hasCodex)) {
    throw new Error(
      'packages/test/parity/src/live-smoke.test.ts: RAYSPEC_REQUIRE_LIVE_TESTS is set but NO live provider creds (OPENAI_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ~/.codex/auth.json) are present — refusing to silently skip the entire live parity suite.',
    );
  }
}

/**
 * Run one backend live across all scenarios + assert the per-scenario shape invariants AND that the
 * run authenticated in EXACTLY `expectedAuthMode`. `RunResult.authMode` is the single resolved auth
 * mode the harness threads onto the RunContext and onto every journal step, so pinning it pins the
 * auth mode of every LLM step of the run: anthropic MUST be the $0 subscription official-harness,
 * never api-key billing; the api-key backends must be exactly api-key. (The harness projects the
 * returned journal to `type`/`status`/`idempotencyKey` and drops the per-step authMode, so the
 * run-level authMode is the surface that carries it — the same single value every step is stamped
 * with.)
 */
async function smokeBackend(
  backend: Backend,
  model: string,
  expectedAuthMode: AuthMode,
): Promise<void> {
  for (const scenario of scenariosForModel(model)) {
    const run = await captureRun(backend, scenario);
    // The live RunResult parses against the authoritative neutral schema.
    expect(() => RunResult.parse(run.result)).not.toThrow();
    // Key-presence on the live result.
    expect(Object.hasOwn(run.result, 'output')).toBe(true);
    expect(Object.hasOwn(run.result, 'error')).toBe(true);

    // Auth-mode compliance. A real LLM step was journaled (so this can never be a vacuous pass over an
    // empty journal), and the run's resolved auth mode is EXACTLY the one this backend must use. If a
    // backend silently authenticated by a different mechanism — anthropic falling back to api-key
    // billing being the case that matters — the equality below FAILS.
    expect(run.journal.some((s) => s.type === 'llm')).toBe(true);
    expect(run.result.authMode).toBe(expectedAuthMode);

    if (scenario.name === 'error') {
      expect(run.result.status).toBe('error');
      expect(typeof run.result.error).toBe('string');
    } else {
      expect(run.result.status).toBe('completed');
      expect(run.result.error).toBeNull();
      // Single per-run seq authority holds live (contiguous 0..n-1).
      expect(scenarioShape(run).seqContiguous).toBe(true);
    }

    if (scenario.name === 'multi-turn-tool') {
      // Real per-step ledger (kill stepCount=1) + the dispatched tool produced a tool_data result.
      expect(run.result.stepCount).toBeGreaterThan(1);
      const dataResult = run.result.conversation
        .flatMap((t) => t.parts)
        .some(
          (p) =>
            p.kind === 'tool_result' &&
            typeof p.result === 'object' &&
            p.result !== null &&
            (p.result as { kind?: string }).kind === 'tool_data',
        );
      expect(dataResult).toBe(true);
      // The dispatcher journaled at least one tool step (the dispatch chokepoint fired).
      expect(run.journal.some((s) => s.type === 'tool')).toBe(true);
      // EVERY tool_result is a DISPATCHED opaque result; EVERY tool_call is journaled.
      const parts = run.result.conversation.flatMap((t) => t.parts);
      const journaled = new Set(
        run.journal.filter((s) => s.type === 'tool').map((s) => s.idempotencyKey),
      );
      for (const p of parts) {
        if (p.kind === 'tool_result') {
          expect(['tool_data', 'tool_error']).toContain(
            (p.result as { kind?: string } | null)?.kind,
          );
        }
        if (p.kind === 'tool_call') expect(journaled.has(p.toolCallId)).toBe(true);
      }
      // The dispatcher is the single tool-event authority — #tool_called == #journaled tool steps.
      expect(run.events.filter((e) => e.type === 'tool_called').length).toBe(journaled.size);
    }

    if (scenario.name === 'structured-output') {
      // The live `output` is a non-null OBJECT with the schema fields on EVERY backend — openai/
      // anthropic NATIVE, pi EMULATED. No LCD-collapse.
      expect(typeof run.result.output).toBe('object');
      expect(run.result.output).not.toBeNull();
      const out = run.result.output as Record<string, unknown>;
      expect(typeof out.city).toBe('string');
      expect(typeof out.condition).toBe('string');
    }
  }
}

describe.skipIf(!liveTestEnabled(liveOptIn, hasOpenAI))(
  'LIVE: OpenAI shape parity (OPENAI_API_KEY present)',
  () => {
    it('runs all scenarios live + satisfies the shape invariants', async () => {
      await smokeBackend(
        new OpenAIAdapter({ apiKey: openaiKey as string }),
        openaiModel,
        'api-key',
      );
    });
  },
);

describe.skipIf(!liveTestEnabled(liveOptIn, hasOpenAI))(
  'LIVE: Pi shape parity (OpenAI key only — compliance)',
  () => {
    it('runs all scenarios live + satisfies the shape invariants', async () => {
      await smokeBackend(new PiAdapter({ apiKey: openaiKey as string }), openaiModel, 'api-key');
    });
  },
);

describe.skipIf(!liveTestEnabled(liveOptIn, hasAnthropic))(
  'LIVE: Anthropic shape parity (CLAUDE_CODE_OAUTH_TOKEN present)',
  () => {
    it('runs all scenarios live (subscription official-harness) + satisfies the shape invariants', async () => {
      const configRoot = mkdtempSync(join(tmpdir(), 'rayspec-parity-smoke-'));
      await smokeBackend(
        new AnthropicAdapter({ configRoot }),
        'claude-haiku-4-5',
        'subscription-oauth-official-harness',
      );
    });
  },
);

describe.skipIf(!liveTestEnabled(liveOptIn, hasCodex))(
  'LIVE: Codex shape parity (ChatGPT OAuth subscription)',
  () => {
    it('runs all scenarios live (subscription) + satisfies the shape invariants; auth=codex-subscription-oauth', async () => {
      const codex = new CodexAdapter();
      // The subscription-ONLY auth gate: a present auth.json must be the OAuth form (else self-skip-ish).
      const auth = await codex.resolveAuth();
      if (auth !== 'codex-subscription-oauth') {
        // This block runs ONLY when opted in — the describe.skipIf above gates on
        // liveTestEnabled(liveOptIn, hasCodex) — so a codex auth.json that is not the subscription form
        // is a HARD FAIL: the live smoke asserts ONLY the subscription path (the api-key OpenAI adapter
        // owns the api-key path), and passing here with zero assertions would be a false green. A local
        // dev with an api-key auth.json gets a benign skip from the describe.skipIf, not here.
        throw new Error(
          `packages/test/parity/src/live-smoke.test.ts: codex auth resolved to '${auth}', not 'codex-subscription-oauth' — the live smoke asserts ONLY the subscription path; refusing to pass with zero assertions while RAYSPEC_REQUIRE_LIVE_TESTS is set.`,
        );
      }
      await smokeBackend(codex, codexModel, 'codex-subscription-oauth');
    });
  },
);

describe.skipIf(!liveTestEnabled(liveOptIn, hasOpenAI && hasAnthropic))(
  'LIVE: the SAME spec yields the SAME RunResult key+type shape on all three live backends',
  () => {
    it('openai == pi == anthropic on RunResult keys + per-key types (live, multi-turn-tool)', async () => {
      const scenario = scenariosForModel(openaiModel).find((s) => s.name === 'multi-turn-tool');
      if (!scenario) throw new Error('missing scenario');
      const oa = await captureRun(new OpenAIAdapter({ apiKey: openaiKey as string }), scenario);
      const pi = await captureRun(new PiAdapter({ apiKey: openaiKey as string }), scenario);
      const anthScenario = scenariosForModel('claude-haiku-4-5').find(
        (s) => s.name === 'multi-turn-tool',
      );
      const configRoot = mkdtempSync(join(tmpdir(), 'rayspec-parity-smoke-'));
      const an = await captureRun(new AnthropicAdapter({ configRoot }), anthScenario as never);

      // Each backend authenticated in its required mode: api-key for openai/pi, the $0 subscription
      // official-harness for anthropic (never api-key billing).
      expect(oa.result.authMode).toBe('api-key');
      expect(pi.result.authMode).toBe('api-key');
      expect(an.result.authMode).toBe('subscription-oauth-official-harness');

      const shapes = [oa, pi, an].map((r) => runResultShape(r.result));
      expect(shapes[1]?.keys).toEqual(shapes[0]?.keys);
      expect(shapes[2]?.keys).toEqual(shapes[0]?.keys);
      expect(shapes[1]?.types).toEqual(shapes[0]?.types);
      expect(shapes[2]?.types).toEqual(shapes[0]?.types);
    });
  },
);
