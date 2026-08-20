/**
 * THE UN-STEERABILITY PROOF for the approval gate, driven against a SHIPPED EXAMPLE rather than a
 * fixture written to make the point.
 *
 * `examples/workforce-maintainers/rayspec.yaml` already declares the exact shape the gate had to be
 * built for: `mgr_docs` and `release_notes_writer` sit in `department: docs` AND hold
 * `labels: [public_statement]`, so BOTH the `docs_quality` review policy and the
 * `public_statement_signoff` approval policy cover them. And `docs_quality`'s trigger is
 * `confidenceBelow: 0.85` — a number the submitting turn writes about ITSELF.
 *
 * That combination is what makes a planner-only approval gate unsound rather than merely
 * incomplete. A worked task reaches `completed` at two sites: the planner's `case 'complete'`, and
 * a review verdict's `accept` (which never re-enters the planner). A matched review policy DIVERTS
 * a completion from the first to the second. So with a gate on only the first, this seat would
 * choose whether it is gated by choosing a confidence:
 *
 *     confidence 0.9  ->  no review rule fires  ->  chokepoint A  ->  gated
 *     confidence 0.5  ->  docs_quality fires    ->  chokepoint B  ->  UNGATED
 *
 * This suite pins the half of that which lives at the composition seam: the review match MOVES with
 * the self-reported number, and the approval match does NOT. The other half — that both chokepoints
 * actually reach the approval park — is `@rayspec/tasks`'s `approval-binding.db.test.ts`, which
 * drives both channel combinations against real Postgres. Neither suite is sufficient alone, and
 * this header says so rather than leaving a reader to assume otherwise.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveWorkforceConfig, parseSpec, type WorkforceEmployeeConfig } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { matchApprovalRule, matchReviewPolicy } from './review-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const MAINTAINERS = resolve(here, '../../../../examples/workforce-maintainers/rayspec.yaml');

function maintainersConfig() {
  const parsed = parseSpec(readFileSync(MAINTAINERS, 'utf8'), { experimentalWorkforce: true });
  if (!parsed.ok) throw new Error('the shipped maintainers example failed to parse');
  const workforce = parsed.value.workforce;
  if (!workforce) throw new Error('the maintainers example declares no workforce section');
  return deriveWorkforceConfig(workforce);
}

const result = (confidence: number) => ({
  status: 'completed' as const,
  summary: 'Drafted the release note.',
  findings: [],
  recommendations: [],
  artifacts: [],
  confidence,
  needsFollowUp: false,
});

describe('the shipped maintainers example puts BOTH policies on one seat', () => {
  const config = maintainersConfig();
  const seat = (id: string): WorkforceEmployeeConfig => {
    const employee = config.employees.get(id);
    if (!employee) throw new Error(`the example no longer declares '${id}'`);
    return employee;
  };

  // A GUARD, not decoration: if the example ever stops declaring this shape, every assertion below
  // would still pass while proving nothing about anything. The fixture must be the hazard.
  it('mgr_docs and release_notes_writer are covered by a review rule AND an approval rule', () => {
    for (const id of ['mgr_docs', 'release_notes_writer']) {
      expect(seat(id).department, id).toBe('docs');
      expect(seat(id).labels, id).toContain('public_statement');
      expect(matchApprovalRule(config, seat(id)), id).not.toBeNull();
    }
    const docsQuality = config.reviewPolicies.find((p) => p.id === 'docs_quality');
    expect(docsQuality?.appliesTo.department).toBe('docs');
    // The self-reported trigger — this number is what a planner-only gate would have let the seat
    // choose its own chokepoint with.
    expect(docsQuality?.requireWhen.confidenceBelow).toBe(0.85);
  });

  it('the REVIEW match moves with the self-reported confidence — that is the steerable half', async () => {
    const employee = seat('mgr_docs');
    const above = await matchReviewPolicy(config, {
      employee,
      taskId: 'task-1',
      result: result(0.9),
    });
    const below = await matchReviewPolicy(config, {
      employee,
      taskId: 'task-1',
      result: result(0.5),
    });
    expect(above).toBeNull();
    expect(below).not.toBeNull();
  });

  it('the APPROVAL match does NOT — the same rule at every confidence, for both seats', () => {
    // `matchApprovalRule`'s signature is the argument: it takes a config and an employee and NO
    // result, so there is no channel by which a turn could influence it. This asserts the
    // consequence at the seam a reader can check, over the confidences that fork the review path.
    for (const id of ['mgr_docs', 'release_notes_writer']) {
      const rule = matchApprovalRule(config, seat(id));
      expect(rule, id).toEqual({
        id: 'public_statement_signoff',
        approver: 'user',
        timeoutMs: 86_400_000,
        onTimeout: 'escalate',
      });
    }
  });

  it('an uncovered seat matches nothing — the gate is opt-in by declaration', async () => {
    // `market_watcher` holds no labels and sits outside `docs`, so neither policy covers it.
    expect(matchApprovalRule(config, seat('market_watcher'))).toBeNull();
    await expect(
      matchReviewPolicy(config, {
        employee: seat('market_watcher'),
        taskId: 'task-1',
        result: result(0.1),
      }),
    ).resolves.toBeNull();
  });

  it('the escalation target is the REPORTING EDGE, not a grammar field', () => {
    // `WorkforceApprovalPolicySpec` declares no `escalateTo`; the composition resolves it from
    // `reportsTo`, exactly as the `request_approval` tool door does. `mgr_docs` reports to `lead`,
    // so its escalating gate has a target; the orchestrator would not, and the planner degrades an
    // escalate fate to `fail` in that case rather than destroying a finished result.
    expect(matchApprovalRule(config, seat('mgr_docs'))?.onTimeout).toBe('escalate');
    expect(seat('mgr_docs').reportsTo).toBe('lead');
    expect(seat('lead').reportsTo).toBeNull();
  });
});
