/**
 * The workforce TURN-HANDLER COMPOSITION — the one function that maps a dispatched task turn onto
 * an agent run: build the bounded read snapshot, compute the deterministic turn facts, recall the
 * employee's prior work, assemble the byte-budgeted turn input, inject the role toolset beside
 * the employee's declared agent tools, run the agent through the EXISTING run machinery, and hand
 * the collected intent (plus buffered messages/creates, the trusted review-policy match and the
 * derived classification) back to the engine.
 *
 * This module lives on the COMPOSITION side of the delegation dispatch boundary: it may reach the
 * run machinery precisely because nothing in the toolset package can. The handler honours the
 * scheduler's contract the way the run surface does: it makes NO workforce_* writes — every task
 * effect flows through the returned outcome — while the agent run journals under its own run id
 * exactly as any run does.
 *
 * The turn input is `assembleTurnInput` (@rayspec/workforce-tools): pure and byte-budgeted, so
 * what the model sees is a deterministic function of the rows and configuration this composition
 * feeds it. Recall is one bounded read (the task-history provider, constructed per turn with
 * TRUSTED scoping from the config and the task row); a whole-turn re-execution re-reads and may
 * re-rank against a moved clock — transcript variance only, the final application stays
 * receipted-idempotent. A goal that cannot fit its section throws typed
 * (`GoalExceedsContextBudgetError`) out of the handler, which the scheduler converts into the
 * declared `fail` fate — a misconfigured workforce fails loudly, never on a silently trimmed
 * instruction.
 *
 * Two fail-closed refusals guard composition-time invariants:
 *   - a declared agent tool named after a native is refused (the lint already rejects it at parse;
 *     this is the defense for a code-built spec that bypassed parse);
 *   - a declared agent tool with `idempotent: false` is refused on workforce turns — a turn body
 *     re-executes on recovery, and a side-effecting tool would re-fire. Lifting this needs a
 *     per-turn effect ledger, not a shrug.
 */

import type { AgentRegistry } from '@rayspec/api-auth';
import type { AgentSpec, Backend, NeutralTool, WorkforceMemoryProvider } from '@rayspec/core';
import { type Db, forTenant, type TenantDb } from '@rayspec/db';
import type {
  ResolveTurnHandler,
  TaskTurnContext,
  TaskTurnHandlerOutcome,
} from '@rayspec/durable-dbos';
import { runAgent } from '@rayspec/platform';
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import {
  assembleTurnInput,
  assertNoReservedCollisions,
  buildRoleToolset,
  buildWorkforceSnapshot,
  classifyTurnIntent,
  computeTurnFacts,
  isTurnEndingToolName,
  MALFORMED_TURN_ENDING,
  matchReviewPolicy,
  type RecallScope,
  TaskHistoryMemoryProvider,
  TurnCollector,
} from '@rayspec/workforce-tools';

export interface WorkforceTurnHandlerDeps {
  /** The WORKER pool handle (never the HTTP pool) — bound per turn via forTenant. */
  readonly db: Db;
  /** The deployment task tenant (the same single-deployment posture cron fires run under). */
  readonly tenantId: string;
  readonly config: WorkforceConfig;
  /** Late-bound: the registry binds inside buildApp during deploy() (the resolveRun pattern). */
  readonly registry: () => AgentRegistry | undefined;
  /** Test seam: replace the Backend an employee runs on (scripted turns). Absent in production. */
  readonly backendForEmployee?: (employee: WorkforceEmployeeConfig) => Backend | undefined;
  /**
   * The memory seam, per turn: absent means the shipped task-history provider, constructed with
   * the turn's trusted scope. A composition (or a test) replaces the RANKING here — the assembly
   * renders whatever hits arrive and never cares which provider answered.
   */
  readonly memoryProviderFor?: (tdb: TenantDb, scope: RecallScope) => WorkforceMemoryProvider;
}

/** A typed `fail` outcome — the engine's requeue/fail machinery reads the message. */
function failTurn(message: string): TaskTurnHandlerOutcome {
  return { intent: { kind: 'fail', message } };
}

/**
 * THE TOOL LIST ONE TURN OFFERS: the employee's DECLARED agent tools first, the runtime's NATIVE
 * role toolset LAST. The order IS the precedence rule, not presentation.
 *
 * `makeDispatchTool` indexes its list into `new Map(deps.tools.map(t => [t.spec.name, t]))`
 * (packages/kernel/platform/src/dispatch.ts) and a later entry OVERWRITES an earlier one — so
 * whichever side is spread last WINS a name collision. Natives spread last therefore win, which is
 * what `RESERVED_WORKFORCE_TOOL_NAMES`' rationale (@rayspec/core workforce-ids.ts) says happens and
 * what the two refusal doors above and at parse exist to make unreachable in the first place.
 * Spread the other way round — which is how this composition passed its list until the ordering was
 * corrected — those doors are the ONLY barrier; spread this way they are the second one, and a
 * collision that somehow reached dispatch would still resolve to the runtime's own tool rather than
 * to the agent pack's.
 *
 * The one visible consequence beyond precedence: this array is also the model-facing tool LIST
 * (run-core hands the backend `{...spec, tools: tools.map(t => t.spec)}`), so declared tools are now
 * presented before the natives. Nothing keys on that order — dispatch is by name, and the
 * cross-backend toolset parity gate shapes `buildRoleToolset`'s output, not this concatenation.
 *
 * Proven in `workforce-tool-precedence.test.ts` with BOTH refusal doors deliberately stepped around
 * (and the doors themselves re-asserted there on the same input), and the composition's own use of
 * it in `workforce-turn-validation.db.test.ts`.
 */
export function composeTurnTools(
  nativeTools: readonly NeutralTool[],
  agentTools: readonly NeutralTool[],
): NeutralTool[] {
  return [...agentTools, ...nativeTools];
}

/**
 * THE REPLAY-SAFETY DOOR: the first declared tool that is NOT safe to re-run, or `undefined` when the
 * whole list is. A workforce turn RE-EXECUTES on recovery, so a declared tool with `idempotent: false`
 * would re-fire its side effect; the composition refuses the turn rather than offering it.
 *
 * EXTRACTED FROM the inline `.find()` it used to be, and the extraction is the point: this door decides
 * which side-effecting capabilities a seat may hold at all, and nothing pinned it. It is what forces a
 * file-writing tool to be a WHOLE-FILE write (replaying one leaves the same end state, so `true` is
 * honest) rather than an append (replaying one doubles the file, so `false` is honest — and this door
 * then refuses it). A future edit that weakened it would silently admit appending writes onto a turn
 * that re-executes. Behaviour is byte-for-byte what the inline predicate did; only its name is new.
 */
export function findReplayUnsafeTool(agentTools: readonly NeutralTool[]): NeutralTool | undefined {
  return agentTools.find((tool) => tool.idempotent === false);
}

/**
 * Build the production owner→handler resolver for a declared workforce. An owner that is not a
 * declared employee resolves to nothing — the engine's existing typed failure covers it.
 */
export function buildWorkforceTurnHandlers(deps: WorkforceTurnHandlerDeps): ResolveTurnHandler {
  // The role frame is configuration, flattened once: declaration order, no per-turn variance.
  const workforceFrame = {
    name: deps.config.name,
    departments: [...deps.config.departments.entries()].map(([id, department]) => ({
      id,
      name: department.name,
      mission: department.mission,
    })),
  };
  return (owner: string) => {
    const employee = deps.config.employees.get(owner);
    if (!employee) return undefined;

    return async (ctx: TaskTurnContext): Promise<TaskTurnHandlerOutcome> => {
      const tdb = forTenant(deps.db, deps.tenantId);
      const snapshot = await buildWorkforceSnapshot(tdb, deps.config, ctx.task, employee);
      const collector = new TurnCollector({
        tenantId: deps.tenantId,
        taskId: ctx.task.taskId,
        // The dispatched turn number: turnsUsed is settled by the turn's FINAL application, so it
        // is frozen at (this turn − 1) for the whole run.
        turnNumber: ctx.task.turnsUsed + 1,
      });
      const nativeTools = buildRoleToolset({
        employee,
        config: deps.config,
        task: ctx.task,
        snapshot,
        collector,
      });

      const registry = deps.registry();
      const entry = registry?.get(employee.agent);
      if (!entry) {
        return failTurn(
          `agent '${employee.agent}' for employee '${employee.id}' is not registered — the ` +
            'workforce cannot run an undeclared agent. Fail-closed.',
        );
      }
      const agentTools = entry.toolFactory ? entry.toolFactory(tdb) : (entry.tools ?? []);
      try {
        assertNoReservedCollisions(agentTools);
      } catch (err) {
        return failTurn(err instanceof Error ? err.message : String(err));
      }
      const sideEffecting = findReplayUnsafeTool(agentTools);
      if (sideEffecting !== undefined) {
        return failTurn(
          `agent '${employee.agent}' declares the non-idempotent tool ` +
            `'${sideEffecting.spec.name}' — a workforce turn re-executes on recovery and would ` +
            're-fire its side effect. Fail-closed.',
        );
      }

      // RECALL — one bounded read through the chokepoint. Scoping is TRUSTED data (config + the
      // task row), never model input: the frozen query shape cannot carry it, so it rides the
      // provider's construction. The goal is the query — what this task is about is what prior
      // work is relevant to it.
      const recallScope: RecallScope = {
        workforceId: deps.config.id,
        employeeId: employee.id,
        department: employee.department,
        currentRootTaskId: ctx.task.rootTaskId,
        now: new Date(),
      };
      const memory =
        deps.memoryProviderFor?.(tdb, recallScope) ??
        new TaskHistoryMemoryProvider(tdb, recallScope);
      // An erased goal (migration 0013 made the column nullable so `journalScrub` can scrub it)
      // has nothing to recall AGAINST — an empty query scores every candidate at zero rather than
      // recalling on the literal string "null".
      const recall = await memory.search({ text: ctx.task.goal ?? '' });

      // THE TURN INPUT — pure assembly over verified facts. The scaffolding (facts.ts) computes
      // everything the runtime can answer before the model is invoked; a goal that cannot fit
      // throws typed out of this handler and takes the declared fail fate.
      const spec: AgentSpec = {
        ...entry.spec,
        input: assembleTurnInput({
          employee,
          task: ctx.task,
          turnNumber: ctx.task.turnsUsed + 1,
          workforce: workforceFrame,
          departmentMission:
            employee.department !== null
              ? (deps.config.departments.get(employee.department)?.mission ?? null)
              : null,
          facts: computeTurnFacts({ config: deps.config, employee, task: ctx.task, snapshot }),
          childResults: ctx.childResults,
          dependencyResults: snapshot.dependencyResults,
          signals: ctx.signals,
          messages: ctx.messages,
          recall,
        }),
        // Emission order IS the order of record: "the first turn-ending call" must not be a race.
        sequentialTools: true,
      };
      const backend = deps.backendForEmployee?.(employee) ?? entry.backend;
      const result = await runAgent(tdb, backend, spec, {
        // Natives LAST — see composeTurnTools: the dispatcher's by-name Map is last-wins, so this is
        // where "natives win, always" is made structurally true rather than only asserted above.
        tools: composeTurnTools(nativeTools, agentTools),
      });

      const collected = collector.finish();
      // WHAT THE ENGINE RECEIVES when no valid ending was collected. Never the model's own
      // arguments: forwarding those let a `submit_result` whose args failed the toolset's schema be
      // re-read by the engine as a valid intent of a DIFFERENT kind, with the review-policy match
      // (which keys on the collected intent, and saw none) passing null — a mandatory review
      // skipped by sending the wrong arguments to the right tool. A refused ending hands over the
      // typed sentinel instead, whose kind is outside the engine's closed union and so takes the
      // declared requeue-once-then-fail fate by construction.
      //
      // An ending REFUSED BEFORE the collector ever saw it counts too, and the transcript is the
      // only record of it: `dispatchTool` rejects arguments failing `inputSchema` without calling
      // the handler, so nothing is recorded and the run would otherwise look like one that simply
      // never ended its turn. Asking whether a turn-ending tool was CALLED distinguishes "tried to
      // end and was refused" from "never tried" — the first takes the fate, the second yields. A
      // backend reporting no transcript degrades to the yield, which is the safe direction.
      //
      // Asked through `isTurnEndingToolName`, which matches the NEUTRAL SUFFIX: adapters disagree
      // on the name they record (the Anthropic one bridges the toolset as an in-process MCP server
      // and keeps `mcp__rayspec__<tool>` verbatim), and a check that knew only the neutral form
      // left this fate open on exactly that adapter.
      const attemptedEnding = result.conversation.some((turn) =>
        turn.parts.some((part) => part.kind === 'tool_call' && isTurnEndingToolName(part.name)),
      );
      const intent =
        collected.intent ??
        (collected.malformed !== null || attemptedEnding
          ? MALFORMED_TURN_ENDING
          : { kind: 'yield' });
      // A review task's own completion is NEVER policy-reviewed (pendingReview marks a task that
      // exists to decide a review) — review dispatch therefore cannot recurse, and any task's
      // review chain stays exactly one level deep, bounded per round by its own round budget.
      const reviewPolicy =
        collected.intent?.kind === 'complete' && snapshot.pendingReview === null
          ? await matchReviewPolicy(deps.config, {
              employee,
              taskId: ctx.task.taskId,
              result: collected.intent.result,
            })
          : null;
      // CLASSIFICATION — derived from the COLLECTED intent (the validated one, never the
      // post-fallback value: a refused ending classifies nothing) and the seat's role. Journaled
      // by the engine on turn_ended; a pure function, so model prose can never steer it.
      const classification =
        collected.intent !== null ? classifyTurnIntent(collected.intent, employee.role) : null;
      return {
        intent,
        ...(collected.messages.length > 0 ? { messages: collected.messages } : {}),
        ...(collected.createdChildren.length > 0
          ? { createdChildren: collected.createdChildren }
          : {}),
        ...(reviewPolicy !== null ? { reviewPolicy } : {}),
        ...(classification !== null ? { classification } : {}),
        actualUsd: result.costUsd,
      };
    };
  };
}
