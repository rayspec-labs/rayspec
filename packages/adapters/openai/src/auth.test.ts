/**
 * OpenAI adapter auth registration — WHICH process-global the adapter registers, and WHAT bound the
 * registered client carries. Deterministic: no network, no DB. The two registration entry points of
 * `@openai/agents` (`setDefaultOpenAIKey`, `setDefaultOpenAIClient`) are spied and the adapter's REAL
 * `resolveAuth()` runs against them, so these assertions pin the actual registration the SDK sees.
 *
 * The provider builds its client as `getDefaultOpenAIClient() ?? new OpenAI({...})`
 * (@openai/agents-openai/dist/openaiProvider.js) — a registered client is therefore the one the run
 * uses, and its `timeout` / `maxRetries` are the request bound and the retry count that apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setDefaultOpenAIKeySpy = vi.fn();
const setDefaultOpenAIClientSpy = vi.fn();

vi.mock('@openai/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@openai/agents')>();
  return {
    ...actual,
    setDefaultOpenAIKey: (...args: unknown[]) => setDefaultOpenAIKeySpy(...args),
    setDefaultOpenAIClient: (...args: unknown[]) => setDefaultOpenAIClientSpy(...args),
  };
});

const { OpenAIAdapter } = await import('./index.js');

/** The client handed to setDefaultOpenAIClient by the single registration this test performed. */
function registeredClient(): { timeout: number; maxRetries: number; apiKey: string | null } {
  expect(setDefaultOpenAIClientSpy).toHaveBeenCalledTimes(1);
  return setDefaultOpenAIClientSpy.mock.calls[0]?.[0] as {
    timeout: number;
    maxRetries: number;
    apiKey: string | null;
  };
}

describe('OpenAIAdapter.resolveAuth registration', () => {
  beforeEach(() => {
    setDefaultOpenAIKeySpy.mockClear();
    setDefaultOpenAIClientSpy.mockClear();
  });

  it('registers the API KEY and no client when neither bound is set', async () => {
    const mode = await new OpenAIAdapter({ apiKey: 'sk-unbounded' }).resolveAuth();
    expect(mode).toBe('api-key');
    expect(setDefaultOpenAIKeySpy).toHaveBeenCalledTimes(1);
    expect(setDefaultOpenAIKeySpy).toHaveBeenCalledWith('sk-unbounded');
    expect(setDefaultOpenAIClientSpy).not.toHaveBeenCalled();
  });

  it('registers a CLIENT carrying timeoutMs as the per-request timeout when timeoutMs is set', async () => {
    const mode = await new OpenAIAdapter({ apiKey: 'sk-bounded', timeoutMs: 30_000 }).resolveAuth();
    expect(mode).toBe('api-key');
    const client = registeredClient();
    expect(client.timeout).toBe(30_000);
    expect(client.apiKey).toBe('sk-bounded');
    expect(setDefaultOpenAIKeySpy).not.toHaveBeenCalled();
  });

  it('maps maxAttempts to maxRetries as attempts MINUS ONE (3 attempts = 2 retries)', async () => {
    await new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: 3 }).resolveAuth();
    expect(registeredClient().maxRetries).toBe(2);
  });

  it('maps maxAttempts:1 to maxRetries:0 — one attempt, no retry', async () => {
    await new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: 1 }).resolveAuth();
    expect(registeredClient().maxRetries).toBe(0);
  });

  it('carries both bounds on the one registered client when both are set', async () => {
    await new OpenAIAdapter({
      apiKey: 'sk-bounded',
      timeoutMs: 45_000,
      maxAttempts: 2,
    }).resolveAuth();
    const client = registeredClient();
    expect(client.timeout).toBe(45_000);
    expect(client.maxRetries).toBe(1);
  });

  it('leaves the unset bound at the openai client default (timeout 10 min, maxRetries 2)', async () => {
    // Only maxAttempts is set: the client's timeout must be the SDK default, not 0/NaN/undefined.
    await new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: 1 }).resolveAuth();
    expect(registeredClient().timeout).toBe(600_000);
    setDefaultOpenAIClientSpy.mockClear();
    // Only timeoutMs is set: the client's retry count must be the SDK default of 2.
    await new OpenAIAdapter({ apiKey: 'sk-bounded', timeoutMs: 1_000 }).resolveAuth();
    expect(registeredClient().maxRetries).toBe(2);
  });

  it('still fails closed on a missing API key with a bound set', async () => {
    await expect(
      new OpenAIAdapter({ apiKey: '', timeoutMs: 1_000 }).resolveAuth(),
    ).rejects.toThrow('OpenAIAdapter: missing OPENAI_API_KEY');
    expect(setDefaultOpenAIClientSpy).not.toHaveBeenCalled();
  });
});
