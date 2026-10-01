/**
 * OpenAI adapter auth — the client each adapter's runs use, and that nothing is registered process
 * wide. Deterministic: no network, no DB. The two process-global registration entry points of
 * `@openai/agents` (`setDefaultOpenAIKey`, `setDefaultOpenAIClient`) are spied to prove the adapter
 * never calls them: a default is last-writer-wins, so two adapters with different keys would send each
 * other's key. The bounds are read off the adapter's own client (`openAIClient()`), which is the one
 * its model is bound to.
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

type ClientView = { timeout: number; maxRetries: number; apiKey: string | null };
const clientOf = (adapter: InstanceType<typeof OpenAIAdapter>) =>
  adapter.openAIClient() as unknown as ClientView;

describe('OpenAIAdapter auth and client', () => {
  beforeEach(() => {
    setDefaultOpenAIKeySpy.mockClear();
    setDefaultOpenAIClientSpy.mockClear();
  });

  it('resolves api-key auth without registering any process-global key or client', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-unbounded' });
    expect(await adapter.resolveAuth()).toBe('api-key');
    expect(setDefaultOpenAIKeySpy).not.toHaveBeenCalled();
    expect(setDefaultOpenAIClientSpy).not.toHaveBeenCalled();
    expect(clientOf(adapter).apiKey).toBe('sk-unbounded');
  });

  it('gives each adapter its own client with its own key', () => {
    const a = new OpenAIAdapter({ apiKey: 'sk-agent-a' });
    const b = new OpenAIAdapter({ apiKey: 'sk-agent-b' });
    expect(clientOf(a).apiKey).toBe('sk-agent-a');
    expect(clientOf(b).apiKey).toBe('sk-agent-b');
    expect(a.openAIClient()).not.toBe(b.openAIClient());
    // One client per adapter, reused across its runs.
    expect(a.openAIClient()).toBe(a.openAIClient());
  });

  it('carries timeoutMs as the per-request timeout', () => {
    const client = clientOf(new OpenAIAdapter({ apiKey: 'sk-bounded', timeoutMs: 30_000 }));
    expect(client.timeout).toBe(30_000);
    expect(client.apiKey).toBe('sk-bounded');
  });

  it('maps maxAttempts to maxRetries as attempts MINUS ONE (3 attempts = 2 retries)', () => {
    expect(clientOf(new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: 3 })).maxRetries).toBe(2);
  });

  it('maps maxAttempts:1 to maxRetries:0 — one attempt, no retry', () => {
    expect(clientOf(new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: 1 })).maxRetries).toBe(0);
  });

  it('never carries a NEGATIVE maxRetries: a non-positive maxAttempts clamps to 0', () => {
    // openai@6.44.0 decides whether to retry with a truthiness test on the remaining count
    // (client.mjs:372, :422) and decrements it per attempt (:563), so a negative count never reaches
    // 0 and the client retries without end. The environment resolver cannot produce a non-positive
    // attempt count, but OpenAIAdapterOptions is exported, so a caller can pass one.
    expect(clientOf(new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: 0 })).maxRetries).toBe(0);
    expect(clientOf(new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: -5 })).maxRetries).toBe(
      0,
    );
  });

  it('carries both bounds on the one client when both are set', () => {
    const client = clientOf(
      new OpenAIAdapter({ apiKey: 'sk-bounded', timeoutMs: 45_000, maxAttempts: 2 }),
    );
    expect(client.timeout).toBe(45_000);
    expect(client.maxRetries).toBe(1);
  });

  it('leaves an unset bound at the openai client default (timeout 10 min, maxRetries 2)', () => {
    expect(clientOf(new OpenAIAdapter({ apiKey: 'sk-bounded', maxAttempts: 1 })).timeout).toBe(
      600_000,
    );
    expect(clientOf(new OpenAIAdapter({ apiKey: 'sk-bounded', timeoutMs: 1_000 })).maxRetries).toBe(
      2,
    );
  });

  it('still fails closed on a missing API key', async () => {
    await expect(
      new OpenAIAdapter({ apiKey: '', timeoutMs: 1_000 }).resolveAuth(),
    ).rejects.toThrow('OpenAIAdapter: missing OPENAI_API_KEY');
  });
});
