/**
 * The workforce ACCEPTANCE-STORY BOOT SCRIPT — a real composed server deploying the SHIPPED
 * starter example (`RAYSPEC_SPEC_PATH` points at `examples/workforce-starter/rayspec.yaml`
 * itself; no copy, no fixture twin, so what the story proves is that file's actual behavior).
 * The only injection is the ordinary `agentBackendsFactory` seam: the starter binds every agent
 * to one backend id, and that id resolves to a scripted backend replaying deterministic tool
 * calls through the real dispatch chokepoint. Everything downstream is the production path.
 *
 * Every script is a PURE FUNCTION of the dispatched turn's rendered input (employee id, turn
 * number, child results, signal history, review round) — a re-executed turn replays the
 * identical calls. The anchors parsed here are the SAME regexes the roles story's serve script
 * uses; a rendering change that breaks them breaks both suites loudly, never silently.
 *
 * Per-turn COST is scripted too (flat per-employee rates, a pure function of the same input), so
 * the story's tree and cost assertions prove dollars FLOW — settlement → task row → endpoint →
 * rendered bytes — rather than that a rendering formats zero.
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

/** The child task ids a synthesis turn sees, straight from the rendered keyed results. */
function childIdsOf(spec: AgentSpec): string[] {
  const start = spec.input.indexOf('Completed child results');
  const section = start >= 0 ? spec.input.slice(start) : '';
  return [...section.matchAll(/"([0-9a-f-]{36})":/g)].map((m) => m[1] as string).sort();
}

const submit = (summary: string, confidence: number): TurnScript => [
  { name: 'submit_result', args: { status: 'completed', summary, confidence } },
];

/**
 * The starter cast replays the ten-step story: the orchestrator fans out to BOTH departments →
 * engineering splits across its two workers → the principal's low-confidence submission trips
 * the declared review policy → reject round 1 → rework (still under the threshold) → accept
 * round 2 → the copywriter drafts the announcement and the GROWTH MANAGER (the seat holding
 * both the public_statement label and the request_approval tool) asks for the declared human
 * sign-off → (the process is killed and rebooted here; the decision arrives through the real
 * CLI) → the orchestrator
 * wakes with the children's results keyed by id and submits a synthesis that is a PURE FUNCTION
 * of those ids.
 */
function scriptFor(spec: AgentSpec): TurnScript {
  const employee = employeeOf(spec);
  switch (employee) {
    case 'lead': {
      if (hasChildResults(spec)) {
        return submit(`Synthesis of ${childIdsOf(spec).join(',')}`, 0.97);
      }
      return [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              {
                target: 'department:eng',
                title: 'Engineering',
                goal: 'Analyze the onboarding friction and verify the fix.',
              },
              {
                target: 'department:growth',
                title: 'Growth',
                goal: 'Draft the fix announcement for publication.',
              },
            ],
          },
        },
      ];
    }
    case 'mgr_eng': {
      if (hasChildResults(spec)) {
        return submit('Engineering: friction analyzed and the fix verified.', 0.95);
      }
      return [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              {
                target: 'employee:principal_eng',
                title: 'Deep analysis',
                goal: 'Find where onboarding actually loses people.',
              },
              {
                target: 'employee:devops',
                title: 'Release pipeline',
                goal: 'Verify the fix ships cleanly.',
              },
            ],
          },
        },
      ];
    }
    case 'mgr_growth': {
      // Three turns: delegate the draft, then — as the seat that answers for public output and
      // holds both the label and the tool — request the human sign-off, then merge after it.
      if (hasApproval(spec)) {
        return submit('Growth: the announcement is drafted and approved.', 0.9);
      }
      if (hasChildResults(spec)) {
        return [
          {
            name: 'request_approval',
            args: {
              question: 'May the fix announcement ship publicly?',
              options: ['publish', 'hold'],
            },
          },
        ];
      }
      return [
        {
          name: 'delegate_task',
          args: {
            tasks: [
              {
                target: 'employee:copywriter',
                title: 'Announcement',
                goal: 'Write the public fix announcement.',
              },
            ],
          },
        },
      ];
    }
    // The review loop: both submissions sit under the declared 0.8 threshold, so the policy
    // demands review each round — reject round 1, rework, accept round 2.
    case 'principal_eng':
      return turnOf(spec) === 1
        ? submit('Onboarding loses most users at the database step.', 0.6)
        : submit('Reworked: the database step, with the measurements attached.', 0.75);
    case 'devops':
      return submit('The fix ships cleanly through the pipeline.', 0.9);
    case 'copywriter':
      // One drafting turn — and the PREFIXED transcript shape on purpose: one production adapter
      // records bridged `mcp__rayspec__<tool>` names verbatim, and the story drives that form
      // end to end.
      return [
        {
          name: 'submit_result',
          recordedName: 'mcp__rayspec__submit_result',
          args: {
            status: 'completed',
            summary: 'Announcement drafted for sign-off.',
            confidence: 0.9,
          },
        },
      ];
    case 'qa': {
      const round = roundOf(spec);
      if (round === 1) {
        return [
          {
            name: 'submit_review',
            args: {
              verdict: 'reject',
              reasons: ['The analysis needs the measurements behind it.'],
              requiredChanges: ['Attach the funnel measurements and resubmit.'],
            },
          },
        ];
      }
      return [
        {
          name: 'submit_review',
          args: { verdict: 'accept', reasons: ['The rework carries its evidence.'] },
        },
      ];
    }
    default:
      throw new Error(`no script for employee '${employee}'`);
  }
}

/** Flat per-employee turn rates — the exact dollars the story's tree golden sums. */
const COST_PER_TURN: Readonly<Record<string, number>> = {
  lead: 0.05,
  mgr_eng: 0.04,
  mgr_growth: 0.04,
  principal_eng: 0.03,
  devops: 0.02,
  copywriter: 0.03,
  qa: 0.01,
};
function costUsdFor(spec: AgentSpec): number {
  const rate = COST_PER_TURN[employeeOf(spec)];
  if (rate === undefined) throw new Error(`no scripted cost for employee '${employeeOf(spec)}'`);
  return rate;
}

const config = loadServerConfig();
const server = await assembleServer(config, {
  registerProductTables: registerProductStores,
  // The starter binds one backend id on purpose (the live path needs one credential); the same
  // id here resolves to the scripted story.
  agentBackendsFactory: () =>
    new Map<BackendId, Backend>([
      ['openai', makeScriptedBackend('openai', (spec) => scriptFor(spec), { costUsdFor })],
    ]),
});

serve({ fetch: server.app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[workforce-story-e2e] serving on ${info.address}:${info.port}`);
});
