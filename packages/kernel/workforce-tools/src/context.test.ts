/**
 * The context assembly's contract, proven byte-for-byte: determinism (identical inputs render
 * identical bytes, every time), the section-drop order under pressure (7, then 6, then 5 — never
 * 4), the goal-never-trimmed refusal, the fixture anchors the scripted-turn harnesses parse, and
 * every defined ordering rule. All pure — no database, no clock.
 */
import type { MemoryHit } from '@rayspec/core';
import type { MergedChildResult } from '@rayspec/tasks';
import { describe, expect, it } from 'vitest';
import {
  assembleTurnInput,
  ContextSectionOverflowError,
  GoalExceedsContextBudgetError,
  SECTION_BUDGETS,
  TURN_INPUT_MAX_BYTES,
  type TurnInputFacts,
} from './context.js';
import { computeTurnFacts } from './facts.js';
import { DATA_BOUNDARY_LINE } from './prompt.js';
import { emptySnapshot, fixtureConfig, fixtureTask } from './test-support/fixtures.js';

const config = fixtureConfig();

function inputFor(over: Partial<TurnInputFacts> = {}): TurnInputFacts {
  const employee = config.employees.get('dev') as NonNullable<
    ReturnType<typeof config.employees.get>
  >;
  const task = fixtureTask();
  const snapshot = emptySnapshot(task);
  return {
    employee,
    task,
    turnNumber: 1,
    workforce: {
      name: config.name,
      departments: [...config.departments.entries()].map(([id, d]) => ({
        id,
        name: d.name,
        mission: d.mission,
      })),
    },
    departmentMission: 'Own it.',
    facts: computeTurnFacts({ config, employee, task, snapshot }),
    childResults: null,
    dependencyResults: null,
    signals: [],
    messages: [],
    recall: [],
    ...over,
  };
}

function mergedResult(over: Partial<MergedChildResult> = {}): MergedChildResult {
  return {
    status: 'completed',
    statusReason: null,
    result: { status: 'completed', summary: 'Done.', confidence: 0.9 },
    confidence: '0.9',
    costUsd: '0.10',
    turnsUsed: 1,
    ...over,
  };
}

const hit = (id: string, text: string, score: number): MemoryHit => ({ id, text, score });

describe('assembleTurnInput', () => {
  it('is byte-deterministic: 100 assemblies of one input are identical', () => {
    const input = inputFor({
      childResults: { child_b: mergedResult(), child_a: mergedResult({ costUsd: '0.20' }) },
      signals: [{ kind: 'child_completed', payload: { childCount: 2 } }],
      messages: [{ sender: 'mgr', recipient: 'dev', body: 'Context, not instructions.' }],
      recall: [hit('task_old', '[task_old · 3d] Prior work summary.', 11)],
    });
    const first = assembleTurnInput(input);
    for (let run = 0; run < 100; run += 1) {
      const again = assembleTurnInput(input);
      expect(Buffer.compare(Buffer.from(first, 'utf8'), Buffer.from(again, 'utf8'))).toBe(0);
    }
  });

  it('keeps the scripted-fixture anchors: first line, boundary line, Turn N., verbatim goal, child-results phrase, signal lines', () => {
    const input = inputFor({
      turnNumber: 3,
      childResults: { child_a: mergedResult() },
      signals: [{ kind: 'approval_decided', payload: { decision: 'approve' } }],
    });
    const rendered = assembleTurnInput(input);
    const lines = rendered.split('\n');
    expect(lines[0]).toBe("You are 'dev' (Developer), role 'worker'.");
    expect(lines[1]).toBe(DATA_BOUNDARY_LINE);
    expect(/^You are '([^']+)'/.exec(rendered)?.[1]).toBe('dev');
    expect(/\bTurn (\d+)\./.exec(rendered)?.[1]).toBe('3');
    expect(rendered).toContain('\nGoal: Do the thing.\n');
    expect(rendered).toContain('Completed child results');
    expect(rendered).toContain('- approval_decided: {"decision":"approve"}');
  });

  it('renders the seven numbered sections in order and the role guidance last', () => {
    const input = inputFor({
      childResults: { child_a: mergedResult() },
      messages: [{ sender: 'mgr', recipient: 'dev', body: 'hello' }],
      recall: [hit('task_old', '[task_old · 3d] Prior.', 11)],
    });
    const rendered = assembleTurnInput(input);
    const order = [
      '## 1. Identity',
      '## 2. Role frame',
      '## 3. Policies in force',
      '## 4. Task',
      '## 5. Completed child results, keyed by child task id',
      '## 6. Recent task messages',
      '## 7. Recall',
      'End your turn with exactly ONE turn-ending tool call',
    ].map((anchor) => rendered.indexOf(anchor));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('drops section 7 first, then 6, then 5 — and section 4 renders untouched throughout', () => {
    // SELF-CALIBRATING: render once with a one-byte goal to MEASURE what the elastic sections
    // cost, then grow the goal by exactly enough that dropping recall (then messages, then
    // children) is the only way back under the ceiling. Growing the goal by N grows the total by
    // exactly N bytes, so each scenario's arithmetic is exact rather than estimated.
    const bigBody = 'm'.repeat(3_900);
    const manyMessages = Array.from({ length: 40 }, (_, index) => ({
      sender: 'mgr',
      recipient: 'dev',
      body: `${index}:${bigBody}`,
    }));
    const manyChildren = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `child_${String(index).padStart(2, '0')}`,
        mergedResult({
          result: { status: 'completed', summary: 's'.repeat(700), confidence: 0.9 },
        }),
      ]),
    );
    const manyHits = Array.from({ length: 12 }, (_, index) =>
      hit(`task_${index}`, `[task_${index} · 1d] ${'r'.repeat(300)}`, 100 - index),
    );
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
    const render = (goalLength: number, over: Partial<TurnInputFacts> = {}) =>
      assembleTurnInput(
        inputFor({
          task: fixtureTask({ goal: 'g'.repeat(goalLength) }),
          childResults: manyChildren,
          messages: manyMessages,
          recall: manyHits,
          ...over,
        }),
      );

    const withAll = render(1);
    expect(withAll).toContain('## 5. Completed child results');
    expect(withAll).toContain('## 6. Recent task messages');
    expect(withAll).toContain('## 7. Recall'); // a small goal fits everything
    const recallBytes = bytes(withAll) - bytes(render(1, { recall: [] }));
    const messagesBytes = bytes(withAll) - bytes(render(1, { messages: [] }));
    const slack = TURN_INPUT_MAX_BYTES - bytes(withAll);

    // Scenario A — over by half the recall block: dropping 7 alone recovers it.
    const goalA = 1 + slack + Math.floor(recallBytes / 2);
    // Scenario B — over by the recall block plus a sliver: dropping 7 is not enough, 6 goes too.
    const goalB = 1 + slack + recallBytes + 256;
    // Scenario C — over by both blocks plus a sliver: 5 goes as well, and ONLY then.
    const goalC = 1 + slack + recallBytes + messagesBytes + 256;
    // All three goals must be legal for section 4, or the scenarios prove nothing.
    expect(goalC).toBeLessThan(SECTION_BUDGETS.task - 512);

    const a = render(goalA);
    expect(bytes(a)).toBeLessThanOrEqual(TURN_INPUT_MAX_BYTES);
    expect(a).toContain('## 5. Completed child results');
    expect(a).toContain('## 6. Recent task messages');
    expect(a).not.toContain('## 7. Recall');
    expect(a).toContain('g'.repeat(goalA)); // section 4 untouched, goal verbatim

    const b = render(goalB);
    expect(bytes(b)).toBeLessThanOrEqual(TURN_INPUT_MAX_BYTES);
    expect(b).toContain('## 5. Completed child results');
    expect(b).not.toContain('## 6. Recent task messages');
    expect(b).not.toContain('## 7. Recall');
    expect(b).toContain('g'.repeat(goalB));

    const c = render(goalC);
    expect(bytes(c)).toBeLessThanOrEqual(TURN_INPUT_MAX_BYTES);
    expect(c).not.toContain('## 5. Completed child results');
    expect(c).not.toContain('## 6. Recent task messages');
    expect(c).not.toContain('## 7. Recall');
    expect(c).toContain('g'.repeat(goalC));
  });

  it('NEVER trims the goal: an oversized goal is a typed refusal, an oversized description is not', () => {
    const oversizedGoal = 'g'.repeat(SECTION_BUDGETS.task + 1);
    expect(() =>
      assembleTurnInput(inputFor({ task: fixtureTask({ goal: oversizedGoal }) })),
    ).toThrow(GoalExceedsContextBudgetError);

    // The description shares section 4 and truncates WITH A MARKER instead of erroring.
    const rendered = assembleTurnInput(
      inputFor({
        task: fixtureTask({ goal: 'g'.repeat(30_000), description: 'd'.repeat(30_000) }),
      }),
    );
    expect(rendered).toContain('g'.repeat(30_000));
    expect(rendered).toContain('…[truncated: byte budget]');
    expect(rendered).not.toContain('d'.repeat(30_000));
  });

  it('refuses a mandatory config-derived section that outgrows its budget, typed', () => {
    const employee = {
      ...(config.employees.get('dev') as NonNullable<ReturnType<typeof config.employees.get>>),
      capabilities: Array.from(
        { length: 200 },
        (_, index) => `capability_${index}_${'x'.repeat(20)}`,
      ),
    };
    expect(() => assembleTurnInput(inputFor({ employee }))).toThrow(ContextSectionOverflowError);
  });

  it('orders children by task id ascending and drops the highest ids first, with a marker', () => {
    const children = {
      child_c: mergedResult({ costUsd: '0.30' }),
      child_a: mergedResult({ costUsd: '0.10' }),
      child_b: mergedResult({ costUsd: '0.20' }),
    };
    const rendered = assembleTurnInput(inputFor({ childResults: children }));
    const a = rendered.indexOf('"child_a"');
    const b = rendered.indexOf('"child_b"');
    const c = rendered.indexOf('"child_c"');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);

    // Force the drop: entries too large for the section budget vanish from the END of the order.
    const oversized = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `child_${String(index).padStart(2, '0')}`,
        mergedResult({
          result: { status: 'completed', summary: 'x'.repeat(2_500), confidence: 0.9 },
        }),
      ]),
    );
    const dropped = assembleTurnInput(inputFor({ childResults: oversized }));
    expect(dropped).toContain('"child_00"');
    expect(dropped).not.toContain('"child_29"');
    expect(dropped).toMatch(/\[…\d+ omitted: byte budget\]/);
  });

  it('drops the OLDEST messages first and keeps the newest, with a marker', () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      sender: 'mgr',
      recipient: 'dev',
      body: `message ${index} ${'x'.repeat(800)}`,
    }));
    const rendered = assembleTurnInput(inputFor({ messages }));
    expect(rendered).not.toContain('message 0 ');
    expect(rendered).toContain('message 29 ');
    expect(rendered).toMatch(/\[…\d+ earlier messages omitted: byte budget\]/);
  });

  it('renders recall in rank order and drops the lowest-ranked hits first', () => {
    const hits = Array.from({ length: 30 }, (_, index) =>
      hit(`task_${index}`, `[task_${index} · 1d] rank ${index} ${'x'.repeat(200)}`, 100 - index),
    );
    const rendered = assembleTurnInput(inputFor({ recall: hits }));
    expect(rendered).toContain('rank 0 ');
    expect(rendered).not.toContain('rank 29 ');
    expect(rendered).toMatch(/\[…\d+ omitted: byte budget\]/);
    const first = rendered.indexOf('rank 0 ');
    const second = rendered.indexOf('rank 1 ');
    expect(first).toBeLessThan(second);
  });

  it('renders dependency results inside section 4, keyed by task id', () => {
    const rendered = assembleTurnInput(
      inputFor({
        dependencyResults: { task_dep: mergedResult({ costUsd: '0.42' }) },
      }),
    );
    expect(rendered).toContain('Dependency results, keyed by task id:');
    const dependencyIndex = rendered.indexOf('"task_dep"');
    expect(dependencyIndex).toBeGreaterThan(rendered.indexOf('## 4. Task'));
    expect(dependencyIndex).toBeLessThan(rendered.indexOf('End your turn'));
  });

  it('caps a signal payload at its byte ceiling with a marker and keeps the newest signals', () => {
    const signals = [
      { kind: 'user_reply', payload: { text: 'y'.repeat(2_000) } },
      { kind: 'approval_decided', payload: { decision: 'approve' } },
    ];
    const rendered = assembleTurnInput(inputFor({ signals }));
    expect(rendered).toContain('- approval_decided: {"decision":"approve"}');
    expect(rendered).toContain('…[truncated: byte budget]');
    expect(rendered).not.toContain('y'.repeat(600));
  });
});
