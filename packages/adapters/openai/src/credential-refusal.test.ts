/**
 * The OpenAI adapter against a provider that refuses the credential — a local HTTP server answering
 * `401` the way the real API does, its message quoting part of the key. No SDK mock, no network beyond
 * loopback.
 *
 *  - Each adapter sends its own key and only its own: two adapters with distinct keys reach the
 *    provider with exactly the key each was built with.
 *  - A refused key fails the run closed: the neutral `upstream_4xx` class, one request (no retry,
 *    whatever the attempt budget), and a message that names `OPENAI_API_KEY` without repeating the
 *    provider's text or any part of the key.
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

const AGENT_A_KEY = 'sk-agent-a-0123456789abcdefWXYZ';
const AGENT_B_KEY = 'sk-agent-b-9876543210fedcbaQRST';

let server: Server;
const seenKeys: string[] = [];
let savedBaseUrl: string | undefined;

beforeAll(async () => {
  setTracingDisabled(true);
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seenKeys.push((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    req.resume();
    const key = seenKeys.at(-1) ?? '';
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: {
          message: `Incorrect API key provided: ${key.slice(0, 6)}****${key.slice(-4)}.`,
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  savedBaseUrl = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = savedBaseUrl;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ctxFor(runId: string, journal: JournalSink): RunContext {
  return { runId, tenantId: 'tenant-test', journal, replay: false, authMode: 'api-key', tools: [] };
}

describe('OpenAI adapter: a refused credential', () => {
  it('fails the run closed, once, naming the credential and nothing of it', async () => {
    const before = seenKeys.length;
    const adapter = new OpenAIAdapter({ apiKey: AGENT_A_KEY, maxAttempts: 3 });
    const journal = new FakeJournal();
    const result = await adapter.run(spec, ctxFor('run-refused', journal));
    expect(result.status).toBe('error');
    expect(result.errorClass).toBe('upstream_4xx');
    expect(result.error).toContain('refused the credential OPENAI_API_KEY (HTTP 401)');
    expect(result.error).not.toContain('Incorrect API key');
    expect(result.error).not.toContain('WXYZ');
    expect(JSON.stringify(journal.records)).not.toContain('WXYZ');
    // A 401 is not retried, whatever the attempt budget.
    expect(seenKeys.length - before).toBe(1);
  });

  it('sends each adapter its own key and never another agent', async () => {
    seenKeys.length = 0;
    const a = new OpenAIAdapter({ apiKey: AGENT_A_KEY, maxAttempts: 1 });
    const b = new OpenAIAdapter({ apiKey: AGENT_B_KEY, maxAttempts: 1 });
    await a.run(spec, ctxFor('run-a', new FakeJournal()));
    await b.run(spec, ctxFor('run-b', new FakeJournal()));
    await a.run(spec, ctxFor('run-a2', new FakeJournal()));
    expect(seenKeys).toEqual([AGENT_A_KEY, AGENT_B_KEY, AGENT_A_KEY]);
  });
});
