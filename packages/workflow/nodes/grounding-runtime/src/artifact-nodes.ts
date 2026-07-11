import type { CapabilityInvocationResult, CapabilityNodeHandler } from '@rayspec/foundation';
import type {
  ArtifactPersistInput,
  ArtifactPersistNodeOptions,
  ArtifactReadInput,
  ArtifactReadNodeOptions,
} from './types.js';

export const ARTIFACT_PERSIST_OPERATION = 'artifact.persist';
export const ARTIFACT_READ_OPERATION = 'artifact.read';

export function createArtifactPersistHandler(
  options: ArtifactPersistNodeOptions,
): CapabilityNodeHandler {
  return async ({ input, step }): Promise<CapabilityInvocationResult> => {
    const stored = await options.store.persist(input as unknown as ArtifactPersistInput);
    return {
      status: 'completed',
      artifact_refs: [
        {
          id: stored.handle.id,
          kind: stored.handle.kind,
          source_node_id: step.id,
          value: stored.handle,
        },
      ],
      output: stored.handle,
    };
  };
}

export function createArtifactReadHandler(options: ArtifactReadNodeOptions): CapabilityNodeHandler {
  return async ({ input, step }): Promise<CapabilityInvocationResult> => {
    const stored = await options.store.read((input as unknown as ArtifactReadInput).handle);
    if (!stored) {
      return {
        status: 'terminal_failure',
        error: {
          code: 'artifact_not_found',
          message: `Artifact read node '${step.id}' could not resolve the requested handle.`,
          retryable: false,
        },
      };
    }

    return {
      status: 'completed',
      artifact_refs: [
        {
          id: stored.handle.id,
          kind: stored.handle.kind,
          source_node_id: step.id,
          value: stored.handle,
        },
      ],
      output: stored,
    };
  };
}
