/**
 * A REAL server process for the fence boot suite: the shipped composition root, a real HTTP listener
 * and the bounded shutdown, with a network-free agent backend. The suite spawns it with `node --import
 * tsx`, so a restart is a new process and a hanging connection is a real socket.
 *
 * Environment (beside the platform's own): `FENCE_ROUTES_FILE` receives the app's route list as JSON
 * once it serves; while the file named by `FENCE_HOLD_FILE` exists, every agent run waits (so a run
 * can be held in flight) after writing `<hold file>.entered.<runId>`. Prints `READY` once listening.
 *
 * An `.mts` file on purpose: the package build compiles `src/**\/*.ts` into `dist`, and a test
 * server has no place there.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import type { AgentSpec, Backend, BackendId, RunContext, RunResult } from '@rayspec/core';
import { registerScopedTables } from '@rayspec/db/testing';
import { assembleServer, loadServerConfig } from '../../composition-root.js';
import { shutdownHttpServer } from '../../shutdown.js';

const HOLD_FILE = process.env.FENCE_HOLD_FILE;

/** A backend that answers at once, unless the hold file exists, in which case it waits for it to go. */
class HoldingBackend implements Backend {
  readonly id = 'openai' as const;
  async resolveAuth() {
    return 'api-key' as const;
  }
  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    if (HOLD_FILE !== undefined && existsSync(HOLD_FILE)) {
      // Say that this run is held (its run header is not committed until the run ends).
      writeFileSync(`${HOLD_FILE}.entered.${ctx.runId}`, '');
      while (existsSync(HOLD_FILE)) await new Promise((r) => setTimeout(r, 50));
    }
    const finalText = `echo: ${spec.input}`;
    await ctx.journal.record({
      type: 'llm',
      idempotencyKey: `llm:${spec.name}:0`,
      inputHash: `hash:${spec.input}`,
      output: { finalText },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      model: spec.model,
      producedBy: 'fence-boot-backend',
      latencyMs: 1,
      status: 'ok',
      authMode: 'api-key',
    });
    return {
      runId: ctx.runId,
      backend: this.id,
      authMode: 'api-key',
      status: 'completed',
      finalText,
      output: null,
      error: null,
      errorClass: null,
      conversation: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      costUsd: 0,
      stepCount: 1,
    };
  }
}

const config = loadServerConfig();
const server = await assembleServer(config, {
  agentBackendsFactory: (): ReadonlyMap<BackendId, Backend> =>
    new Map<BackendId, Backend>([['openai', new HoldingBackend()]]),
  registerProductTables: (tables) => registerScopedTables([...tables.values()]),
});

const routesFile = process.env.FENCE_ROUTES_FILE;
if (routesFile) {
  const seen = new Set<string>();
  const routes: { method: string; path: string }[] = [];
  for (const r of server.app.routes) {
    const key = `${r.method} ${r.path}`;
    if (r.method === 'ALL' || seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: r.method, path: r.path });
  }
  writeFileSync(routesFile, JSON.stringify(routes), 'utf8');
}

const httpServer = serve(
  { fetch: server.app.fetch, hostname: config.host, port: config.port },
  () => {
    console.log('READY');
  },
);

process.on('SIGTERM', () => {
  void shutdownHttpServer(httpServer, () => server.close(), {
    drainMs: server.shutdownDrainMs,
  }).then((outcome) => {
    console.log(`STOPPED ${JSON.stringify(outcome)}`);
    process.exit(0);
  });
});
