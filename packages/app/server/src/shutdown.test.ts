/**
 * `shutdownHttpServer` against a real Node HTTP server and real sockets.
 *
 *  - An idle server stops at once and nothing is forced.
 *  - A request that never completes holds the server only for the drain; then its connection is
 *    closed and the outcome says so. (Without the bound, `close()` would wait for it forever.)
 *  - A request that finishes within the drain is answered, not cut.
 *  - An application close that hangs or throws is bounded too, and reported as not closed.
 */
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { shutdownHttpServer } from './shutdown.js';

let server: Server | undefined;

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe('shutdownHttpServer', () => {
  it('stops an idle server at once, forcing nothing', async () => {
    await listen((_req, res) => res.end('ok'));
    const logs: string[] = [];
    const started = Date.now();
    const outcome = await shutdownHttpServer(server as Server, async () => {}, {
      drainMs: 5_000,
      log: (m) => logs.push(m),
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outcome).toEqual({ forcedConnections: false, appClosed: true });
    expect(logs).toEqual([]);
  });

  it('closes a connection whose request never completes once the drain runs out', async () => {
    const port = await listen((req, res) => {
      // Waits for a body that never arrives.
      req.on('end', () => res.end('never'));
      req.resume();
    });
    const socket = createConnection({ host: '127.0.0.1', port });
    let closed = false;
    socket.on('close', () => {
      closed = true;
    });
    socket.on('error', () => {});
    await new Promise<void>((r) => socket.once('connect', () => r()));
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 50\r\n\r\n{');
    await new Promise((r) => setTimeout(r, 100));

    const logs: string[] = [];
    const started = Date.now();
    const outcome = await shutdownHttpServer(server as Server, async () => {}, {
      drainMs: 300,
      log: (m) => logs.push(m),
    });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(3_000);
    expect(outcome).toEqual({ forcedConnections: true, appClosed: true });
    expect(logs).toEqual([
      '[shutdown] connections were still open after the 300 ms drain; closing them',
    ]);
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(true);
  });

  it('lets a request that finishes within the drain be answered', async () => {
    const port = await listen((_req, res) => {
      setTimeout(() => res.end('finished'), 200);
    });
    const response = fetch(`http://127.0.0.1:${port}/`, { headers: { connection: 'close' } });
    await new Promise((r) => setTimeout(r, 50));
    const outcome = await shutdownHttpServer(server as Server, async () => {}, { drainMs: 5_000 });
    expect(outcome.forcedConnections).toBe(false);
    expect(await (await response).text()).toBe('finished');
  });

  it('bounds an application close that hangs, and reports one that throws', async () => {
    await listen((_req, res) => res.end('ok'));
    const logs: string[] = [];
    const hung = await shutdownHttpServer(server as Server, () => new Promise(() => {}), {
      drainMs: 0,
      log: (m) => logs.push(m),
    });
    expect(hung).toEqual({ forcedConnections: false, appClosed: false });
    expect(logs).toContain('[shutdown] the application did not close cleanly within the drain');

    await listen((_req, res) => res.end('ok'));
    const threw = await shutdownHttpServer(
      server as Server,
      async () => {
        throw new Error('pool already ended');
      },
      { drainMs: 100, log: () => {} },
    );
    expect(threw.appClosed).toBe(false);
  });
});
