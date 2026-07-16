import type { WorkflowInputEvent, WorkflowSpec } from '@rayspec/foundation';
import { CapabilityRegistry, InMemoryWorkflowRuntime } from '@rayspec/foundation';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_PERSIST_OPERATION,
  ARTIFACT_READ_OPERATION,
  createArtifactPersistHandler,
  createArtifactReadHandler,
} from './artifact-nodes.js';
import { createGroundingCheckHandler, GROUNDING_CHECK_OPERATION } from './grounding.js';
import { contentHash } from './hash.js';
import { InMemoryArtifactStore } from './in-memory-artifact-store.js';
import { createValidationCheckHandler, VALIDATION_CHECK_OPERATION } from './validation.js';

const fixedNow = '2026-07-01T00:00:00.000Z';

function event(payload: Record<string, unknown>): WorkflowInputEvent {
  return {
    id: 'evt-candidate-ready',
    type: 'artifact.candidate_ready',
    occurred_at: fixedNow,
    payload,
  };
}

function workflow(input: Record<string, unknown>, operation: string): WorkflowSpec {
  const [capability, op] = operation.split('.');
  if (!capability || !op) throw new Error(`Invalid operation '${operation}'.`);
  return {
    id: `wf-${capability}-${op}`,
    tier: 'A',
    status: 'foundation_only',
    trigger: { event: 'artifact.candidate_ready' },
    idempotency_key: `wf:${capability}:${op}`,
    steps: [
      {
        id: 'node',
        capability,
        operation: op,
        input,
        acceptance_boundary: operation === VALIDATION_CHECK_OPERATION ? 'validation_node' : 'none',
      },
    ],
  };
}

describe('@rayspec/grounding-runtime', () => {
  it('returns a grounded verdict for closed-set references', async () => {
    const registry = new CapabilityRegistry();
    registry.register(GROUNDING_CHECK_OPERATION, createGroundingCheckHandler());
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });

    const journal = await runtime.execute(
      workflow(
        {
          source_artifact: { kind: 'source.spans', content: { ids: ['s1', 's2'] } },
          candidate_artifact: { kind: 'candidate.answer', content: { text: 'Supported' } },
          references: [{ id: 's1' }, { id: 's2' }],
          closed_reference_ids: ['s1', 's2'],
        },
        GROUNDING_CHECK_OPERATION,
      ),
      event({}),
    );

    expect(journal.status).toBe('completed');
    expect(journal.artifact_refs[0]?.kind).toBe('grounding.result');
    expect(journal.artifact_refs[0]?.value).toMatchObject({ verdict: 'grounded', findings: [] });
  });

  it('returns ungrounded findings and dropped references without provider data', async () => {
    const registry = new CapabilityRegistry();
    registry.register(GROUNDING_CHECK_OPERATION, createGroundingCheckHandler());
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });

    const journal = await runtime.execute(
      workflow(
        {
          source_artifact: { kind: 'source.spans', content: { ids: ['s1'] } },
          candidate_artifact: { kind: 'candidate.answer', content: { text: 'Unsupported' } },
          references: [{ id: 's404' }],
          closed_reference_ids: ['s1'],
        },
        GROUNDING_CHECK_OPERATION,
      ),
      event({}),
    );

    expect(journal.status).toBe('completed');
    expect(journal.artifact_refs[0]?.value).toMatchObject({
      verdict: 'ungrounded',
      findings: [{ code: 'unknown_reference', reference_id: 's404' }],
      dropped_references: [{ id: 's404' }],
    });
    expect(JSON.stringify(journal).toLowerCase()).not.toMatch(/deepgram|openai|anthropic/);
  });

  it('turns validation failures into terminal workflow failures', async () => {
    const registry = new CapabilityRegistry();
    registry.register(VALIDATION_CHECK_OPERATION, createValidationCheckHandler());
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });

    const journal = await runtime.execute(
      workflow(
        {
          artifact: { kind: 'candidate.answer', content: { text: 'Missing language' } },
          required_paths: ['text', 'language'],
        },
        VALIDATION_CHECK_OPERATION,
      ),
      event({}),
    );

    expect(journal.status).toBe('terminal_failure');
    expect(journal.node_states[0]?.error?.code).toBe('validation_failed');
    expect(journal.node_states[0]?.artifact_refs[0]?.value).toMatchObject({
      verdict: 'invalid',
      findings: [{ code: 'missing_required_path', path: 'language' }],
    });
  });

  it('persists and reads artifacts with deterministic content hashes', async () => {
    const store = new InMemoryArtifactStore();
    const registry = new CapabilityRegistry();
    registry.register(ARTIFACT_PERSIST_OPERATION, createArtifactPersistHandler({ store }));
    registry.register(ARTIFACT_READ_OPERATION, createArtifactReadHandler({ store }));
    const runtime = new InMemoryWorkflowRuntime({ registry, clock: () => fixedNow });
    const content = { b: 2, a: 1 };

    const persist = await runtime.execute(
      workflow(
        {
          artifact: { kind: 'candidate.answer', content, metadata: { note: 'ignored' } },
          namespace: 'tenant-local',
          scope: 'session-1',
        },
        ARTIFACT_PERSIST_OPERATION,
      ),
      event({}),
    );
    const handle = persist.artifact_refs[0]?.value;
    const persistedAgain = store.persist({
      artifact: { kind: 'candidate.answer', content: { a: 1, b: 2 } },
      namespace: 'tenant-local',
      scope: 'session-1',
    });
    const read = await runtime.execute(workflow({ handle }, ARTIFACT_READ_OPERATION), event({}));

    expect(persist.status).toBe('completed');
    expect(handle).toMatchObject({
      id: expect.stringContaining('artifact:tenant-local:session-1:candidate.answer:'),
      kind: 'candidate.answer',
      content_hash: contentHash({ a: 1, b: 2 }),
    });
    expect(persistedAgain.handle).toEqual(handle);
    expect(read.status).toBe('completed');
    expect(read.artifact_refs[0]?.value).toEqual(handle);
  });
});
