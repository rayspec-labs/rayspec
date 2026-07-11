import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FAKE_STT_ADAPTER_ID, FakeSttAdapter } from '@rayspec/stt-port';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from './capability-registry.js';
import { InMemoryWorkflowRuntime } from './in-memory-executor.js';
import type { WorkflowInputEvent, WorkflowSpec } from './types.js';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const fixedNow = '2026-07-01T00:00:00.000Z';

function readFixture<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
}

function event(): WorkflowInputEvent {
  return {
    id: 'evt-finalized-session',
    type: 'audio_input.finalized_session',
    occurred_at: fixedNow,
    payload: {
      session_id: 'acme-dual',
      tracks: [
        { session_id: 'acme-dual', track: 'mic' },
        { session_id: 'acme-dual', track: 'system' },
      ],
    },
  };
}

function workflow(overrides: Partial<WorkflowSpec> = {}): WorkflowSpec {
  return {
    id: 'transcribe-session',
    tier: 'A',
    status: 'runtime_foundation',
    trigger: {
      event: 'audio_input.finalized_session',
    },
    idempotency_key: 'session:acme-dual:finalized',
    steps: [
      {
        id: 'transcribe',
        capability: 'stt',
        operation: 'transcribe_session',
        input_from_event: true,
        output_artifact_refs: ['stt.transcript'],
        retry_policy: {
          max_attempts: 2,
        },
        timeout_policy: {
          timeout_ms: 30_000,
        },
        acceptance_boundary: 'validation_node',
      },
    ],
    ...overrides,
  };
}

describe('InMemoryWorkflowRuntime', () => {
  it('runs stt.transcribe_session through an injected fake adapter', async () => {
    const short = readFixture('examples/acme-notes/fixtures/acme-notes-short-session.json');
    const dual = readFixture('examples/acme-notes/fixtures/acme-notes-dual-track-session.json');
    const stt = new FakeSttAdapter({ fixtures: [short, dual], now: fixedNow });
    const registry = new CapabilityRegistry();
    registry.register('stt.transcribe_session', async ({ input, step }) => {
      const results = await stt.transcribeSession({
        session_id: String(input.session_id),
        tracks: input.tracks as never,
        idempotency_key: step.idempotency_key,
      });
      return {
        status: 'completed',
        artifact_refs: results.map((result, index) => {
          if (result.status !== 'completed') throw new Error('expected completed transcript');
          return {
            id: result.transcript.transcript_id,
            kind: 'stt.transcript',
            source_node_id: step.id,
            value: {
              provider: FAKE_STT_ADAPTER_ID,
              track: result.transcript.track,
              span_id: result.transcript.spans[index === 0 ? 0 : 0]?.id,
            },
          };
        }),
      };
    });

    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });
    const journal = await runtime.execute(workflow(), event());

    expect(journal.status).toBe('completed');
    expect(journal.workflow_run_id).toBe(
      'workflow_run:transcribe-session:session:acme-dual:finalized',
    );
    expect(journal.node_states[0]?.status).toBe('completed');
    expect(journal.artifact_refs.map((artifact) => artifact.id)).toEqual([
      'stt.transcript.acme-dual.mic',
      'stt.transcript.acme-dual.system',
    ]);
    expect(JSON.stringify(journal).toLowerCase()).not.toContain('deepgram');
  });

  it('deduplicates duplicate events by workflow and idempotency key', async () => {
    const registry = new CapabilityRegistry();
    let invocations = 0;
    registry.register('test.complete', () => {
      invocations += 1;
      return { status: 'completed' };
    });
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });
    const spec = workflow({
      id: 'dedupe',
      steps: [{ id: 'complete', capability: 'test', operation: 'complete' }],
    });

    const first = await runtime.execute(spec, event());
    const second = await runtime.execute(spec, event());

    expect(first).toEqual(second);
    expect(invocations).toBe(1);
  });

  it('records retryable and terminal failures', async () => {
    const registry = new CapabilityRegistry();
    registry.register('test.flaky', () => ({
      status: 'retryable_failure',
      error: { code: 'temporary', message: 'try later', retryable: true },
    }));
    registry.register('test.terminal', () => ({
      status: 'terminal_failure',
      error: { code: 'bad_input', message: 'stop', retryable: false },
    }));
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });

    const retryable = await runtime.execute(
      workflow({
        id: 'retryable',
        idempotency_key: 'retryable-key',
        steps: [
          {
            id: 'flaky',
            capability: 'test',
            operation: 'flaky',
            retry_policy: { max_attempts: 2 },
          },
        ],
      }),
      event(),
    );
    const terminal = await runtime.execute(
      workflow({
        id: 'terminal',
        idempotency_key: 'terminal-key',
        steps: [{ id: 'terminal', capability: 'test', operation: 'terminal' }],
      }),
      event(),
    );

    expect(retryable.status).toBe('retryable_failure');
    expect(retryable.node_states[0]?.attempts).toHaveLength(2);
    expect(terminal.status).toBe('terminal_failure');
    expect(terminal.node_states[0]?.error?.code).toBe('bad_input');
  });

  it('marks unavailable capabilities and dependency-skipped nodes', async () => {
    const runtime = new InMemoryWorkflowRuntime({
      registry: new CapabilityRegistry(),
      clock: () => fixedNow,
    });
    const journal = await runtime.execute(
      workflow({
        id: 'unavailable',
        idempotency_key: 'unavailable-key',
        steps: [
          { id: 'missing', capability: 'missing', operation: 'operation' },
          {
            id: 'dependent',
            capability: 'test',
            operation: 'never',
            depends_on: ['missing'],
          },
        ],
      }),
      event(),
    );

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[0]?.status).toBe('capability_unavailable');
    expect(journal.node_states[1]?.status).toBe('skipped');
    expect(journal.node_states[1]?.skipped_reason).toBe('dependency_failure');
  });

  it('rejects a workflow whose step depends on an unknown step id (fail-closed)', async () => {
    const registry = new CapabilityRegistry();
    registry.register('test.complete', () => ({ status: 'completed' }));
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });

    await expect(
      runtime.execute(
        workflow({
          id: 'bad-dep',
          idempotency_key: 'bad-dep-key',
          steps: [{ id: 'a', capability: 'test', operation: 'complete', depends_on: ['typo'] }],
        }),
        event(),
      ),
    ).rejects.toThrow(/unknown step 'typo'/);
  });

  it('rejects a forward depends_on reference (declaration-order execution)', async () => {
    const registry = new CapabilityRegistry();
    registry.register('test.complete', () => ({ status: 'completed' }));
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });

    await expect(
      runtime.execute(
        workflow({
          id: 'forward-dep',
          idempotency_key: 'forward-dep-key',
          steps: [
            { id: 'first', capability: 'test', operation: 'complete', depends_on: ['second'] },
            { id: 'second', capability: 'test', operation: 'complete' },
          ],
        }),
        event(),
      ),
    ).rejects.toThrow(/forward reference/i);
  });

  it('journals a paused wait-state without fabricating an error', async () => {
    const registry = new CapabilityRegistry();
    registry.register('test.pause', () => ({ status: 'paused' }));
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });

    const journal = await runtime.execute(
      workflow({
        id: 'paused-clean',
        idempotency_key: 'paused-clean-key',
        steps: [{ id: 'pause', capability: 'test', operation: 'pause' }],
      }),
      event(),
    );

    // paused is a resumable wait-state, distinct from an error (failure-semantics.md).
    expect(journal.status).toBe('paused');
    expect(journal.node_states[0]?.status).toBe('paused');
    expect(journal.node_states[0]?.error).toBeUndefined();
    expect(journal.node_states[0]?.attempts[0]?.error).toBeUndefined();
    expect(journal.error).toBeUndefined();
  });

  it('can replay from an existing journal without invoking capabilities', async () => {
    const registry = new CapabilityRegistry();
    registry.register('test.pause', () => ({ status: 'paused' }));
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });
    const journal = await runtime.execute(
      workflow({
        id: 'paused',
        idempotency_key: 'paused-key',
        steps: [{ id: 'pause', capability: 'test', operation: 'pause' }],
      }),
      event(),
    );
    const replay = runtime.replay(journal);

    expect(journal.status).toBe('paused');
    expect(replay.replay_of).toBe(journal.workflow_run_id);
    expect(replay.node_states).toEqual(journal.node_states);
  });
});
