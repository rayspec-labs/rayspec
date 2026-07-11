import { schema, type TenantDb } from '@rayspec/db';
import {
  type ArtifactContent,
  type ArtifactHandle,
  type ArtifactPersistInput,
  type ArtifactStore,
  contentHash,
  type StoredArtifact,
} from '@rayspec/grounding-runtime';
import { eq } from 'drizzle-orm';

/**
 * `TenantDbArtifactStore` — the TENANT-SCOPED, CONTENT-ADDRESSED artifact store the workflow's
 * store_write / store_read nodes persist through. It implements the Tier B
 * `@rayspec/grounding-runtime` `ArtifactStore` interface (so the existing `createArtifactPersistHandler`
 * / `createArtifactReadHandler` node factories back onto REAL durable storage) over the
 * `workflow_artifacts` table, reached ONLY through the TenantDb chokepoint — an artifact never leaves
 * its tenant.
 *
 * The handle id is CONTENT-ADDRESSED (`artifact:<namespace>:<scope>:<kind>:<content-hash>`) — byte-
 * identical to the reviewed in-memory `InMemoryArtifactStore` contract, so a handle minted by
 * either backend RESOLVES against the other (no cross-backend handle-id drift). `persist` is therefore an
 * idempotent GET-OR-CREATE (a re-persist of identical content is a no-op — the SAVEPOINT-scoped
 * get-or-create is recoverable via the UNIQUE(tenant, artifact_id) index + onConflictDoNothing).
 *
 * The optional `idempotency_key` does NOT alter the (content-addressed) handle id — matching the
 * in-memory store, whose handle id is ALWAYS content-hash-seeded. (The in-memory store additionally keys
 * an in-process dedup MAP by `idempotency_key` to force one identity across CONTENT variants; the durable
 * store needs no such map because its UNIQUE(tenant, artifact_id) already dedups by content, and forcing
 * an identity across differing content is out of scope for the content-addressed durable store — a
 * different content deterministically yields a different handle.)
 */
export class TenantDbArtifactStore implements ArtifactStore {
  constructor(
    private readonly tdb: TenantDb,
    /** Optional provenance: the workflow run that produced these artifacts. */
    private readonly workflowRunId?: string,
  ) {}

  async persist<TContent extends ArtifactContent>(
    input: ArtifactPersistInput<TContent>,
  ): Promise<StoredArtifact<TContent>> {
    const hash = contentHash(input.artifact.content);
    // CONTENT-ADDRESSED seed: ALWAYS the content hash — identical to the in-memory store's handle
    // id derivation. NEVER the idempotency_key (seeding from the key diverged the id across backends and
    // broke cross-backend handle resolution).
    const artifactId = buildArtifactId(input.namespace, input.scope, input.artifact.kind, hash);

    // Idempotent GET-OR-CREATE: INSERT .. ON CONFLICT DO NOTHING over UNIQUE(tenant, artifact_id).
    // The canonical handle is read back below (the winner's row wins on a get-or-create).
    await this.tdb
      .insert(schema.workflowArtifacts, {
        artifactId,
        workflowRunId: this.workflowRunId ?? null,
        kind: input.artifact.kind,
        namespace: input.namespace,
        scope: input.scope,
        contentHash: hash,
        version: '1',
        content: input.artifact.content as unknown as Record<string, unknown>,
        metadata: (input.artifact.metadata ?? {}) as Record<string, unknown>,
      })
      .onConflictDoNothing();

    // Read back the canonical row (the winner's content/version wins on a get-or-create).
    const stored = await this.read(artifactId);
    if (!stored)
      throw new Error(`TenantDbArtifactStore: artifact '${artifactId}' vanished after persist`);
    return stored as StoredArtifact<TContent>;
  }

  async read(handle: ArtifactHandle | string): Promise<StoredArtifact | undefined> {
    const id = typeof handle === 'string' ? handle : handle.id;
    const rows = (await this.tdb
      .select(schema.workflowArtifacts)
      .where(eq(schema.workflowArtifacts.artifactId, id))) as unknown as ArtifactRow[];
    const row = rows[0];
    if (!row) return undefined;
    return rowToStored(row);
  }

  async resolve(handle: ArtifactHandle | string): Promise<ArtifactHandle | undefined> {
    return (await this.read(handle))?.handle;
  }
}

interface ArtifactRow {
  artifactId: string;
  kind: string;
  namespace: string;
  scope: string;
  contentHash: string;
  version: string;
  content: unknown;
  metadata: unknown;
}

function rowToStored(row: ArtifactRow): StoredArtifact {
  return {
    handle: {
      id: row.artifactId,
      kind: row.kind,
      namespace: row.namespace,
      scope: row.scope,
      content_hash: row.contentHash,
      version: Number(row.version),
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
    },
    content: (row.content ?? null) as ArtifactContent,
  };
}

/** Mirror the in-memory store's handle-id shape so handles are stable across store backends. */
function buildArtifactId(namespace: string, scope: string, kind: string, seed: string): string {
  const shortHash = seed.replace(/^sha256:/, '').slice(0, 24);
  return `artifact:${namespace}:${scope}:${kind}:${shortHash}`;
}
