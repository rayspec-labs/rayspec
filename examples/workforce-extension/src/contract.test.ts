/**
 * THE NO-FORK PROOF, run rather than asserted.
 *
 * Three things have to be true for "premium intelligence can be implemented out of tree with no
 * fork" to mean anything, and each gets its own arm here:
 *
 *   1. The implementations live OUTSIDE the workspace packages and reach into none of them. Checked
 *      structurally, by reading this package's own sources: every workspace import is the bare
 *      package specifier, no relative path leaves this directory, and nothing names `/src/`.
 *   2. They compile and run against the PUBLISHED package entry, not the source tree. Checked by
 *      resolving the specifier and confirming it lands in the package's built output.
 *   3. They satisfy the same contract the shipped defaults do. Checked by running the shipped
 *      contract kit — the identical `runSeamContracts` that `@rayspec/core`'s own suite runs.
 *
 * Plus the arm that keeps arm 3 from being a formality: the confinements are driven with these
 * implementations to show a conforming extension passes through them untouched.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type CostPolicy,
  confineApprovalProvider,
  confineCostPolicy,
  confineMemoryProvider,
  confineWorkerSelector,
  contractFailures,
  runSeamContracts,
  SEAM_MAX_PLAN_STEPS,
  type WorkerCandidate,
} from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { DepartmentCeilingCostPolicy } from './department-cost-policy.js';
import { KeywordMemoryProvider } from './keyword-memory.js';
import { LeastLoadedSelector } from './least-loaded-selector.js';
import { QueuedApprovalProvider } from './queued-approvals.js';
import { SeparatorPlanStrategy } from './separator-strategy.js';

const here = dirname(fileURLToPath(import.meta.url));

function sources(): { name: string; text: string }[] {
  return readdirSync(here)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(here, name), 'utf8') }));
}

describe('the sample lives out of tree', () => {
  it('reads its own sources — an empty scan fails CLOSED', () => {
    const names = sources().map((s) => s.name);
    expect(names).toContain('separator-strategy.ts');
    expect(names.length).toBeGreaterThanOrEqual(6);
  });

  it('no source reaches out of this directory or into a package source tree', () => {
    for (const { name, text } of sources()) {
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
      for (const specifier of specifiers) {
        // A relative import may only stay inside this directory; `..` would be a tunnel out.
        expect(specifier.startsWith('../'), `${name} imports ${specifier}`).toBe(false);
        // And no workspace import may name a package's internals rather than its entry.
        expect(specifier.includes('/src/'), `${name} imports ${specifier}`).toBe(false);
        expect(specifier.includes('/dist/'), `${name} imports ${specifier}`).toBe(false);
      }
      expect(specifiers.filter((s) => s.startsWith('@rayspec/'))).toEqual(
        specifiers.filter((s) => s === '@rayspec/core'),
      );
    }
  });

  it('resolves @rayspec/core to its BUILT entry, the way a consumer outside this repo would', () => {
    const resolved = createRequire(import.meta.url).resolve('@rayspec/core');
    expect(resolved.endsWith('/dist/index.js')).toBe(true);
    expect(resolved).not.toContain('/src/');
  });
});

describe('the out-of-tree implementations satisfy the shipped seam contracts', () => {
  const subjects = {
    orchestrationStrategy: new SeparatorPlanStrategy(),
    workerSelector: new LeastLoadedSelector(),
    memoryProvider: new KeywordMemoryProvider([
      'a prior decision about contract probes',
      'an older note nobody needs',
    ]),
    approvalProvider: new QueuedApprovalProvider(() => new Date(0)),
    costPolicy: new DepartmentCeilingCostPolicy({ 'probe-dept': 5 }),
  };

  it('every seam passes, and every seam was actually run', async () => {
    const results = await runSeamContracts(subjects);
    expect(contractFailures(results).map((r) => `${r.seam}/${r.name}: ${r.detail}`)).toEqual([]);
    expect([...new Set(results.map((r) => r.seam))].sort()).toEqual([
      'ApprovalProvider',
      'CostPolicy',
      'OrchestrationStrategy',
      'WorkerSelector',
      'WorkforceMemoryProvider',
    ]);
  });
});

describe('the out-of-tree implementations pass through the confinements untouched', () => {
  const CANDIDATES: readonly WorkerCandidate[] = [
    { employeeId: 'alpha', role: 'worker', department: 'probe-dept', capabilities: ['write'] },
    { employeeId: 'beta', role: 'worker', department: null, capabilities: ['write'] },
  ];

  it('the selector balances load and every pick survives confinement', async () => {
    const confined = confineWorkerSelector(new LeastLoadedSelector());
    const task = { taskId: 't', requiredCapabilities: ['write'], department: null };
    const picks = [
      (await confined.select(task, CANDIDATES)).employeeId,
      (await confined.select(task, CANDIDATES)).employeeId,
      (await confined.select(task, CANDIDATES)).employeeId,
    ];
    expect(picks).toEqual(['alpha', 'beta', 'alpha']);
  });

  it('the memory provider stays inside the recall ceiling under confinement', async () => {
    const memory = confineMemoryProvider(
      new KeywordMemoryProvider(Array.from({ length: 500 }, () => 'a prior decision about probes')),
    );
    await expect(memory.search({ text: 'prior decision', limit: 3 })).resolves.toHaveLength(3);
  });

  it('the approval provider issues a pending ticket that confinement accepts', async () => {
    const approvals = confineApprovalProvider(new QueuedApprovalProvider(() => new Date(0)));
    const ticket = await approvals.request({
      taskId: 't',
      requestedBy: 'alpha',
      approver: 'user',
      reason: 'publish the result',
      timeoutMs: null,
      onTimeout: 'escalate',
    });
    expect(ticket.status).toBe('pending');
  });

  it('the cost policy can DENY through the confinement but never widen what the baseline allowed', async () => {
    const proposed = {
      taskId: 't',
      rootTaskId: 'r',
      workforceId: 'wf',
      department: 'probe-dept',
      estimateUsd: 50,
    };
    const allowingBaseline: CostPolicy = {
      id: 'allowing-baseline',
      authorize: () => Promise.resolve({ allowed: true }),
      settle: () => Promise.resolve(),
    };
    const denyingBaseline: CostPolicy = {
      id: 'denying-baseline',
      authorize: () =>
        Promise.resolve({
          allowed: false,
          denial: {
            scopeKind: 'workforce',
            scopeId: 'wf',
            ceiling: { kind: 'usd', limit: 1 },
            consumed: 1,
          },
        }),
      settle: () => Promise.resolve(),
    };
    const extension = new DepartmentCeilingCostPolicy({ 'probe-dept': 5 });

    // The extension's own ceiling is 5, so it denies a 50 USD turn the baseline would have allowed.
    const denied = await confineCostPolicy(allowingBaseline, extension).authorize(proposed);
    expect(denied.allowed).toBe(false);
    expect(denied.allowed === false && denied.denial.scopeId).toBe('probe-dept');

    // And a generous extension cannot rescue a turn the baseline denied — the baseline's own
    // denial, with the baseline's own ceiling, is what comes back.
    const generous = new DepartmentCeilingCostPolicy({ 'probe-dept': 1_000_000 });
    const stillDenied = await confineCostPolicy(denyingBaseline, generous).authorize(proposed);
    expect(stillDenied.allowed === false && stillDenied.denial.ceiling).toEqual({
      kind: 'usd',
      limit: 1,
    });
  });
});

describe('the strategy decomposes without exceeding what the intake will accept', () => {
  it('splits on its separator and chains the pieces strictly backwards', async () => {
    const plan = await new SeparatorPlanStrategy().plan({
      workforceId: 'wf',
      goal: 'Draft the note THEN circulate it THEN archive it',
      requestedBy: 'user',
      defaultOwner: 'lead',
    });
    expect(plan.steps.map((s) => s.goal)).toEqual(['Draft the note', 'circulate it', 'archive it']);
    expect(plan.steps.map((s) => s.dependsOn)).toEqual([[], [0], [1]]);
    expect(plan.steps.every((s) => s.owner === 'lead')).toBe(true);
  });

  it('a separator-free goal becomes exactly one step, never zero', async () => {
    const plan = await new SeparatorPlanStrategy().plan({
      workforceId: 'wf',
      goal: 'Just do the thing',
      requestedBy: 'user',
      defaultOwner: 'lead',
    });
    expect(plan.steps).toHaveLength(1);
  });

  it('a goal with more pieces than the plan bound is truncated, not refused at the intake', async () => {
    const goal = Array.from({ length: SEAM_MAX_PLAN_STEPS + 40 }, (_v, i) => `piece ${i}`).join(
      ' THEN ',
    );
    const plan = await new SeparatorPlanStrategy().plan({
      workforceId: 'wf',
      goal,
      requestedBy: 'user',
      defaultOwner: 'lead',
    });
    expect(plan.steps).toHaveLength(SEAM_MAX_PLAN_STEPS);
  });
});
