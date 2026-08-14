/**
 * The workforce ROLES end-to-end BOOT SCRIPT — a real composed server whose ONLY injection is the
 * `agentBackendsFactory` seam (the same seam every agent-bearing deployment uses): each declared
 * backend id resolves to a SCRIPTED backend that replays deterministic tool calls through the real
 * dispatch chokepoint. Everything downstream is the production path — the spec parse under the
 * experimental flag, the redeploy gate, the derived-budget persistence, the agent registry, the
 * role toolsets, the turn collector, the engine's typed intents, the DBOS scheduler.
 *
 * Run as a CHILD PROCESS by workforce-roles-e2e.db.test.ts (via tsx). Configuration arrives
 * through the environment exactly as the production entrypoints read it.
 *
 * Every script is a PURE FUNCTION of the dispatched turn's rendered input (employee id, turn
 * number, child results, signal history, review round) — a re-executed turn replays the identical
 * calls. No memory, no clock, no invocation counting.
 */
import { serve } from '@hono/node-server';
import type { AgentSpec, Backend, BackendId } from '@rayspec/core';
import { registerProductStores } from '@rayspec/db/composition';
import { assembleServer, loadServerConfig } from '@rayspec/server';
import { makeScriptedBackend, type TurnScript } from '@rayspec/workforce-tools/testing';

/** The employee id the composition rendered into the turn input's first line. */
function employeeOf(spec: AgentSpec): string {
  const match = /^You are '([^']+)'/.exec(spec.input);
  if (!match) throw new Error(`scripted turn input names no employee: ${spec.input.slice(0, 80)}`);
  return match[1] as string;
}

/** The dispatched turn's 1-based number, rendered into the input. */
function turnOf(spec: AgentSpec): number {
  const match = /\bTurn (\d+)\./.exec(spec.input);
  if (!match) throw new Error('scripted turn input carries no turn number');
  return Number(match[1]);
}

/** The review round a dispatched review task's goal names, or null off the review path. */
function roundOf(spec: AgentSpec): number | null {
  const match = /\(round (\d+)\)/.exec(spec.input);
  return match ? Number(match[1]) : null;
}

const hasChildResults = (spec: AgentSpec): boolean =>
  spec.input.includes('Completed child results');
const hasApproval = (spec: AgentSpec): boolean =>
  spec.input.includes('approval_decided') && spec.input.includes('"approve"');

const submit = (summary: string, confidence: number): TurnScript => [
  { name: 'submit_result', args: { status: 'completed', summary, confidence } },
];

/**
 * The one script every scripted backend replays, branching on the employee the turn belongs to.
 * The STORY: the orchestrator delegates to two departments → each manager sub-delegates to its two
 * workers → the low-confidence worker's submission triggers the declared review policy → the
 * reviewer rejects round 1 → the rework resubmits → the reviewer accepts round 2 → the managers
 * merge → the orchestrator requests a human approval → the decision arrives (via the CLI) → the
 * orchestrator submits the synthesis.
 */
function scriptFor(spec: AgentSpec): TurnScript {
  const employee = employeeOf(spec);
  switch (employee) {
    case 'lead': {
      if (hasApproval(spec)) {
        return submit('Both department reports merged and approved.', 0.97);
      }
      if (hasChildResults(spec)) {
        return [
          {
            name: 'request_approval',
            args: {
              question: 'Publish the merged department reports?',
              options: ['publish', 'hold'],
            },
          },
        ];
      }
      return [
        {
          name: 'send_message',
          args: { recipient: 'mgr_eng', body: 'Coordinate with growth on timing.' },
        },
        {
          name: 'delegate_task',
          args: {
            tasks: [
              {
                target: 'department:eng',
                title: 'Engineering stream',
                goal: 'Deliver the engineering half of the report.',
              },
              {
                target: 'department:growth',
                title: 'Growth stream',
                goal: 'Deliver the growth half of the report.',
              },
            ],
          },
        },
      ];
    }
    case 'mgr_eng': {
      if (hasChildResults(spec)) {
        return submit('Engineering stream merged from two workers.', 0.95);
      }
      return [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              { target: 'employee:dev_pi', title: 'Backend slice', goal: 'Build the backend.' },
              { target: 'employee:dev_oai', title: 'Frontend slice', goal: 'Build the frontend.' },
            ],
          },
        },
      ];
    }
    case 'mgr_growth': {
      if (hasChildResults(spec)) {
        return submit('Growth stream merged from two workers.', 0.95);
      }
      return [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              { target: 'employee:copy_claude', title: 'Launch copy', goal: 'Write the copy.' },
              { target: 'employee:copy_codex', title: 'Launch assets', goal: 'Cut the assets.' },
            ],
          },
        },
      ];
    }
    // The LOW-confidence worker: every submission sits below the declared 0.75 threshold, so the
    // policy demands review each round — reject round 1, rework, accept round 2.
    case 'dev_pi':
      return turnOf(spec) === 1
        ? submit('Backend slice implemented.', 0.6)
        : submit('Backend slice reworked per review.', 0.6);
    case 'dev_oai':
      return submit('Frontend slice implemented.', 0.95);
    case 'copy_claude':
      return submit('Launch copy written.', 0.9);
    case 'copy_codex':
      return submit('Launch assets cut.', 0.9);
    case 'qa': {
      const round = roundOf(spec);
      if (round === 1) {
        return [
          {
            name: 'submit_review',
            args: {
              verdict: 'reject',
              reasons: ['Confidence is too low for the stated scope.'],
              requiredChanges: ['Address the review notes and resubmit.'],
            },
          },
        ];
      }
      return [
        {
          name: 'submit_review',
          args: { verdict: 'accept', reasons: ['The rework addresses the notes.'] },
        },
      ];
    }
    default:
      throw new Error(`no script for employee '${employee}'`);
  }
}

const BACKEND_IDS = ['openai', 'anthropic', 'codex', 'pi'] as const;

const config = loadServerConfig();
const server = await assembleServer(config, {
  registerProductTables: registerProductStores,
  // Every declared backend id resolves to the SAME deterministic script — which employee's turn it
  // is arrives in the rendered input, so mixed bindings replay one story.
  agentBackendsFactory: () =>
    new Map<BackendId, Backend>(
      BACKEND_IDS.map((id) => [id, makeScriptedBackend(id, (spec) => scriptFor(spec))]),
    ),
});

serve({ fetch: server.app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[workforce-roles-e2e] serving on ${info.address}:${info.port}`);
});
