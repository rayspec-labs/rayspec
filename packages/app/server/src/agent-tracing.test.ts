/**
 * The agent trace-export switch (issue #287).
 *
 * `@openai/agents` exports traces to OpenAI by DEFAULT, and those traces carry prompts and tool
 * arguments. On the `rayspec deploy` path that is somebody else's content leaving for a third party
 * without being asked, so on THAT path the export becomes an affirmative choice.
 *
 * Pinned here: the affirmative switch, its fail-closed arm, the deliberate blank handling, and the two
 * things `applyDeployAgentTracing` does to turn the export off — the environment write AND the SDK's
 * own programmatic switch. What this file deliberately does NOT assert is the resulting SDK BEHAVIOUR:
 * `@openai/agents-core`'s config disables tracing whenever `NODE_ENV === 'test'`, so inside a vitest
 * worker every arm would report "off" whether the code worked or not. That measurement lives in
 * `packages/app/cli/src/deploy-agent-tracing.sdk.test.ts`, which takes it in a child process at
 * `NODE_ENV=production`, where the two arms can actually differ.
 *
 * No DB, no network, no secrets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every `setTracingDisabled` call the code under test made, in order. */
const h = vi.hoisted(() => ({ programmaticCalls: [] as boolean[] }));

// The SDK is REAL — only its programmatic kill-switch is wrapped, so the call can be observed while
// still doing what it does. (`vi.spyOn` cannot reach it: an ESM namespace object is not configurable.)
vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    setTracingDisabled: (disabled: boolean) => {
      h.programmaticCalls.push(disabled);
      actual.setTracingDisabled(disabled);
    },
  };
});

import {
  applyDeployAgentTracing,
  observedAgentTracing,
  resolveAgentTracing,
} from './agent-tracing.js';
import { BootConfigError } from './boot-config-error.js';

beforeEach(() => {
  h.programmaticCalls = [];
});

/** The SDK's own kill-switch — the mechanism the deploy path sets, never a name it invents. */
const SDK_SWITCH = 'OPENAI_AGENTS_DISABLE_TRACING';

describe('resolveAgentTracing — RAYSPEC_AGENT_TRACING is an AFFIRMATIVE switch', () => {
  it('leaves the export OFF when unset', () => {
    expect(resolveAgentTracing({})).toBe('off');
  });

  it("selects the export ONLY for the exact value 'openai'", () => {
    expect(resolveAgentTracing({ RAYSPEC_AGENT_TRACING: 'openai' })).toBe('openai');
    expect(resolveAgentTracing({ RAYSPEC_AGENT_TRACING: 'off' })).toBe('off');
  });

  it('treats a BLANK value as unset — the stated choice, and the protective one', () => {
    // Deliberate: `RAYSPEC_AGENT_TRACING=` (or an unsubstituted `${…}`) states no intention, and an
    // unstated intention resolves to the posture that exports nothing. The boot banner reports the
    // resolved posture either way, so this cannot be a silent surprise.
    expect(resolveAgentTracing({ RAYSPEC_AGENT_TRACING: '' })).toBe('off');
    expect(resolveAgentTracing({ RAYSPEC_AGENT_TRACING: '   ' })).toBe('off');
  });

  it('fail-closes BY NAME on an unsupported value instead of silently reading it as off', () => {
    for (const raw of ['OpenAI', 'openal', 'true', '1', 'yes', 'on']) {
      let err: unknown;
      try {
        resolveAgentTracing({ RAYSPEC_AGENT_TRACING: raw });
      } catch (e) {
        err = e;
      }
      expect(err, `RAYSPEC_AGENT_TRACING='${raw}' must be refused`).toBeInstanceOf(BootConfigError);
      expect((err as Error).message).toContain('RAYSPEC_AGENT_TRACING');
      expect((err as Error).message).toContain(raw);
    }
  });
});

describe('applyDeployAgentTracing — BOTH halves of turning the export off', () => {
  it("writes the SDK's env switch AND drives its programmatic one when the export is not selected", async () => {
    // The two are not redundant. The variable decides the posture for a provider that has not been
    // constructed yet (and for any child process this deployment spawns); the programmatic call is the
    // ONLY thing that can move a provider that already exists, because its disabled flag is a snapshot
    // of that variable taken at construction. `rayspec deploy --apply-migration` loads the boot closure
    // — and with it the agent SDK — before the serve path runs, so both halves are load-bearing.
    const env: NodeJS.ProcessEnv = {};
    await expect(applyDeployAgentTracing(env)).resolves.toBe('off');
    expect(env[SDK_SWITCH]).toBe('1');
    expect(h.programmaticCalls).toEqual([true]);
  });

  it("leaves BOTH of the SDK's switches alone when the operator selected the export", async () => {
    const env: NodeJS.ProcessEnv = { RAYSPEC_AGENT_TRACING: 'openai' };
    await expect(applyDeployAgentTracing(env)).resolves.toBe('openai');
    expect(env[SDK_SWITCH]).toBeUndefined();
    expect(h.programmaticCalls).toEqual([]);
  });

  it('does not undo an operator who set the SDK switch directly AND selected the export', async () => {
    // The affirmative switch selects; it never re-enables something the operator turned off. The
    // banner then honestly reports OFF, because it asks the SDK rather than reading this variable.
    const env: NodeJS.ProcessEnv = { RAYSPEC_AGENT_TRACING: 'openai', [SDK_SWITCH]: '1' };
    await expect(applyDeployAgentTracing(env)).resolves.toBe('openai');
    expect(env[SDK_SWITCH]).toBe('1');
  });

  it('refuses the boot on an unsupported value rather than applying a default', async () => {
    const env: NodeJS.ProcessEnv = { RAYSPEC_AGENT_TRACING: 'OPENAI' };
    await expect(applyDeployAgentTracing(env)).rejects.toBeInstanceOf(BootConfigError);
    expect(env[SDK_SWITCH]).toBeUndefined();
  });
});

describe('observedAgentTracing — the banner reads the SDK, not a variable', () => {
  it("reports the posture of the SDK's ACTUAL global trace provider", async () => {
    // Under vitest `NODE_ENV` is `test`, which the SDK's own config treats as tracing-disabled, so the
    // only value this can legitimately return here is `off` — and it must return it by asking the
    // provider. The discrimination (an `openai` arm that really exports) needs a non-test NODE_ENV and
    // lives in deploy-agent-tracing.sdk.test.ts.
    expect(process.env.NODE_ENV).toBe('test');
    await expect(observedAgentTracing()).resolves.toBe('off');
  });

  it('reads the provider rather than OPENAI_AGENTS_DISABLE_TRACING', async () => {
    // Set the variable to a value an env-derived reader would call "exporting". The observed posture
    // must not move, because the provider it asks was built long before this line ran. That is the
    // property which stops the banner being a tautology: it cannot report what the boot merely WROTE,
    // only what the SDK will DO.
    const saved = process.env[SDK_SWITCH];
    process.env[SDK_SWITCH] = 'no';
    try {
      await expect(observedAgentTracing()).resolves.toBe('off');
    } finally {
      if (saved === undefined) delete process.env[SDK_SWITCH];
      else process.env[SDK_SWITCH] = saved;
    }
  });
});
