/**
 * The turn-input CONTEXT ASSEMBLY — one PURE function from verified facts to the byte-bounded,
 * numbered-section input string an employee's turn runs on. Same inputs → byte-identical output:
 * no clock (every timestamp arrives on the inputs; recall ages arrive pre-stamped in the hit
 * text), no locale-dependent formatting (`toFixed`/`toISOString`/`JSON.stringify` only), and
 * every ordering is defined — children and dependencies by task id ascending, messages and
 * signals in their given (oldest-first) order, recall in its given (rank) order, config lists in
 * declaration order.
 *
 * THE SECTIONS, in order: (1) identity, (2) role frame, (3) policies in force, (4) the task,
 * (5) completed child results keyed by child task id, (6) recent messages, (7) recall. Sections
 * 1–4 are mandatory; 5–7 are elastic. Each section has a fixed byte budget below, and the
 * per-item rules inside a section drop or truncate DETERMINISTICALLY with an explicit marker —
 * silent truncation is how a turn quietly runs on different facts than the operator thinks.
 *
 * TRUNCATION DROPS THE HIGHEST-NUMBERED SECTIONS FIRST: when the assembled input exceeds
 * `TURN_INPUT_MAX_BYTES`, section 7 is dropped whole, then 6, then 5 — recall is the cheapest
 * loss and the task itself is never the price. THE GOAL IS NEVER TRIMMED: a goal that cannot fit
 * section 4's budget is a misconfigured workforce, and the assembly says so with a typed error
 * (`GoalExceedsContextBudgetError`) instead of quietly shortening the instruction; the other
 * mandatory sections are config-derived and overflow the same way (`ContextSectionOverflowError`)
 * rather than rendering a partial identity or a partial policy list.
 *
 * The subtree and department task lists are deliberately NOT rendered — the read tools answer
 * those from the snapshot on demand, and rendering them would spend the byte budget on what a
 * tool call can fetch precisely.
 *
 * The scripted-turn fixtures parse this rendering. The stable anchors, kept byte-compatible with
 * the pre-sectioned composition: line 1 (`You are '<id>' (<title>), role '<role>'.`), line 2
 * (`DATA_BOUNDARY_LINE`), the `Turn <n>.` sentence, the goal rendered VERBATIM on its own line,
 * section 5's header phrase `Completed child results`, and the `- <kind>: <payload>` signal
 * lines. Changing any of these is a fixture-lockstep change, not a wording tweak.
 */
import type { MemoryHit } from '@rayspec/core';
import type { WorkforceEmployeeConfig } from '@rayspec/spec';
import type { MergedChildResult, TaskRecord } from '@rayspec/tasks';
import type { TurnFacts } from './facts.js';
import {
  DATA_BOUNDARY_LINE,
  ROLE_GUIDANCE,
  SECTION_HEADERS,
  TURN_ENDING_REMINDER,
} from './prompt.js';

/**
 * The whole-input ceiling and the per-section budgets, in bytes (utf-8). Deliberately coherent:
 * the mandatory budgets (1–4) plus guidance fit the ceiling with room (the module-load assert
 * below), the elastic budgets (5–7) sum PAST the remaining room, so the 7→6→5 drop chain is a
 * real behavior under real inputs, not dead code (including the final drop: a maximal section 4
 * plus a near-budget section 5 exceeds the ceiling, so even children can lawfully fall) — and
 * the task section is well over twice the goal-intake route's byte cap, so a goal accepted over
 * HTTP always renders untrimmed.
 */
export const TURN_INPUT_MAX_BYTES = 65_536;
export const SECTION_BUDGETS = Object.freeze({
  identity: 1_024,
  roleFrame: 4_096,
  policies: 8_192,
  task: 45_056,
  children: 24_576,
  messages: 12_288,
  recall: 4_096,
});
/** One child result's render ceiling; past it the entry falls back to its compact form. */
export const CHILD_RESULT_MAX_BYTES = 4_096;
/** One signal payload's render ceiling inside section 4. */
export const SIGNAL_PAYLOAD_MAX_BYTES = 512;

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

// The drop chain must terminate with the mandatory sections and guidance standing: if their
// budgets alone could exceed the whole-input ceiling, dropping 7/6/5 would strand an input no
// rule can shrink. Asserted at module load, exactly like the roles table's reserved-name check.
const MANDATORY_CEILING =
  SECTION_BUDGETS.identity +
  SECTION_BUDGETS.roleFrame +
  SECTION_BUDGETS.policies +
  SECTION_BUDGETS.task;
const GUIDANCE_CEILING =
  Math.max(...Object.values(ROLE_GUIDANCE).map((text) => bytesOf(text))) +
  bytesOf(TURN_ENDING_REMINDER) +
  1_024; /* headers + joiners, generously */
if (MANDATORY_CEILING + GUIDANCE_CEILING >= TURN_INPUT_MAX_BYTES) {
  throw new Error(
    'context assembly budgets are incoherent: the mandatory sections plus guidance ' +
      `(${MANDATORY_CEILING + GUIDANCE_CEILING} bytes) do not fit TURN_INPUT_MAX_BYTES ` +
      `(${TURN_INPUT_MAX_BYTES}) — the truncation chain could not terminate. Fix the constants.`,
  );
}

/** A mandatory, config-derived section outgrew its budget — a misconfigured workforce, refused. */
export class ContextSectionOverflowError extends Error {
  readonly section: string;
  constructor(section: string, rendered: number, budget: number) {
    super(
      `turn-input section '${section}' renders to ${rendered} bytes against a ${budget}-byte ` +
        'budget. This section is derived from the deployed document, so the fix is the document ' +
        '(shorter missions, fewer capabilities), never a silent trim. Fail-closed.',
    );
    this.name = 'ContextSectionOverflowError';
    this.section = section;
  }
}

/** THE GOAL IS NEVER TRIMMED. A goal that cannot fit its section is refused, typed. */
export class GoalExceedsContextBudgetError extends Error {
  readonly taskId: string;
  constructor(taskId: string, goalBytes: number, availableBytes: number) {
    super(
      `task '${taskId}' carries a ${goalBytes}-byte goal, but section 4 has ${availableBytes} ` +
        'bytes for it. The goal is the instruction and is never trimmed — a workforce that ' +
        'cannot fit its own goal is misconfigured. Fail-closed.',
    );
    this.name = 'GoalExceedsContextBudgetError';
    this.taskId = taskId;
  }
}

/** The minimal row shapes the assembly reads — structural, so pure tests need no driver rows. */
export interface TurnSignalFact {
  readonly kind: string;
  readonly payload: unknown;
}
export interface TurnMessageFact {
  readonly sender: string;
  readonly recipient: string;
  readonly body: string;
}

export interface TurnInputFacts {
  readonly employee: WorkforceEmployeeConfig;
  readonly task: TaskRecord;
  /** The dispatched turn's 1-based number (frozen for the whole run — see the composition). */
  readonly turnNumber: number;
  /** The workforce shape for the orchestrator's role frame; departments in declaration order. */
  readonly workforce: {
    readonly name: string;
    readonly departments: readonly { id: string; name: string; mission: string }[];
  };
  /** The member's own department mission (role frame for non-orchestrator seats). */
  readonly departmentMission: string | null;
  readonly facts: TurnFacts;
  readonly childResults: Readonly<Record<string, MergedChildResult>> | null;
  readonly dependencyResults: Readonly<Record<string, MergedChildResult>> | null;
  /** Oldest first (the scheduler's context order). */
  readonly signals: readonly TurnSignalFact[];
  /** Oldest first. */
  readonly messages: readonly TurnMessageFact[];
  /** Rank order, best first; hit text arrives pre-stamped with task id and age. */
  readonly recall: readonly MemoryHit[];
}

/** Truncate to a utf-8 byte budget on a character boundary, deterministically. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (bytesOf(text) <= maxBytes) return text;
  let sliced = text.slice(0, maxBytes); // ≥ the byte target is impossible to undershoot by chars
  while (sliced.length > 0 && bytesOf(sliced) > maxBytes) {
    sliced = sliced.slice(0, -1);
  }
  return sliced;
}

const TRUNCATED_MARKER = '…[truncated: byte budget]';

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Deterministic human window: whole hours as `Nh`, else whole minutes as `Nm`, else `Nms`. */
function windowLabel(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${ms}ms`;
}

function renderIdentity(input: TurnInputFacts): string {
  const { employee } = input;
  const capabilities =
    employee.capabilities.length > 0 ? employee.capabilities.join(', ') : 'none declared';
  return [
    SECTION_HEADERS.identity,
    `Employee: ${employee.id} — ${employee.title}. Role: ${employee.role}.`,
    `Capabilities: ${capabilities}.`,
  ].join('\n');
}

function renderRoleFrame(input: TurnInputFacts): string {
  const lines: string[] = [SECTION_HEADERS.roleFrame];
  if (input.employee.role === 'orchestrator') {
    lines.push(`Workforce: ${input.workforce.name}.`);
    if (input.workforce.departments.length === 0) {
      lines.push('No departments are declared.');
    } else {
      lines.push('Departments:');
      for (const department of input.workforce.departments) {
        lines.push(`- ${department.id} (${department.name}): ${department.mission}`);
      }
    }
  } else {
    if (input.employee.department !== null && input.departmentMission !== null) {
      lines.push(`Department: ${input.employee.department} — ${input.departmentMission}`);
    } else {
      lines.push('You belong to no department.');
    }
    if (input.employee.reportsTo !== null) {
      lines.push(`You report to '${input.employee.reportsTo}'.`);
    }
  }
  return lines.join('\n');
}

function renderPolicies(input: TurnInputFacts): string {
  const { facts } = input;
  const lines: string[] = [SECTION_HEADERS.policies];

  const b = facts.budget;
  if (b.workforceCeilingUsd === null) {
    lines.push('Budget: no workforce ceiling declared.');
  } else if (b.workforceConsumedUsd !== null && b.workforceHeadroomUsd !== null) {
    lines.push(
      `Budget: workforce ceiling ${usd(b.workforceCeilingUsd)} this window — consumed ` +
        `${usd(b.workforceConsumedUsd)}, headroom ${usd(b.workforceHeadroomUsd)}.`,
    );
  } else {
    lines.push(
      `Budget: workforce ceiling ${usd(b.workforceCeilingUsd)} this window (live spend is not ` +
        'visible from this seat).',
    );
  }
  const taskCeilings: string[] = [];
  if (b.taskCeilingUsd !== null) taskCeilings.push(usd(b.taskCeilingUsd));
  if (b.taskCeilingTurns !== null) taskCeilings.push(`${b.taskCeilingTurns} turns`);
  lines.push(
    taskCeilings.length > 0
      ? `Per-task ceilings: ${taskCeilings.join(', ')}.`
      : 'Per-task ceilings: none declared.',
  );

  if (facts.legalTargets.length > 0) {
    const depthLabel =
      facts.delegationDepthRemaining !== null
        ? `depth remaining ${facts.delegationDepthRemaining}`
        : 'no depth ceiling';
    const fanOutLabel =
      facts.delegationsPerTaskLimit !== null
        ? `up to ${facts.delegationsPerTaskLimit} children per task`
        : 'no per-task fan-out ceiling';
    lines.push(`Delegation: ${depthLabel}, ${fanOutLabel}.`);
    lines.push(`Legal delegation targets: ${facts.legalTargets.join(', ')}.`);
  } else {
    lines.push('Delegation: your toolset carries no delegation tool on this task.');
  }

  if (facts.reviewRules.length === 0) {
    lines.push('Review rules covering you: none declared.');
  } else {
    lines.push('Review rules covering you (first match applies):');
    for (const rule of facts.reviewRules) {
      const triggers: string[] = [];
      if (rule.firesOnCapabilities.length > 0) {
        triggers.push(
          `fires on every completion (you hold: ${rule.firesOnCapabilities.join(', ')})`,
        );
      }
      if (rule.confidenceBelow !== null) {
        triggers.push(`fires on a submitted confidence below ${rule.confidenceBelow}`);
      }
      const trigger = triggers.length > 0 ? triggers.join('; ') : 'declared without a trigger';
      lines.push(
        `- ${rule.id}: reviewer '${rule.reviewer}', ${trigger}; up to ${rule.maxRounds} rounds.`,
      );
    }
    lines.push(
      'A matched rule routes your completion to review no matter what your turn submits — the ' +
        'runtime enforces it.',
    );
  }

  if (facts.approvalRule !== null) {
    lines.push(
      `Approval rule covering you: ${facts.approvalRule.id} — request_approval runs on its ` +
        `declared window (${windowLabel(facts.approvalRule.timeoutMs)}, then ` +
        `${facts.approvalRule.onTimeout}).`,
    );
  } else {
    lines.push('Approval rule covering you: none declared for your capabilities.');
  }
  return lines.join('\n');
}

/** One child/dependency entry, rendered whole when it fits and compacted (never invalid JSON)
 * when it does not — the compact form keeps the typed fields and slices only the summary. */
function renderMergedResult(entry: MergedChildResult): string {
  const whole = JSON.stringify(entry, null, 1);
  if (bytesOf(whole) <= CHILD_RESULT_MAX_BYTES) return whole;
  const summary =
    typeof entry.result === 'object' && entry.result !== null && 'summary' in entry.result
      ? String((entry.result as { summary: unknown }).summary)
      : null;
  return JSON.stringify(
    {
      status: entry.status,
      statusReason: entry.statusReason,
      confidence: entry.confidence,
      costUsd: entry.costUsd,
      turnsUsed: entry.turnsUsed,
      ...(summary !== null ? { summary: truncateToBytes(summary, 1_024) } : {}),
      truncated: TRUNCATED_MARKER,
    },
    null,
    1,
  );
}

/** Render a keyed result map (children, dependencies) inside a byte budget: entries by task id
 * ascending, dropped from the HIGHEST id down when over budget, with an explicit marker. */
function renderKeyedResults(
  results: Readonly<Record<string, MergedChildResult>>,
  budget: number,
  headerLines: readonly string[],
): string | null {
  const ids = Object.keys(results).sort();
  if (ids.length === 0) return null;
  let kept = ids.length;
  for (;;) {
    const body = [
      '{',
      ...ids.slice(0, kept).map((id, index) => {
        const comma = index < kept - 1 ? ',' : '';
        return `"${id}": ${renderMergedResult(results[id] as MergedChildResult)}${comma}`;
      }),
      '}',
    ].join('\n');
    const omitted = ids.length - kept;
    const lines = [
      ...headerLines,
      body,
      ...(omitted > 0 ? [`[…${omitted} omitted: byte budget]`] : []),
    ];
    const rendered = lines.join('\n');
    if (bytesOf(rendered) <= budget || kept === 0) {
      return kept === 0 ? null : rendered;
    }
    kept -= 1;
  }
}

function renderTask(input: TurnInputFacts): string {
  const { task } = input;
  const fixedTop = [SECTION_HEADERS.task, `Task ${task.taskId}: ${task.title}`];
  const goalLine = `Goal: ${task.goal}`;
  const metaLine =
    `Requested by: ${task.requestedBy}. Priority: ${task.priority}. ` + `Turn ${input.turnNumber}.`;
  const deadlineLine =
    task.deadlineAt instanceof Date ? `Deadline: ${task.deadlineAt.toISOString()}` : null;

  // THE GOAL IS NEVER TRIMMED: the section's fixed lines plus the verbatim goal must fit, or the
  // assembly refuses typed. Everything below (description, dependencies, signals) shares what
  // remains and truncates item-wise with markers.
  const fixedLines = [...fixedTop, goalLine, metaLine, ...(deadlineLine ? [deadlineLine] : [])];
  const fixedBytes = bytesOf(fixedLines.join('\n'));
  if (fixedBytes > SECTION_BUDGETS.task) {
    const overhead = fixedBytes - bytesOf(task.goal);
    throw new GoalExceedsContextBudgetError(
      task.taskId,
      bytesOf(task.goal),
      Math.max(SECTION_BUDGETS.task - overhead, 0),
    );
  }
  let remaining = SECTION_BUDGETS.task - fixedBytes;

  const lines = [...fixedTop, goalLine];
  if (task.description !== null) {
    const label = 'Description: ';
    const room = remaining - bytesOf(`\n${label}${TRUNCATED_MARKER}`);
    const description =
      bytesOf(task.description) + bytesOf(`\n${label}`) <= remaining
        ? task.description
        : room > 0
          ? truncateToBytes(task.description, room) + TRUNCATED_MARKER
          : null;
    if (description !== null) {
      const line = `${label}${description}`;
      lines.push(line);
      remaining -= bytesOf(`\n${line}`);
    }
  }
  lines.push(metaLine);
  if (deadlineLine) lines.push(deadlineLine);

  if (input.dependencyResults !== null && Object.keys(input.dependencyResults).length > 0) {
    const block = renderKeyedResults(input.dependencyResults, remaining - bytesOf('\n\n'), [
      'Dependency results, keyed by task id:',
    ]);
    if (block !== null) {
      lines.push('', block);
      remaining -= bytesOf(`\n\n${block}`);
    }
  }

  if (input.signals.length > 0) {
    // Signals render oldest-first; when over budget the OLDEST drop first (the wake that
    // re-queued this turn is the newest and is the one the turn must not lose).
    const rendered = input.signals.map((signal) => {
      const payload = JSON.stringify(signal.payload) ?? 'null';
      const capped =
        bytesOf(payload) <= SIGNAL_PAYLOAD_MAX_BYTES
          ? payload
          : truncateToBytes(payload, SIGNAL_PAYLOAD_MAX_BYTES) + TRUNCATED_MARKER;
      return `- ${signal.kind}: ${capped}`;
    });
    let dropped = 0;
    for (;;) {
      const kept = rendered.slice(dropped);
      const block = [
        'Signal history (oldest first):',
        ...(dropped > 0 ? [`[…${dropped} earlier signals omitted: byte budget]`] : []),
        ...kept,
      ].join('\n');
      if (bytesOf(`\n\n${block}`) <= remaining || kept.length === 0) {
        if (kept.length > 0) {
          lines.push('', block);
          remaining -= bytesOf(`\n\n${block}`);
        }
        break;
      }
      dropped += 1;
    }
  }
  return lines.join('\n');
}

function renderMessages(messages: readonly TurnMessageFact[]): string | null {
  if (messages.length === 0) return null;
  const rendered = messages.map((m) => `- from ${m.sender} to ${m.recipient}: ${m.body}`);
  let dropped = 0;
  for (;;) {
    const kept = rendered.slice(dropped);
    if (kept.length === 0) return null;
    const block = [
      SECTION_HEADERS.messages,
      ...(dropped > 0 ? [`[…${dropped} earlier messages omitted: byte budget]`] : []),
      ...kept,
    ].join('\n');
    if (bytesOf(block) <= SECTION_BUDGETS.messages) return block;
    dropped += 1;
  }
}

function renderRecall(recall: readonly MemoryHit[]): string | null {
  if (recall.length === 0) return null;
  let kept = recall.length;
  for (;;) {
    if (kept === 0) return null;
    const omitted = recall.length - kept;
    const block = [
      SECTION_HEADERS.recall,
      ...recall.slice(0, kept).map((hit) => `- ${hit.text}`),
      ...(omitted > 0 ? [`[…${omitted} omitted: byte budget]`] : []),
    ].join('\n');
    if (bytesOf(block) <= SECTION_BUDGETS.recall) return block;
    kept -= 1;
  }
}

function assertWithin(section: 'identity' | 'roleFrame' | 'policies', rendered: string): string {
  const budget = SECTION_BUDGETS[section];
  if (bytesOf(rendered) > budget) {
    throw new ContextSectionOverflowError(section, bytesOf(rendered), budget);
  }
  return rendered;
}

/** Assemble one turn's input. Pure; throws typed on a mandatory-section overflow. */
export function assembleTurnInput(input: TurnInputFacts): string {
  const head = [
    `You are '${input.employee.id}' (${input.employee.title}), role '${input.employee.role}'.`,
    DATA_BOUNDARY_LINE,
  ].join('\n');
  const mandatory = [
    assertWithin('identity', renderIdentity(input)),
    assertWithin('roleFrame', renderRoleFrame(input)),
    assertWithin('policies', renderPolicies(input)),
    renderTask(input), // enforces its own budget; the goal is never trimmed
  ];
  const guidance = [ROLE_GUIDANCE[input.employee.role], TURN_ENDING_REMINDER].join('\n\n');

  const children =
    input.childResults !== null
      ? renderKeyedResults(input.childResults, SECTION_BUDGETS.children, [SECTION_HEADERS.children])
      : null;
  const messages = renderMessages(input.messages);
  const recall = renderRecall(input.recall);

  // Elastic sections drop HIGHEST-NUMBERED FIRST (7 → 6 → 5) until the whole input fits. The
  // module-load assert above guarantees this loop terminates with the mandatory sections intact.
  const elastic: (string | null)[] = [children, messages, recall];
  for (let dropIndex = elastic.length - 1; ; dropIndex -= 1) {
    const assembled = [
      head,
      ...mandatory,
      ...elastic.filter((s): s is string => s !== null),
      guidance,
    ].join('\n\n');
    if (bytesOf(assembled) <= TURN_INPUT_MAX_BYTES || dropIndex < 0) return assembled;
    elastic[dropIndex] = null;
  }
}
