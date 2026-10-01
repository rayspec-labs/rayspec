/**
 * The OpenAI adapter against a provider that NEVER ANSWERS — a local HTTP server that accepts every
 * request and holds it open. No mock of the SDK and no network beyond loopback: the real `openai`
 * client the adapter registers sends its request to the local server (`OPENAI_BASE_URL`), with a key
 * that is not a credential.
 *
 *  - The request timeout (`RAYSPEC_AGENT_REQUEST_TIMEOUT_MS`, carried as `timeoutMs`) ends the call:
 *    the run settles with the neutral `timeout` class, within a bound of the timeout × attempts.
 *  - The run's abort signal ends the call without any timeout configured: the run settles promptly
 *    after the abort, and the server sees the request's connection closed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthMode, JournalSink, RunContext, StepReport } from '@rayspec/core';
import { setTracingDisabled } from '@openai/agents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAIAdapter } from './index.js';

class FakeJournal implements JournalSink {
  records: (StepReport & { authMode: AuthMode })[] = [];
  async lookup(): Promise<{ output: unknown } | null> {
    return null;
  }
  async lookupToolCache(): Promise<{ output: unknown } | null> {
    return null;
  }
  async record(step: StepReport & { authMode: AuthMode }): Promise<string> {
    this.records.push(step);
    return `step-${this.records.length}`;
  }
}

const spec = {
  name: 'agent',
  instructions: 'You are concise.',
  model: 'gpt-4.1-mini',
  input: 'Say ok.',
  tools: [],
  maxTurns: 2,
} as const;

let server: Server;
let requests = 0;
let closedByClient = 0;
const held: ServerResponse[] = [];
let savedBaseUrl: string | undefined;

beforeAll(async () => {
  // No trace export: the exporter would otherwise try the real provider with the fake key.
  setTracingDisabled(true);
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1;
    req.on('close', () => {
      if (!res.writableEnded) closedByClient += 1;
    });
    // Read the body and then say nothing at all: the provider that accepted and went silent.
    req.resume();
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  savedBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = savedBaseUrl;
  for (const res of held) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ctxFor(runId: string, journal: JournalSink, signal?: AbortSignal): RunContext {
  return {
    runId,
    tenantId: 'tenant-test',
    journal,
    replay: false,
    authMode: 'api-key',
    tools: [],
    ...(signal ? { signal } : {}),
  };
}

describe('OpenAI adapter: a provider that never answers', () => {
  it('the request timeout ends the call, and the run reports the neutral `timeout` class', async () => {
    const before = requests;
    const adapter = new OpenAIAdapter({ apiKey: 'not-a-real-key', timeoutMs: 300, maxAttempts: 1 });
    const journal = new FakeJournal();
    const started = Date.now();
    const res = await adapter.run({ ...spec }, ctxFor('run-openai-timeout', journal));
    const elapsed = Date.now() - started;
    // The request reached the silent provider…
    expect(requests).toBeGreaterThan(before);
    // …and the run ended on the timeout, not on any answer.
    expect(res.status).toBe('error');
    expect(res.errorClass).toBe('timeout');
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(5_000);
    expect(journal.records).toHaveLength(1);
    expect(journal.records[0]?.status).toBe('error');
  });

  it('with more than one attempt allowed the whole call stays within timeout × attempts', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'not-a-real-key', timeoutMs: 300, maxAttempts: 2 });
    const before = requests;
    const started = Date.now();
    const res = await adapter.run({ ...spec }, ctxFor('run-openai-attempts', new FakeJournal()));
    expect(res.errorClass).toBe('timeout');
    // At most the two attempts allowed, each ended by the timeout (plus the client's short backoff):
    // never the client's ten-minute default.
    expect(requests - before).toBeGreaterThanOrEqual(1);
    expect(requests - before).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThan(2 * 300 + 3_000);
  });

  it('the run signal ends the call with no timeout configured, and the request is closed', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'not-a-real-key' });
    const controller = new AbortController();
    const before = requests;
    const closedBefore = closedByClient;
    const run = adapter.run(
      { ...spec },
      ctxFor('run-openai-abort', new FakeJournal(), controller.signal),
    );
    // Wait until the request is held by the silent provider, then end the run.
    const deadline = Date.now() + 5_000;
    while (requests === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(requests).toBeGreaterThan(before);
    const abortedAt = Date.now();
    controller.abort();
    const res = await run;
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(res.status).toBe('error');
    // The client closed the held request: the provider is not left serving it.
    const closeDeadline = Date.now() + 2_000;
    while (closedByClient === closedBefore && Date.now() < closeDeadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(closedByClient).toBeGreaterThan(closedBefore);
  });
});
