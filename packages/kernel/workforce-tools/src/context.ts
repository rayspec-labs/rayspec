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
 * THE TRUST BOUNDARY IS ENFORCED IN CODE, not only asserted below the data-boundary line. Every
 * value a MODEL, a REQUESTER or a PRIOR TURN authored — task title/goal/description, message body,
 * recall hit text, signal payloads, child/dependency results — is UNTRUSTED and passes through
 * `sanitizeUntrusted` (raw strings) or `escapeRawSeparators` (JSON values) before it renders, so no
 * untrusted content can place a raw line break and forge a column-0 `## N.` section header or a
 * second data-boundary line. Config-derived text (identity, role frame, policies) is deployer-
 * authored — reviewed like code — and is trusted, so it renders as-is. See the helpers below.
 *
 * The scripted-turn fixtures parse this rendering. The stable anchors, kept byte-compatible with
 * the pre-sectioned composition: line 1 (`You are '<id>' (<title>), role '<role>'.`), line 2
 * (`DATA_BOUNDARY_LINE`), the `Turn <n>.` sentence, the goal rendered on its own line (verbatim but
 * for the line-boundary/control chars the trust boundary neutralizes — a single-line goal is
 * unchanged), section 5's header phrase `Completed child results`, and the `- <kind>: <payload>`
 * signal lines. Changing any of these is a fixture-lockstep change, not a wording tweak.
 */
import type { MemoryHit } from '@rayspec/core';
import type { WorkforceEmployeeConfig } from '@rayspec/spec';
import { MAX_TASK_TEXT_BYTES, type MergedChildResult, type TaskRecord } from '@rayspec/tasks';
import type { TurnFacts } from './facts.js';
import {
  DATA_BOUNDARY_LINE,
  ROLE_GUIDANCE,
  SECTION_HEADERS,
  TURN_ENDING_REMINDER,
} from './prompt.js';
import { TOOLSETS_BY_ROLE } from './roles.js';

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

// THE GOAL-CAP MARGIN. Every task-creation surface caps a goal/description at `MAX_TASK_TEXT_BYTES`
// (@rayspec/tasks), and the goal is NEVER trimmed — so that cap plus section 4's fixed lines (header,
// `Task <id>: <title>` with the title at its own char cap, the meta line, an optional deadline) must
// fit `SECTION_BUDGETS.task`, or a legally-created goal would brick every dispatch on
// `GoalExceedsContextBudgetError`. This is the assert the intake route's comment refers to: it is what
// makes "a goal accepted anywhere always renders untrimmed" a proven fact rather than a hope.
const TASK_SECTION_FIXED_OVERHEAD_BOUND = 2_048; // header + a max-length title + meta + deadline + joins
if (MAX_TASK_TEXT_BYTES + TASK_SECTION_FIXED_OVERHEAD_BOUND > SECTION_BUDGETS.task) {
  throw new Error(
    `the goal byte cap (MAX_TASK_TEXT_BYTES=${MAX_TASK_TEXT_BYTES}) plus section 4's fixed overhead ` +
      `does not fit SECTION_BUDGETS.task (${SECTION_BUDGETS.task}) — a legally-created goal could ` +
      'not render untrimmed. Fix the constants.',
  );
}

/** A mandatory, config-derived section outgrew its budget — a misconfigured workforce, refused. */
export class ContextSectionOverflowError extends Error {
  readonly section: string;
  constructor(section: string, rendered: number, budget: number) {
    super(
      `turn-input section '${section}' renders to ${rendered} bytes against a ${budget}-byte ` +
        'budget. This section is derived from the deployed document, so the fix is the document ' +
        '(shorter missions, fewer labels), never a silent trim. Fail-closed.',
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

/**
 * The assembled input exceeded the whole-input ceiling even after every elastic section was dropped
 * — unreachable while the module-load `MANDATORY_CEILING` assert holds (the mandatory sections plus
 * guidance fit with room). Reaching it means that invariant was broken in code, so the assembler
 * REFUSES typed rather than returning an over-ceiling string a caller believes is bounded: the one
 * place the drop loop could fail open, closed.
 */
export class ContextInputOverflowError extends Error {
  constructor(rendered: number, ceiling: number) {
    super(
      `the assembled turn input renders to ${rendered} bytes against the ${ceiling}-byte ceiling ` +
        'with every elastic section already dropped — the mandatory-section budgets no longer fit ' +
        'the ceiling. This is a broken module invariant, not a runtime input. Fail-closed.',
    );
    this.name = 'ContextInputOverflowError';
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
  // Never end on a split astral pair — a lone high surrogate is mangled text, not a shorter string
  // (memory.ts's clampText carries the same guard). Dropping it only shrinks the result, so it stays
  // inside the byte budget.
  if (/[\uD800-\uDBFF]$/.test(sliced)) sliced = sliced.slice(0, -1);
  return sliced;
}

const TRUNCATED_MARKER = '…[truncated: byte budget]';

/**
 * THE TRUST BOUNDARY, ENFORCED IN CODE (not only asserted in prose). Every string below the
 * data-boundary line that a MODEL, a REQUESTER or a PRIOR TURN authored — a task title/goal/
 * description, a message body, a recall hit — is UNTRUSTED and renders inside a newline-delimited,
 * `## N. <header>`-structured document. A raw line break in that content would let it start a new
 * line and place a column-0 `## N.` section header or a forged data-boundary line, byte-
 * indistinguishable from the platform's own. `sanitizeUntrusted` strips every line-boundary-class
 * and control char (C0, DEL, C1 incl. U+0085 NEL, plus U+2028 LS / U+2029 PS) so untrusted text can
 * never begin a line — the label before it (`Goal: `, `- from … : `, `- `) then keeps it off
 * column 0. Config-derived text (identity, role frame, policies) is deployer-authored — reviewed
 * like code — and is NOT untrusted, so it is rendered as-is.
 *
 * The three raw line-boundary chars `JSON.stringify` leaves UNescaped (U+0085/U+2028/U+2029 — the
 * `assemble.ts` gotcha) are the residual for the JSON-serialized untrusted values (signal payloads,
 * child/dependency results); `escapeRawSeparators` closes it on their stringify output, the same
 * shape `conversation-runtime/assemble.ts` uses.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing C0/DEL/C1/LS/PS in untrusted text is the point.
const UNTRUSTED_STRUCTURE_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
function sanitizeUntrusted(text: string): string {
  return text.replace(UNTRUSTED_STRUCTURE_CHARS, ' ');
}
const RAW_JSON_LINE_SEPARATORS = /[\u0085\u2028\u2029]/g;
/** Escape the three line-boundary chars `JSON.stringify` leaves raw \u2014 lossless (`\uXXXX`), so the
 * JSON stays valid and no untrusted string VALUE can smuggle a raw line break out of its quotes. */
function escapeRawSeparators(json: string): string {
  return json.replace(
    RAW_JSON_LINE_SEPARATORS,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
/** One untrusted value as a single jailed JSON line (signal payloads). */
function jsonData(value: unknown): string {
  return escapeRawSeparators(JSON.stringify(value) ?? 'null');
}

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
  const labels = employee.labels.length > 0 ? employee.labels.join(', ') : 'none declared';
  return [
    SECTION_HEADERS.identity,
    `Employee: ${employee.id} — ${employee.title}. Role: ${employee.role}.`,
    `Labels: ${labels}.`,
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

  const holdsDelegation = TOOLSETS_BY_ROLE[input.employee.role].includes('delegate_task');
  if (facts.legalTargets.length > 0) {
    const depthLabel =
      facts.delegationDepthRemaining !== null
        ? `depth remaining ${facts.delegationDepthRemaining}`
        : 'no depth ceiling';
    const fanOutLabel =
      facts.delegationsPerTaskRemaining !== null
        ? `up to ${facts.delegationsPerTaskRemaining} more ${
            facts.delegationsPerTaskRemaining === 1 ? 'child' : 'children'
          } from this task`
        : 'no per-task fan-out ceiling';
    lines.push(`Delegation: ${depthLabel}, ${fanOutLabel}.`);
    lines.push(`Legal delegation targets: ${facts.legalTargets.join(', ')}.`);
  } else if (holdsDelegation) {
    lines.push(
      facts.delegationDepthRemaining === 0
        ? 'Delegation: the depth ceiling is spent on this task — no hand-off is legal from here.'
        : 'Delegation: no target is legal from this task (every declared target already owns ' +
            'work above it in the chain).',
    );
  } else {
    lines.push('Delegation: your toolset carries no delegation tool on this task.');
  }

  if (facts.reviewRules.length === 0) {
    lines.push('Review rules covering you: none declared.');
  } else {
    lines.push('Review rules covering you (first match applies):');
    for (const rule of facts.reviewRules) {
      const triggers: string[] = [];
      if (rule.firesOnLabels.length > 0) {
        triggers.push(`fires on every completion (you hold: ${rule.firesOnLabels.join(', ')})`);
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

  // The approval line renders ONLY for seats whose toolset carries request_approval: for a
  // worker, "none declared" would be a false statement about the document (a rule may well cover
  // its labels — the seat just cannot act on it), and naming the rule would advertise a tool the
  // runtime refuses. A fact a seat cannot act on is not a fact for its turn.
  if (TOOLSETS_BY_ROLE[input.employee.role].includes('request_approval')) {
    if (facts.approvalRule !== null) {
      lines.push(
        `Approval rule covering you: ${facts.approvalRule.id} — request_approval runs on its ` +
          `declared window (${windowLabel(facts.approvalRule.timeoutMs)}, then ` +
          `${facts.approvalRule.onTimeout}).`,
      );
    } else {
      lines.push('Approval rule covering you: none declared for your labels.');
    }
  }
  return lines.join('\n');
}

/** One child/dependency entry, rendered whole when it fits and compacted (never invalid JSON)
 * when it does not — the compact form keeps the typed fields and slices only the summary. */
function renderMergedResult(entry: MergedChildResult): string {
  // The result is a child's model-authored output — untrusted. JSON.stringify escapes ASCII control
  // chars (incl. `\n`); `escapeRawSeparators` closes the U+0085/U+2028/U+2029 residual so no string
  // VALUE inside can smuggle a raw line break that forges structure.
  const whole = escapeRawSeparators(JSON.stringify(entry, null, 1));
  if (bytesOf(whole) <= CHILD_RESULT_MAX_BYTES) return whole;
  const summary =
    typeof entry.result === 'object' && entry.result !== null && 'summary' in entry.result
      ? String((entry.result as { summary: unknown }).summary)
      : null;
  return escapeRawSeparators(
    JSON.stringify(
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
    ),
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
  // Title/goal/description are model- or requester-authored (untrusted) — sanitize before rendering
  // AND before measuring, so the bytes we budget against are the bytes we emit (see the trust
  // boundary note above). `taskId`/`requestedBy`/`priority` are server-derived, never model prose.
  const title = sanitizeUntrusted(task.title);
  const goal = sanitizeUntrusted(task.goal);
  const fixedTop = [SECTION_HEADERS.task, `Task ${task.taskId}: ${title}`];
  const goalLine = `Goal: ${goal}`;
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
    const overhead = fixedBytes - bytesOf(goal);
    throw new GoalExceedsContextBudgetError(
      task.taskId,
      bytesOf(goal),
      Math.max(SECTION_BUDGETS.task - overhead, 0),
    );
  }
  let remaining = SECTION_BUDGETS.task - fixedBytes;

  const lines = [...fixedTop, goalLine];
  if (task.description !== null) {
    const label = 'Description: ';
    const sanitized = sanitizeUntrusted(task.description);
    const room = remaining - bytesOf(`\n${label}${TRUNCATED_MARKER}`);
    const description =
      bytesOf(sanitized) + bytesOf(`\n${label}`) <= remaining
        ? sanitized
        : room > 0
          ? truncateToBytes(sanitized, room) + TRUNCATED_MARKER
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
    // Signals render oldest-first. THE NEWEST SIGNAL IS THE WAKE — the user_reply / approval_decided
    // that re-queued this turn — and it is NEVER dropped: it is reserved and always rendered, even
    // when the goal has left section 4 almost no room (its payload is byte-capped, so the overflow it
    // may add is bounded — the whole-input ceiling has the slack). Older signals fill what remains,
    // dropping OLDEST-first, and ANY drop is announced with a marker: silent unmarked loss is how a
    // turn quietly runs on different facts than the operator thinks. Payloads are JSON via `jsonData`
    // (escaped line-boundary chars — a signal payload can carry untrusted user-reply text).
    const rendered = input.signals.map((signal) => {
      const payload = jsonData(signal.payload);
      const capped =
        bytesOf(payload) <= SIGNAL_PAYLOAD_MAX_BYTES
          ? payload
          : truncateToBytes(payload, SIGNAL_PAYLOAD_MAX_BYTES) + TRUNCATED_MARKER;
      return `- ${signal.kind}: ${capped}`;
    });
    const newest = rendered[rendered.length - 1] as string;
    const older = rendered.slice(0, -1);
    let dropped = 0;
    for (;;) {
      const keptOlder = older.slice(dropped);
      const block = [
        'Signal history (oldest first):',
        ...(dropped > 0 ? [`[…${dropped} earlier signals omitted: byte budget]`] : []),
        ...keptOlder,
        newest,
      ].join('\n');
      // Fits, or nothing older is left to drop — either way render it: the newest always survives.
      if (bytesOf(`\n\n${block}`) <= remaining || keptOlder.length === 0) {
        lines.push('', block);
        remaining -= bytesOf(`\n\n${block}`);
        break;
      }
      dropped += 1;
    }
  }
  return lines.join('\n');
}

function renderMessages(messages: readonly TurnMessageFact[]): string | null {
  if (messages.length === 0) return null;
  // `sender`/`recipient` are validated ids; `body` is model-authored (untrusted) — sanitize it so a
  // raw line break in a `send_message` body cannot forge a section header on its own line.
  const rendered = messages.map(
    (m) => `- from ${m.sender} to ${m.recipient}: ${sanitizeUntrusted(m.body)}`,
  );
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
      // Hit text is a prior turn's model-authored result/decision — untrusted; sanitize so it cannot
      // forge a boundary/section line from inside the recall list.
      ...recall.slice(0, kept).map((hit) => `- ${sanitizeUntrusted(hit.text)}`),
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
    if (bytesOf(assembled) <= TURN_INPUT_MAX_BYTES) return assembled;
    // Every elastic section is gone and it still does not fit — refuse typed, never return an
    // over-ceiling string (the module-load assert makes this unreachable; this closes the fail-open).
    if (dropIndex < 0)
      throw new ContextInputOverflowError(bytesOf(assembled), TURN_INPUT_MAX_BYTES);
    elastic[dropIndex] = null;
  }
}
