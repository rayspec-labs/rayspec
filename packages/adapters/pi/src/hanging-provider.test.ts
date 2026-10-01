/**
 * The pi adapter against a provider that NEVER ANSWERS — a local HTTP server that accepts every
 * request and holds it open. The real pi session runs (no mock); its model calls go to the local
 * server through `PiAdapterOptions.baseUrl`, with a key that is not a credential.
 *
 *  - The provider-call timeout (`RunContext.limits.providerCallTimeoutMs`) ends the run when the
 *    session goes silent: the run reports the neutral `timeout` class, and the held request is closed.
 *  - The run's abort signal ends the call with no timeout configured.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthMode, JournalSink, RunContext, StepReport } from '@rayspec/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PiAdapter } from './index.js';

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
let baseUrl: string;
let requests = 0;
let closedByClient = 0;
const held: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1;
    req.on('close', () => {
      if (!res.writableEnded) closedByClient += 1;
    });
    req.resume();
    held.push(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  for (const res of held) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function waitFor(predicate: () => boolean, capMs = 5_000): Promise<void> {
  const deadline = Date.now() + capMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

describe('pi adapter: a provider that never answers', () => {
  it('the provider-call timeout ends the silent session, and the run reports `timeout`', async () => {
    const adapter = new PiAdapter({ apiKey: 'not-a-real-key', baseUrl });
    const journal = new FakeJournal();
    const before = requests;
    const closedBefore = closedByClient;
    const ctx: RunContext = {
      runId: 'run-pi-timeout',
      tenantId: 'tenant-test',
      journal,
      replay: false,
      authMode: 'api-key',
      tools: [],
      limits: { providerCallTimeoutMs: 400 },
    };
    const started = Date.now();
    const res = await adapter.run({ ...spec }, ctx);
    const elapsed = Date.now() - started;
    expect(requests).toBeGreaterThan(before);
    expect(res.status).toBe('error');
    expect(res.errorClass).toBe('timeout');
    expect(res.error).toContain('RAYSPEC_AGENT_REQUEST_TIMEOUT_MS');
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(5_000);
    // The held request was closed by the client: the provider is not left serving it.
    await waitFor(() => closedByClient > closedBefore);
    expect(closedByClient).toBeGreaterThan(closedBefore);
  });

  it('the run signal ends the call with no timeout configured', async () => {
    const adapter = new PiAdapter({ apiKey: 'not-a-real-key', baseUrl });
    const controller = new AbortController();
    const before = requests;
    const ctx: RunContext = {
      runId: 'run-pi-abort',
      tenantId: 'tenant-test',
      journal: new FakeJournal(),
      replay: false,
      authMode: 'api-key',
      tools: [],
      signal: controller.signal,
    };
    const run = adapter.run({ ...spec }, ctx);
    await waitFor(() => requests > before);
    expect(requests).toBeGreaterThan(before);
    const abortedAt = Date.now();
    controller.abort();
    const res = await run;
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(res.status).toBe('error');
  });
});
