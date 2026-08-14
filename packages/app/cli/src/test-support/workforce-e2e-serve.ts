/**
 * The workforce end-to-end BOOT SCRIPT — a real composed server (assembleServer + the durable
 * worker + the task dispatcher) with the acceptance suite's TURN HANDLERS injected through the
 * opts-only `workforceTurnHandlers` seam (deliberately unreachable from the environment — this
 * script exists precisely because a spawned production entrypoint cannot inject handlers).
 *
 * Run as a CHILD PROCESS by workforce-e2e.db.test.ts (via tsx), so a SIGKILL is a REAL process
 * death: no drain, no finally blocks, no in-process cleanup — exactly the crash the restart
 * story must survive. Everything else (DATABASE_URL, secrets, spec path, port, tenant) arrives
 * through the environment, the same contract the production entrypoints read.
 *
 * The handlers drive the whole acceptance story DETERMINISTICALLY from durable context alone (a
 * re-executed turn recomputes the same intent — no memory, no clock):
 *   - `coordinator`: no child results yet → fan out 4 workers; child results but no approval
 *     decision → request an approval (a large window; the sweep must never race the test); an
 *     `approval_decided` signal with decision `approve` → complete with a summary derived from
 *     the merged child results (keyed by child id — deterministic bytes).
 *   - `worker-N`: complete immediately with a per-owner summary.
 */
import { serve } from '@hono/node-server';
import { registerProductStores } from '@rayspec/db/composition';
import type { TaskTurnHandler } from '@rayspec/durable-dbos';
import { assembleServer, loadServerConfig } from '@rayspec/server';

const coordinator: TaskTurnHandler = async (ctx) => {
  if (ctx.childResults === null) {
    return {
      intent: {
        kind: 'fan_out',
        children: [1, 2, 3, 4].map((i) => ({
          title: `Slice ${i}`,
          goal: `Handle slice ${i} of the goal.`,
          owner: `worker-${i}`,
        })),
      },
      actualUsd: 0.01,
    };
  }
  const decision = ctx.signals.find(
    (s) =>
      s.kind === 'approval_decided' &&
      (s.payload as { decision?: string } | null)?.decision === 'approve',
  );
  if (!decision) {
    return {
      intent: {
        kind: 'request_approval',
        question: 'Publish the merged result?',
        options: ['publish', 'hold'],
        timeoutMs: 60 * 60 * 1000,
        onTimeout: 'fail',
      },
      actualUsd: 0.01,
    };
  }
  const childIds = Object.keys(ctx.childResults).sort();
  return {
    intent: {
      kind: 'complete',
      result: {
        status: 'completed',
        summary: `merged ${childIds.length} children: ${childIds.join(',')}`,
        confidence: 0.95,
      },
    },
    actualUsd: 0.01,
  };
};

const worker: TaskTurnHandler = async (ctx) => ({
  intent: {
    kind: 'complete',
    result: {
      status: 'completed',
      summary: `${ctx.task.owner} handled ${ctx.task.title}`,
      confidence: 0.9,
    },
  },
  actualUsd: 0.005,
});

const config = loadServerConfig();
const server = await assembleServer(config, {
  registerProductTables: registerProductStores,
  // A truthy backends map is what constructs the durable worker for an agent-free spec; the
  // resolver never runs (no agent is ever enqueued in this acceptance).
  agentBackendsFactory: () => ({}) as never,
  workforceTurnHandlers: (owner) =>
    owner === 'coordinator' ? coordinator : owner.startsWith('worker-') ? worker : undefined,
});

serve({ fetch: server.app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[workforce-e2e] serving on ${info.address}:${info.port}`);
});
