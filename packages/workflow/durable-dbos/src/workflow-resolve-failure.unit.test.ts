/**
 * The ONE line the worker emits when a workflow job's resolver fails and the run is journalled as a
 * terminal failure. Pure + DB-free (no DBOS launch), exactly like cron-scheduler.unit.test.ts pins
 * `cronTenantAbsentLog` — the wording has a single source of truth and is directly assertable.
 */
import { describe, expect, it } from 'vitest';
import {
  workflowResolveFailureHeaderKeptLog,
  workflowResolveFailureLog,
} from './workflow-executor.js';

const JOB = {
  workflowRunId: 'wfr_9e1c',
  tenantId: '00000000-0000-0000-0000-0000000000ab',
  workflowId: 'code_invoice',
};

describe('workflowResolveFailureLog', () => {
  it('names the workflow, the tenant and the run id', () => {
    const line = workflowResolveFailureLog(JOB);
    expect(line).toContain("'code_invoice'");
    expect(line).toContain('00000000-0000-0000-0000-0000000000ab');
    expect(line).toContain('wfr_9e1c');
  });

  it('says the run was journalled as a terminal failure and where the reason is', () => {
    const line = workflowResolveFailureLog(JOB);
    expect(line).toContain('terminal_failure');
    expect(line).toContain('workflow_runs');
  });

  it('is a single line (it is a log line, not a report)', () => {
    expect(workflowResolveFailureLog(JOB)).not.toContain('\n');
  });
});

describe('workflowResolveFailureHeaderKeptLog', () => {
  it('names the run and the status of the header it refused to overwrite', () => {
    const line = workflowResolveFailureHeaderKeptLog(JOB, 'running');
    expect(line).toContain("'code_invoice'");
    expect(line).toContain('wfr_9e1c');
    expect(line).toContain("status 'running'");
    expect(line).toContain('LEFT UNCHANGED');
  });

  it('does NOT claim the run was journalled as a terminal failure (it was not)', () => {
    expect(workflowResolveFailureHeaderKeptLog(JOB, 'paused')).not.toContain('terminal_failure');
  });

  it('is a single line (it is a log line, not a report)', () => {
    expect(workflowResolveFailureHeaderKeptLog(JOB, 'quarantined')).not.toContain('\n');
  });
});
