import { contentHash } from './hash.js';
import type {
  ArtifactContent,
  ArtifactHandle,
  ArtifactPersistInput,
  ArtifactStore,
  StoredArtifact,
} from './types.js';

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly handlesByIdempotency = new Map<string, ArtifactHandle>();

  persist<TContent extends ArtifactContent>(
    input: ArtifactPersistInput<TContent>,
  ): StoredArtifact<TContent> {
    const hash = contentHash(input.artifact.content);
    const idempotencyKey =
      input.idempotency_key ?? `${input.namespace}:${input.scope}:${input.artifact.kind}:${hash}`;
    const existingHandle = this.handlesByIdempotency.get(idempotencyKey);
    if (existingHandle) {
      const existing = this.artifacts.get(existingHandle.id);
      if (!existing) throw new Error(`Artifact handle '${existingHandle.id}' is missing.`);
      return cloneStoredArtifact(existing) as StoredArtifact<TContent>;
    }

    const handle: ArtifactHandle = {
      id: artifactId(input.namespace, input.scope, input.artifact.kind, hash),
      kind: input.artifact.kind,
      namespace: input.namespace,
      scope: input.scope,
      content_hash: hash,
      version: 1,
      metadata: { ...(input.artifact.metadata ?? {}) },
    };
    const stored: StoredArtifact<TContent> = {
      handle,
      content: input.artifact.content,
    };
    this.artifacts.set(handle.id, cloneStoredArtifact(stored));
    this.handlesByIdempotency.set(idempotencyKey, handle);
    return cloneStoredArtifact(stored);
  }

  read(handle: ArtifactHandle | string): StoredArtifact | undefined {
    const stored = this.artifacts.get(handleId(handle));
    return stored ? cloneStoredArtifact(stored) : undefined;
  }

  resolve(handle: ArtifactHandle | string): ArtifactHandle | undefined {
    return this.read(handle)?.handle;
  }
}

function artifactId(namespace: string, scope: string, kind: string, hash: string): string {
  const shortHash = hash.replace(/^sha256:/, '').slice(0, 24);
  return `artifact:${namespace}:${scope}:${kind}:${shortHash}`;
}

function handleId(handle: ArtifactHandle | string): string {
  return typeof handle === 'string' ? handle : handle.id;
}

function cloneStoredArtifact<TContent extends ArtifactContent>(
  artifact: StoredArtifact<TContent>,
): StoredArtifact<TContent> {
  return structuredClone(artifact);
}
