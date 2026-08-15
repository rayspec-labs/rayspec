/**
 * Test fixtures for the toolset suites: one declared-shaped workforce configuration (four roles,
 * one department, one team) plus builders for task records and empty snapshots. Test-only —
 * excluded from the build.
 */
import type { WorkforceConfig, WorkforceEmployeeConfig } from '@rayspec/spec';
import { type TaskRecord, workforceBudgetsSchema } from '@rayspec/tasks';
import type { WorkforceReadSnapshot } from '../snapshot.js';

/** No declared ceilings — the parsed empty budgets object every snapshot carries by default. */
const NO_BUDGETS = workforceBudgetsSchema.parse({});

export function fixtureConfig(): WorkforceConfig {
  const employees: WorkforceEmployeeConfig[] = [
    {
      id: 'lead',
      agent: 'lead_agent',
      title: 'Lead',
      role: 'orchestrator',
      department: null,
      reportsTo: null,
      capabilities: [],
    },
    {
      id: 'mgr',
      agent: 'mgr_agent',
      title: 'Manager',
      role: 'manager',
      department: 'eng',
      reportsTo: 'lead',
      capabilities: [],
    },
    {
      id: 'dev',
      agent: 'dev_agent',
      title: 'Developer',
      role: 'worker',
      department: 'eng',
      reportsTo: 'mgr',
      capabilities: ['production_change'],
    },
    {
      id: 'qa',
      agent: 'qa_agent',
      title: 'Reviewer',
      role: 'reviewer',
      department: null,
      reportsTo: 'lead',
      capabilities: [],
    },
    {
      id: 'copy',
      agent: 'copy_agent',
      title: 'Copywriter',
      role: 'worker',
      department: 'growth',
      reportsTo: 'cmo',
      capabilities: ['public_statement'],
    },
    {
      id: 'cmo',
      agent: 'cmo_agent',
      title: 'CMO',
      role: 'manager',
      department: 'growth',
      reportsTo: 'lead',
      capabilities: ['public_statement'],
    },
  ];
  return {
    id: 'helpdesk',
    name: 'Helpdesk',
    orchestrator: 'lead',
    employees: new Map(employees.map((e) => [e.id, e])),
    departments: new Map([
      ['eng', { name: 'Engineering', manager: 'mgr', mission: 'Own it.', members: ['dev'] }],
      ['growth', { name: 'Growth', manager: 'cmo', mission: 'Tell it.', members: ['copy'] }],
    ]),
    teams: new Map([['fix_team', { lead: 'mgr', members: ['dev', 'qa'], maxSize: 3 }]]),
    reviewPolicies: [
      {
        id: 'eng_default',
        appliesTo: { department: 'eng' },
        reviewer: 'qa',
        requireWhen: { confidenceBelow: 0.75, capabilities: ['production_change'] },
        onReject: 'rework',
        maxRounds: 2,
      },
    ],
    approvals: [
      {
        id: 'public_statement',
        capabilities: ['public_statement'],
        approver: 'user',
        timeoutMs: 72 * 3_600_000,
        onTimeout: 'escalate',
      },
    ],
  };
}

export function fixtureTask(over: Partial<Record<string, unknown>> = {}): TaskRecord {
  return {
    taskId: 'task_a',
    tenantId: '00000000-0000-4000-8000-000000000001',
    workforceId: 'helpdesk',
    parentTaskId: null,
    rootTaskId: 'task_a',
    ancestryPath: [],
    title: 'A task',
    goal: 'Do the thing.',
    description: null,
    owner: 'dev',
    requestedBy: 'user',
    department: 'eng',
    status: 'working',
    statusReason: null,
    priority: 'normal',
    dependencies: [],
    joinPolicy: null,
    artifacts: [],
    result: null,
    confidence: null,
    costUsd: '0',
    tokenUsage: {},
    turnsUsed: 0,
    lastEventSeq: 0,
    deadlineAt: null,
    createdAt: new Date('2020-01-01T00:00:00Z'),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    version: 1,
    ...over,
  } as TaskRecord;
}

export function emptySnapshot(
  task: TaskRecord,
  over: Partial<WorkforceReadSnapshot> = {},
): WorkforceReadSnapshot {
  return {
    task,
    parentTask: null,
    subtreeTasks: [],
    departmentTasks: [],
    workforceState: null,
    pendingReview: null,
    activeTeamIds: [],
    ancestorOwners: [],
    budgets: NO_BUDGETS,
    dependencyResults: null,
    ...over,
  };
}
