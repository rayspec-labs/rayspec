/**
 * The native workforce tools — `NeutralTool`s injected by ROLE at dispatch, composing with (and
 * shadowing nothing of) the employee's declared agent tools. Every handler is SYNCHRONOUS-FAST and
 * I/O-FREE: turn-ending tools validate their arguments and record the ONE intent on the collector;
 * buffering tools record messages/creates; read tools answer from the pre-built snapshot. A
 * handler throw surfaces through the dispatch chokepoint as a fail-closed typed `tool_error` the
 * model reads — the turn itself is never killed by it.
 *
 * ARGUMENTS ARE VALIDATED AT THE CHOKEPOINT FIRST. Every tool built here carries
 * `inputSchema: spec.parameters` (bound once at the return below, so a new tool cannot be added
 * without it), which is what makes `dispatchTool`'s Ajv validate-in run at all — it is guarded on
 * `if (tool.inputSchema)`, and a tool that declares only `spec.parameters` is dispatched with its
 * arguments UNVALIDATED. The adapters are deliberately permissive, so without this the model's raw
 * bytes reached a handler unchecked; the zod parse here is then the second, stricter pass, and the
 * ENGINE re-validates the resulting intent as the third. `reviewId` and every other linkage the
 * model must not choose is injected from the snapshot, never read from arguments.
 *
 * WHAT THE ENGINE MAY RECEIVE is a separate rule with the same root: a refused ending hands the
 * composition a typed SENTINEL (`MALFORMED_TURN_ENDING`), never the model's arguments. Forwarding
 * the raw value let a `submit_result` whose args failed this module's schema be re-read by the
 * engine as a perfectly valid intent of a different kind — which is how a mandatory review policy
 * could be skipped, since policy matching keys on the intent this module COLLECTED and there was
 * none. See collector.ts.
 */
import type { NeutralTool } from '@rayspec/core';
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import {
  ESCALATION_REASONS,
  MAX_MESSAGE_BODY_CHARS,
  MAX_MESSAGES_PER_TURN,
  type TaskRecord,
  turnIntentSchema,
  workerResultSchema,
} from '@rayspec/tasks';
import { z } from 'zod';
import type { TurnCollector } from './collector.js';
import {
  ApprovalEscalationTargetMissingError,
  EscalationTargetMissingError,
  ReservedToolNameError,
  TaskNotVisibleError,
  WorkforceToolError,
} from './errors.js';
import {
  assertManagerMayTarget,
  parseDelegationTarget,
  resolveDelegationTarget,
} from './resolve-target.js';
import { TOOLSETS_BY_ROLE, type ToolName } from './roles.js';
import type { WorkforceReadSnapshot } from './snapshot.js';

const TOOL_TIMEOUT_MS = 5_000;
const TERMINAL = ['completed', 'failed', 'cancelled'];

export interface RoleToolsetInput {
  readonly employee: WorkforceEmployeeConfig;
  readonly config: WorkforceConfig;
  readonly task: TaskRecord;
  readonly snapshot: WorkforceReadSnapshot;
  readonly collector: TurnCollector;
}

/** A declared agent tool may not carry a native name — natives win, so the collision is refused. */
export function assertNoReservedCollisions(agentTools: readonly NeutralTool[]): void {
  const nativeNames = new Set<string>(Object.values(TOOLSETS_BY_ROLE).flat());
  for (const tool of agentTools) {
    if (nativeNames.has(tool.spec.name)) throw new ReservedToolNameError(tool.spec.name);
  }
}

// ---- argument schemas (zod = source of truth; the JSON twin feeds the dispatch Ajv pass) --------

const delegateArgsSchema = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        target: z.string().min(1),
        title: z.string().min(1).max(200),
        goal: z.string().min(1),
        description: z.string().min(1).optional(),
        priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
      }),
    )
    .min(1),
});

const createArgsSchema = z.strictObject({
  title: z.string().min(1).max(200),
  goal: z.string().min(1),
  description: z.string().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});

const createSubtaskArgsSchema = createArgsSchema.extend({ target: z.string().min(1) });

const requestReviewArgsSchema = z.strictObject({ reviewer: z.string().min(1).optional() });

const requestApprovalArgsSchema = z.strictObject({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
});

const clarificationArgsSchema = z.strictObject({ question: z.string().min(1) });

const escalateArgsSchema = z.strictObject({
  reason: z.enum(ESCALATION_REASONS),
  detail: z.string().min(1).optional(),
});

const submitReviewArgsSchema = z.strictObject({
  verdict: z.enum(['accept', 'reject']),
  reasons: z.array(z.string().min(1)).optional(),
  requiredChanges: z.array(z.string().min(1)).optional(),
});

const cancelArgsSchema = z.strictObject({
  taskId: z.string().min(1),
  detail: z.string().min(1).optional(),
});

const sendMessageArgsSchema = z.strictObject({
  recipient: z.string().min(1),
  body: z.string().min(1).max(MAX_MESSAGE_BODY_CHARS),
});

const getTaskArgsSchema = z.strictObject({ taskId: z.string().min(1).optional() });

const listArgsSchema = z.strictObject({ status: z.string().min(1).optional() });

// ---- the default approval window when no declared approval rule covers the caller ---------------
const DEFAULT_APPROVAL_TIMEOUT_MS = 72 * 3_600_000;

/** Build the caller's native toolset for THIS turn. Keyed by the TASK's role — nothing inherits. */
export function buildRoleToolset(input: RoleToolsetInput): NeutralTool[] {
  const { employee, config, task, snapshot, collector } = input;

  /** Validate turn-ending args; a schema refusal is recorded (drives the engine fate) AND thrown. */
  const parseEnding = <T>(schema: z.ZodType<T>, args: unknown): T => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      collector.recordMalformed(args, parsed.error.message);
      throw new WorkforceToolError(`invalid arguments: ${parsed.error.message}`);
    }
    return parsed.data;
  };

  /** Buffering tools must precede the turn's ending call (slot arithmetic stays stable). */
  const assertTurnOpen = (): void => {
    const ended = collector.endedWith;
    if (ended !== null) {
      throw new WorkforceToolError(
        `this turn already ended with '${ended}' — messages and created tasks must be buffered ` +
          'BEFORE the turn-ending call.',
      );
    }
  };

  /**
   * A turn-ending tool that REFUSES records the refusal before it throws, so the turn lands on the
   * DECLARED tool-error fate (requeue once, then fail). Without the record a refused ending is
   * indistinguishable from a turn that never ended at all: the composition yields, the task
   * re-dispatches with a fresh budget, and a deterministic refusal loops for free. A later VALID
   * ending in the same turn clears the marker (`TurnCollector.finish`), so recording costs an
   * in-turn recovery nothing.
   */
  const refuseEnding: (args: unknown, err: WorkforceToolError) => never = (args, err) => {
    collector.recordMalformed(args, err.message);
    throw err;
  };

  const endTurn = (intent: unknown): { recorded: true; kind: string } => {
    // The INTENT layer refuses exactly as the argument layer does. A bare `.parse` here threw a
    // raw ZodError past the collector, so a turn whose ending failed the engine's own schema
    // yielded instead of taking the fate that schema refusal is supposed to drive.
    const parsed = turnIntentSchema.safeParse(intent);
    if (!parsed.success) {
      collector.recordMalformed(intent, parsed.error.message);
      throw new WorkforceToolError(`invalid turn-ending intent: ${parsed.error.message}`);
    }
    collector.recordIntent(parsed.data);
    return { recorded: true, kind: parsed.data.kind };
  };

  const summaryFor = (taskId: string) => snapshot.subtreeTasks.find((row) => row.taskId === taskId);

  const handlers: Record<ToolName, NeutralTool> = {
    submit_result: {
      spec: {
        name: 'submit_result',
        description:
          'End this turn by submitting the structured result of your task. Exactly one ' +
          'turn-ending tool may be called per turn.',
        parameters: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['completed', 'partial', 'failed', 'needs_clarification'],
            },
            summary: { type: 'string', minLength: 1 },
            findings: { type: 'array', items: { type: 'string' } },
            recommendations: { type: 'array', items: { type: 'string' } },
            artifacts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', minLength: 1 },
                  id: { type: 'string', minLength: 1 },
                  title: { type: 'string', minLength: 1 },
                },
                required: ['kind', 'id', 'title'],
                additionalProperties: false,
              },
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            needsFollowUp: { type: 'boolean' },
            suggestedFollowUp: { type: 'string', minLength: 1 },
          },
          required: ['status', 'summary', 'confidence'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const result = parseEnding(workerResultSchema, args);
        return endTurn({ kind: 'complete', result });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    delegate_task: {
      spec: {
        name: 'delegate_task',
        description:
          'End this turn by delegating one or more child tasks. Targets: employee:<id>, ' +
          'department:<id> (its manager answers), team:<id> (its lead answers). All children ' +
          'fan out together and this task waits for all of them.',
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  target: { type: 'string', minLength: 1 },
                  title: { type: 'string', minLength: 1, maxLength: 200 },
                  goal: { type: 'string', minLength: 1 },
                  description: { type: 'string', minLength: 1 },
                  priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
                },
                required: ['target', 'title', 'goal'],
                additionalProperties: false,
              },
            },
          },
          required: ['tasks'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { tasks } = parseEnding(delegateArgsSchema, args);
        // A target that does not resolve, or one this manager may not reach, is a REFUSED ENDING —
        // recorded so the turn takes the tool-error fate. It used to throw past the collector and
        // yield, which handed a deterministically forbidden delegation an unbounded retry loop.
        const children = tasks.map((entry) => {
          let target: ReturnType<typeof parseDelegationTarget>;
          let resolved: ReturnType<typeof resolveDelegationTarget>;
          try {
            target = parseDelegationTarget(entry.target);
            resolved = resolveDelegationTarget(config, target);
            if (employee.role === 'manager') {
              assertManagerMayTarget(config, employee, target, resolved);
            }
          } catch (err) {
            if (err instanceof WorkforceToolError) refuseEnding(args, err);
            throw err;
          }
          return {
            title: entry.title,
            goal: entry.goal,
            description: entry.description ?? null,
            owner: resolved.owner,
            department: resolved.department,
            delegatedTo: resolved.delegatedTo,
            ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
          };
        });
        return endTurn({ kind: 'fan_out', children });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    create_task: {
      spec: {
        name: 'create_task',
        description:
          'Create a child task you own yourself (planning; does not end the turn). Returns the ' +
          'task id. The row is written when the turn ends.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            goal: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          },
          required: ['title', 'goal'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        assertTurnOpen();
        const spec = createArgsSchema.parse(args);
        const taskId = collector.recordCreatedChild({
          title: spec.title,
          goal: spec.goal,
          description: spec.description ?? null,
          owner: employee.id,
          department: employee.department,
          ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
        });
        return { taskId };
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    create_subtask: {
      spec: {
        name: 'create_subtask',
        description:
          'Create a child task owned by a member of your department (does not end the turn). ' +
          'Returns the task id. The row is written when the turn ends.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1, maxLength: 200 },
            goal: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1 },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          },
          required: ['target', 'title', 'goal'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        assertTurnOpen();
        const spec = createSubtaskArgsSchema.parse(args);
        const target = parseDelegationTarget(spec.target);
        const resolved = resolveDelegationTarget(config, target);
        assertManagerMayTarget(config, employee, target, resolved);
        const taskId = collector.recordCreatedChild({
          title: spec.title,
          goal: spec.goal,
          description: spec.description ?? null,
          owner: resolved.owner,
          department: resolved.department,
          delegatedTo: resolved.delegatedTo,
          ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
        });
        return { taskId };
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    request_review: {
      spec: {
        name: 'request_review',
        description:
          'End this turn by sending your work for independent review. The reviewer defaults to ' +
          'the declared review policy covering you; you may only name a reviewer from those ' +
          "policies, your own superior, or 'user' — never yourself.",
        parameters: {
          type: 'object',
          properties: { reviewer: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { reviewer: requested } = parseEnding(requestReviewArgsSchema, args);
        // The reviewers THIS caller may reach: the declared policies covering them, their own
        // superior when that superior holds a decision role, and the human — NEVER themselves.
        // Review dispatch creates a real task, so an org-wide free choice would be a second,
        // unguarded delegation route around assertManagerMayTarget's scoping.
        const policyReviewers = config.reviewPolicies
          .filter(
            (rule) =>
              rule.appliesTo.employee === employee.id ||
              (rule.appliesTo.department !== undefined &&
                rule.appliesTo.department === employee.department),
          )
          .map((rule) => rule.reviewer);
        const superior = employee.reportsTo;
        const superiorRole = superior !== null ? config.employees.get(superior)?.role : undefined;
        const allowed = new Set<string>([
          'user',
          ...policyReviewers,
          ...(superiorRole === 'reviewer' || superiorRole === 'manager'
            ? [superior as string]
            : []),
        ]);
        allowed.delete(employee.id);
        const reviewer = requested ?? policyReviewers.find((id) => id !== employee.id) ?? 'user';
        if (!allowed.has(reviewer)) {
          refuseEnding(
            args,
            new WorkforceToolError(
              `'${reviewer}' is not a reviewer you may request — your reviewers are the declared ` +
                "policies covering you, your own superior (holding role 'reviewer' or 'manager'), " +
                "or 'user' for a human decision; never yourself.",
            ),
          );
        }
        if (reviewer !== 'user') {
          const target = config.employees.get(reviewer);
          if (!target || (target.role !== 'reviewer' && target.role !== 'manager')) {
            refuseEnding(
              args,
              new WorkforceToolError(
                `'${reviewer}' is not a declared reviewer — a reviewer holds role 'reviewer' or ` +
                  "'manager', or use 'user' for a human decision.",
              ),
            );
          }
        }
        return endTurn({
          kind: 'request_review',
          reviewer,
          dispatchReviewer: reviewer !== 'user' && config.employees.has(reviewer),
        });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    request_approval: {
      spec: {
        name: 'request_approval',
        description:
          'End this turn by asking a human for a decision. The declared approval rule covering ' +
          'your capabilities supplies the timeout and its fate.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', minLength: 1 },
            options: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
          required: ['question'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { question, options } = parseEnding(requestApprovalArgsSchema, args);
        const rule = config.approvals.find((candidate) =>
          candidate.capabilities.some((label) => employee.capabilities.includes(label)),
        );
        const onTimeout = rule?.onTimeout ?? 'fail';
        // An escalate fate must NAME its target, and the reporting edge is the only supplier. A
        // seat with no superior (the orchestrator, by lint requirement) therefore cannot request an
        // approval under an escalating rule at all — the intent would be refused by the planner as
        // `invalid_intent`, and the requeue would re-run the same deterministic condition straight
        // into permanent failure. The lint refuses such a document at parse; this is the defense
        // for a configuration built in code, and it keeps the fate typed and recorded.
        if (onTimeout === 'escalate' && employee.reportsTo === null) {
          refuseEnding(
            args,
            new ApprovalEscalationTargetMissingError(employee.id, rule?.id ?? '(unnamed)'),
          );
        }
        return endTurn({
          kind: 'request_approval',
          question,
          options: options ?? [],
          approver: 'user',
          timeoutMs: rule?.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
          onTimeout,
          ...(onTimeout === 'escalate' && employee.reportsTo !== null
            ? { escalateTo: employee.reportsTo }
            : {}),
        });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    request_clarification: {
      spec: {
        name: 'request_clarification',
        description:
          'End this turn by asking the requester a clarifying question. The task waits for the ' +
          'reply.',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', minLength: 1 } },
          required: ['question'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { question } = parseEnding(clarificationArgsSchema, args);
        return endTurn({ kind: 'request_clarification', question });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    escalate: {
      spec: {
        name: 'escalate',
        description:
          'End this turn by handing the task up your reporting line with a typed reason. Your ' +
          'superior receives it as a fresh task; yours waits for their reply.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', enum: [...ESCALATION_REASONS] },
            detail: { type: 'string', minLength: 1 },
          },
          required: ['reason'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { reason, detail } = parseEnding(escalateArgsSchema, args);
        const superior = employee.reportsTo;
        if (superior === null) refuseEnding(args, new EscalationTargetMissingError(employee.id));
        return endTurn({
          kind: 'escalate',
          reason,
          ...(detail !== undefined ? { detail } : {}),
          escalateTo: superior,
          escalateToDepartment: config.employees.get(superior)?.department ?? null,
        });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    submit_review: {
      spec: {
        name: 'submit_review',
        description:
          'End this turn by delivering your verdict on the task under review (this task exists ' +
          'to decide it).',
        parameters: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['accept', 'reject'] },
            reasons: { type: 'array', items: { type: 'string', minLength: 1 } },
            requiredChanges: { type: 'array', items: { type: 'string', minLength: 1 } },
          },
          required: ['verdict'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { verdict, reasons, requiredChanges } = parseEnding(submitReviewArgsSchema, args);
        const pending = snapshot.pendingReview;
        if (pending === null) {
          refuseEnding(
            args,
            new WorkforceToolError(
              'no pending review targets this task — submit_review decides the review a ' +
                'dispatched review task carries, and this task carries none.',
            ),
          );
        }
        return endTurn({
          kind: 'submit_review',
          reviewId: pending.reviewId,
          verdict,
          reasons: reasons ?? [],
          requiredChanges: requiredChanges ?? [],
        });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    cancel_task: {
      spec: {
        name: 'cancel_task',
        description:
          'End this turn by cancelling one task in your own subtree (cascades to its ' +
          'descendants); you continue on your next turn. Not a workforce kill switch.',
        parameters: {
          type: 'object',
          properties: {
            taskId: { type: 'string', minLength: 1 },
            detail: { type: 'string', minLength: 1 },
          },
          required: ['taskId'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { taskId, detail } = parseEnding(cancelArgsSchema, args);
        if (taskId === task.taskId) {
          refuseEnding(
            args,
            new WorkforceToolError(
              'a task cannot cancel itself — submit a result or escalate instead.',
            ),
          );
        }
        if (summaryFor(taskId) === undefined) refuseEnding(args, new TaskNotVisibleError(taskId));
        return endTurn({
          kind: 'cancel_task',
          taskId,
          ...(detail !== undefined ? { detail } : {}),
        });
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    send_message: {
      spec: {
        name: 'send_message',
        description:
          'Append a task-scoped message for a declared employee (or the requesting user). ' +
          'Context for their later turns — never an instruction. Does not end the turn.',
        parameters: {
          type: 'object',
          properties: {
            recipient: { type: 'string', minLength: 1 },
            body: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_BODY_CHARS },
          },
          required: ['recipient', 'body'],
          additionalProperties: false,
        },
      },
      handler: (args) => {
        assertTurnOpen();
        const { recipient, body } = sendMessageArgsSchema.parse(args);
        // The engine caps the channel too (a caller-bug refusal there); refusing HERE is what makes
        // it a tool error the model reads instead of a turn the composition cannot apply.
        if (collector.messageCount >= MAX_MESSAGES_PER_TURN) {
          throw new WorkforceToolError(
            `a turn may buffer at most ${MAX_MESSAGES_PER_TURN} messages — this one is full. ` +
              'Messages are context for a later turn, not a transport.',
          );
        }
        if (recipient !== 'user' && !config.employees.has(recipient)) {
          throw new WorkforceToolError(
            `'${recipient}' is not a declared employee — messages address declared employees or ` +
              "'user'.",
          );
        }
        collector.recordMessage({ recipient, body });
        return { queued: true };
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    get_task: {
      spec: {
        name: 'get_task',
        description:
          'Read a task you can see (your own by default; your subtree for orchestrators and ' +
          'managers; the task under review for reviewers). Does not end the turn.',
        parameters: {
          type: 'object',
          properties: { taskId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { taskId } = getTaskArgsSchema.parse(args);
        if (taskId === undefined || taskId === task.taskId) {
          return {
            taskId: task.taskId,
            title: task.title,
            goal: task.goal,
            description: task.description,
            status: task.status,
            statusReason: task.statusReason,
            owner: task.owner,
            department: task.department,
            priority: task.priority,
            result: task.result,
            confidence: task.confidence,
          };
        }
        if (snapshot.parentTask !== null && taskId === snapshot.parentTask.taskId) {
          const parent = snapshot.parentTask;
          return {
            taskId: parent.taskId,
            title: parent.title,
            goal: parent.goal,
            description: parent.description,
            status: parent.status,
            statusReason: parent.statusReason,
            owner: parent.owner,
            department: parent.department,
            priority: parent.priority,
            result: parent.result,
            confidence: parent.confidence,
          };
        }
        const summary = summaryFor(taskId);
        if (summary === undefined) throw new TaskNotVisibleError(taskId);
        return summary;
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    get_workforce_state: {
      spec: {
        name: 'get_workforce_state',
        description:
          'Read the workforce overview: departments, open task counts, budget headroom. Does not ' +
          'end the turn.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
      handler: () => {
        if (snapshot.workforceState === null) {
          throw new WorkforceToolError('the workforce state view is not available to this role.');
        }
        return snapshot.workforceState;
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    list_open_tasks: {
      spec: {
        name: 'list_open_tasks',
        description:
          'List the non-terminal tasks in your own subtree (page-capped). Does not end the turn.',
        parameters: {
          type: 'object',
          properties: { status: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { status } = listArgsSchema.parse(args);
        return snapshot.subtreeTasks.filter(
          (row) =>
            !TERMINAL.includes(row.status) && (status === undefined || row.status === status),
        );
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },

    list_department_tasks: {
      spec: {
        name: 'list_department_tasks',
        description:
          "List your department's non-terminal tasks (page-capped). Does not end the turn.",
        parameters: {
          type: 'object',
          properties: { status: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
      },
      handler: (args) => {
        const { status } = listArgsSchema.parse(args);
        return snapshot.departmentTasks.filter(
          (row) => status === undefined || row.status === status,
        );
      },
      timeoutMs: TOOL_TIMEOUT_MS,
      idempotent: true,
    },
  };

  // A REVIEW TASK does not carry `request_review`. The role table grants it to every role, and a
  // reviewer employee running an ordinary task should keep it — but a task dispatched to DECIDE a
  // review (the one with a pending review on its snapshot) commissioning a review of its own is an
  // unbounded chain: `reviewRoundsUsed` restarts at zero on every task, so with no declared
  // execution ceiling nothing bounds it. The engine refuses the intent as well
  // (`rejectReviewChildEnding`); not offering the tool is what keeps the model from spending a
  // turn discovering that.
  // A REVIEW TASK does not carry `request_review`. The role table grants it to every role, and a
  // reviewer employee running an ordinary task should keep it — but a task dispatched to DECIDE a
  // review (the one its parent's park binding names) commissioning a review of its own is an
  // unbounded chain: `reviewRoundsUsed` restarts at zero on every task, so with no declared
  // execution ceiling nothing bounds it. The engine refuses the intent as well
  // (`rejectReviewChildEnding`); not offering the tool is what keeps the model from spending a turn
  // discovering that.
  //
  // The converse is deliberately NOT done: `submit_review` stays on the role table's terms for
  // every role that holds it, and refuses fail-closed when the task carries no review to decide.
  // Making the offered SET depend on the task in both directions would put the role tables and the
  // snapshot in competition over what a role carries, and the role tables are the single source
  // the privilege suite pins.
  const withheld: ReadonlySet<ToolName> =
    snapshot.pendingReview !== null ? new Set<ToolName>(['request_review']) : new Set<ToolName>();
  return (
    TOOLSETS_BY_ROLE[employee.role]
      .filter((name) => !withheld.has(name))
      // BIND THE VALIDATE-IN here rather than on each entry: `dispatchTool` runs its Ajv pass only
      // when `inputSchema` is present, so a tool that declared just `spec.parameters` was dispatched
      // with unvalidated arguments. Binding it at the one return means a tool added to the table
      // above cannot miss it, and the schema the model is shown is by construction the schema its
      // arguments are checked against.
      .map((name) => ({ ...handlers[name], inputSchema: handlers[name].spec.parameters }))
  );
}
