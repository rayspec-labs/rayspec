/**
 * The OpenAI speech adapter against a provider that NEVER ANSWERS — a local HTTP server, reached
 * through the adapter's `baseUrl` with the real global `fetch` and a key that is not a credential.
 *
 *  - With `timeoutMs` (wired from `RAYSPEC_AGENT_REQUEST_TIMEOUT_MS`) a request with no response, and
 *    a response whose body never finishes, both end as a retryable `provider_unavailable` refusal that
 *    names the timeout — and the held request is closed.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TtsAdapterError } from '@rayspec/tts-port';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OpenAiTtsAdapter } from './openai-tts-adapter.js';

let server: Server;
let baseUrl: string;
let closedByClient = 0;
const held: ServerResponse[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.on('close', () => {
      if (!res.writableEnded) closedByClient += 1;
    });
    req.resume();
    held.push(res);
    // `/slow-body/…`: send the head and the first audio bytes, then stall for good.
    if (req.url?.startsWith('/slow-body/')) {
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.write(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of held) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function adapterFor(url: string, timeoutMs?: number): OpenAiTtsAdapter {
  return new OpenAiTtsAdapter({
    apiKey: 'not-a-real-key',
    env: {},
    baseUrl: url,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const request = { text: 'hello', voice: 'alloy', format: 'mp3' } as const;

describe('OpenAI speech adapter: a provider that never answers', () => {
  it('a request with no response ends at the timeout as a retryable refusal, and is closed', async () => {
    const closedBefore = closedByClient;
    const started = Date.now();
    const err = await adapterFor(baseUrl, 300)
      .synthesize(request)
      .catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(TtsAdapterError);
    expect((err as TtsAdapterError).message).toContain('timed out after 300ms');
    expect((err as TtsAdapterError).retryable).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
    const deadline = Date.now() + 2_000;
    while (closedByClient === closedBefore && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(closedByClient).toBeGreaterThan(closedBefore);
  });

  it('a body that never finishes is bounded by the same timeout', async () => {
    const started = Date.now();
    const err = await adapterFor(`${baseUrl}/slow-body`, 300)
      .synthesize(request)
      .catch((e: unknown) => e);
    expect((err as Error).message).toContain('timed out after 300ms');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('without a timeout the request is not given up on (the behaviour before the bound existed)', async () => {
    const outcome = await Promise.race([
      adapterFor(baseUrl)
        .synthesize(request)
        .then(
          () => 'settled' as const,
          () => 'settled' as const,
        ),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), 800)),
    ]);
    expect(outcome).toBe('pending');
  });
});
