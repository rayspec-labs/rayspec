/**
 * The closed intent → classification mapping, per role. The journal-side proof (the field on
 * `turn_ended`, through the real composition and engine) lives in the server package's turn
 * suites; this pins the pure mapping including every null arm.
 */
import { turnIntentSchema } from '@rayspec/tasks';
import { describe, expect, it } from 'vitest';
import { classifyTurnIntent } from './classify.js';

const intent = (raw: unknown) => turnIntentSchema.parse(raw);
const RESULT = { status: 'completed', summary: 'Done.', confidence: 0.9 };

describe('classifyTurnIntent', () => {
  it('classifies the decision seats over the closed set', () => {
    expect(classifyTurnIntent(intent({ kind: 'complete', result: RESULT }), 'orchestrator')).toBe(
      'direct',
    );
    expect(
      classifyTurnIntent(
        intent({
          kind: 'fan_out',
          children: [
            { title: 'A', goal: 'a', owner: 'mgr', delegatedTo: 'department:eng' },
            { title: 'B', goal: 'b', owner: 'copy', delegatedTo: 'employee:copy' },
          ],
        }),
        'orchestrator',
      ),
    ).toBe('delegate');
    expect(
      classifyTurnIntent(
        intent({
          kind: 'fan_out',
          children: [{ title: 'A', goal: 'a', owner: 'mgr', delegatedTo: 'team:fix_team' }],
        }),
        'orchestrator',
      ),
    ).toBe('team');
    expect(classifyTurnIntent(intent({ kind: 'request_review', reviewer: 'qa' }), 'manager')).toBe(
      'review',
    );
    expect(
      classifyTurnIntent(
        intent({
          kind: 'request_approval',
          question: 'Ship it?',
          timeoutMs: 3_600_000,
        }),
        'orchestrator',
      ),
    ).toBe('escalate');
    expect(
      classifyTurnIntent(
        intent({
          kind: 'escalate',
          reason: 'out_of_scope',
          detail: 'Not mine.',
          escalateTo: 'lead',
        }),
        'manager',
      ),
    ).toBe('escalate');
  });

  it('classifies nothing for non-decision seats and non-decision endings', () => {
    expect(classifyTurnIntent(intent({ kind: 'complete', result: RESULT }), 'worker')).toBeNull();
    expect(classifyTurnIntent(intent({ kind: 'complete', result: RESULT }), 'reviewer')).toBeNull();
    expect(classifyTurnIntent(intent({ kind: 'yield' }), 'orchestrator')).toBeNull();
    expect(
      classifyTurnIntent(
        intent({ kind: 'submit_review', reviewId: 'r1', verdict: 'accept' }),
        'manager',
      ),
    ).toBeNull();
    expect(
      classifyTurnIntent(intent({ kind: 'fail', message: 'broken' }), 'orchestrator'),
    ).toBeNull();
  });
});
