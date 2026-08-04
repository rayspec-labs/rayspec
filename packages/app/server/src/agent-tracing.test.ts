/**
 * The agent trace-export switch (issue #287, half two).
 *
 * `@openai/agents` exports traces to OpenAI by DEFAULT, and those traces carry prompts and tool
 * arguments. On the `rayspec deploy` path that is somebody else's content leaving for a third party
 * without being asked, so on THAT path the export becomes an affirmative choice.
 *
 * Pinned here: the affirmative switch, its fail-closed arm, the deliberate blank handling, and the
 * EFFECTIVE posture the boot banner states (resolved through the SDK's own switch, so it stays honest
 * on the entry points that do not change the default).
 *
 * Pure env resolution — no DB, no network, no secrets.
 */
import { describe, expect, it } from 'vitest';
import {
  applyDeployAgentTracing,
  BootConfigError,
  effectiveAgentTracing,
  resolveAgentTracing,
} from './composition-root.js';

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

describe('applyDeployAgentTracing — what the `rayspec deploy` path does to the environment', () => {
  it("sets the SDK's own switch when the export was not selected", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyDeployAgentTracing(env)).toBe('off');
    expect(env[SDK_SWITCH]).toBe('1');
    // ...and that value is one the SDK actually honours — it reads exactly 'true' or '1'.
    expect(effectiveAgentTracing(env)).toBe('off');
  });

  it("leaves the SDK's switch alone when the operator selected the export", () => {
    const env: NodeJS.ProcessEnv = { RAYSPEC_AGENT_TRACING: 'openai' };
    expect(applyDeployAgentTracing(env)).toBe('openai');
    expect(env[SDK_SWITCH]).toBeUndefined();
    expect(effectiveAgentTracing(env)).toBe('openai');
  });

  it('does not undo an operator who set the SDK switch directly AND selected the export', () => {
    // The affirmative switch selects; it never re-enables something the operator turned off. The
    // banner then honestly reports OFF (see effectiveAgentTracing below).
    const env: NodeJS.ProcessEnv = { RAYSPEC_AGENT_TRACING: 'openai', [SDK_SWITCH]: '1' };
    expect(applyDeployAgentTracing(env)).toBe('openai');
    expect(effectiveAgentTracing(env)).toBe('off');
  });

  it('refuses the boot on an unsupported value rather than applying a default', () => {
    const env: NodeJS.ProcessEnv = { RAYSPEC_AGENT_TRACING: 'OPENAI' };
    expect(() => applyDeployAgentTracing(env)).toThrow(BootConfigError);
    expect(env[SDK_SWITCH]).toBeUndefined();
  });
});

describe('effectiveAgentTracing — what the SDK will ACTUALLY do', () => {
  it("reports EXPORTING on an environment nothing touched — the SDK's own default", () => {
    // This is why the banner reads the effective state rather than RAYSPEC_AGENT_TRACING: on
    // `rayspec-serve` and the local dev wrapper the default is unchanged, and the banner has to say so.
    expect(effectiveAgentTracing({})).toBe('openai');
    expect(effectiveAgentTracing({ RAYSPEC_AGENT_TRACING: 'off' })).toBe('openai');
  });

  it("reports OFF for both strings the SDK's own switch accepts, and only those", () => {
    expect(effectiveAgentTracing({ [SDK_SWITCH]: '1' })).toBe('off');
    expect(effectiveAgentTracing({ [SDK_SWITCH]: 'true' })).toBe('off');
    // `isEnabled` in the SDK's config.js compares against exactly 'true' and '1' — anything else
    // leaves the export ON, and reporting it as off would be a false reassurance.
    expect(effectiveAgentTracing({ [SDK_SWITCH]: 'TRUE' })).toBe('openai');
    expect(effectiveAgentTracing({ [SDK_SWITCH]: 'yes' })).toBe('openai');
    expect(effectiveAgentTracing({ [SDK_SWITCH]: '' })).toBe('openai');
  });

  it('mirrors the SDK disabling tracing under NODE_ENV=test', () => {
    expect(effectiveAgentTracing({ NODE_ENV: 'test' })).toBe('off');
  });
});
