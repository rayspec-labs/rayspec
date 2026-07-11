/**
 * A deterministic in-memory `BlobStore` fake that ENFORCES THE REAL CONSTRAINTS (the
 * fail-the-fix discipline — a Map that accepts any key proves nothing):
 *
 *  - TENANT-BOUND BY CONSTRUCTION over ONE SHARED bucket: the handle closes over its `tenantId`
 *    and namespaces every object `${tenantId}/${callerKey}` — a test composing two tenant-bound
 *    fakes over one `SharedBlobBucket` proves keys never cross tenants.
 *  - THE PATH JAIL SHAPE (the `FsBlobStore` lexical rules, reproduced): empty key, null byte,
 *    URL-significant chars (`% # ?`), absolute/leading-slash keys, and `..` traversal segments all
 *    THROW — so a capability that ever derived a jail-violating key (e.g. one carrying a client
 *    filename) FAILS its test instead of silently passing.
 *  - `deleteTenant` is pinned to the handle's OWN bound tenant (fail-closed-refused otherwise) —
 *    the real impl's law.
 */
import type {
  BlobNotFound,
  BlobPutOpts,
  BlobRangeOpts,
  BlobReadResult,
  BlobStat,
  BlobStore,
} from '@rayspec/handler-sdk';

interface StoredBlob {
  readonly bytes: Uint8Array;
  readonly contentType?: string;
}

/** The shared underlying bucket (one per test) — the cross-tenant namespace authority. */
export class SharedBlobBucket {
  /** `${tenantId}/${callerKey}` → object. */
  readonly objects = new Map<string, StoredBlob>();

  /** Every raw put in order (`${tenantId}/${callerKey}`) — for put-count / key-shape assertions. */
  readonly puts: string[] = [];

  keys(): string[] {
    return [...this.objects.keys()];
  }
}

const URL_SIGNIFICANT = /[%#?]/;

/** The real jail's lexical rules, reproduced (fail-closed THROW — mirrors `BlobJailError`). */
function jailCheck(callerKey: string): void {
  if (typeof callerKey !== 'string' || callerKey.length === 0) {
    throw new Error('fake blob jail: empty key (fail-closed).');
  }
  if (callerKey.includes('\0')) {
    throw new Error('fake blob jail: null byte in key (fail-closed).');
  }
  if (URL_SIGNIFICANT.test(callerKey)) {
    throw new Error(`fake blob jail: URL-significant char in key '${callerKey}' (fail-closed).`);
  }
  if (callerKey.startsWith('/') || callerKey.startsWith('\\')) {
    throw new Error(`fake blob jail: absolute/leading-slash key '${callerKey}' (fail-closed).`);
  }
  if (callerKey.split(/[/\\]/).includes('..')) {
    throw new Error(`fake blob jail: traversal segment in key '${callerKey}' (fail-closed).`);
  }
}

function notFound(key: string): BlobNotFound {
  return { notFound: true, key };
}

function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** A tenant-bound fake `BlobStore` over a shared bucket (build one per tenant in a test). */
export function makeFakeBlobStore(bucket: SharedBlobBucket, tenantId: string): BlobStore {
  const namespaced = (callerKey: string): string => {
    jailCheck(callerKey);
    return `${tenantId}/${callerKey}`;
  };
  return {
    async put(
      key: string,
      body: Uint8Array | ReadableStream<Uint8Array>,
      opts?: BlobPutOpts,
    ): Promise<void> {
      const full = namespaced(key);
      let bytes: Uint8Array;
      if (body instanceof Uint8Array) {
        bytes = body;
      } else {
        const parts: Uint8Array[] = [];
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) parts.push(value);
        }
        bytes = concat(parts);
      }
      bucket.objects.set(full, {
        bytes,
        ...(opts?.contentType !== undefined ? { contentType: opts.contentType } : {}),
      });
      bucket.puts.push(full);
    },
    async get(key: string): Promise<BlobReadResult | BlobNotFound> {
      const stored = bucket.objects.get(namespaced(key));
      if (!stored) return notFound(key);
      return {
        body: toStream(stored.bytes),
        contentLength: stored.bytes.byteLength,
        ...(stored.contentType !== undefined ? { contentType: stored.contentType } : {}),
      };
    },
    async createReadStream(
      key: string,
      opts?: BlobRangeOpts,
    ): Promise<ReadableStream<Uint8Array> | BlobNotFound> {
      const stored = bucket.objects.get(namespaced(key));
      if (!stored) return notFound(key);
      const offset = opts?.offset ?? 0;
      const length = opts?.length ?? stored.bytes.byteLength - offset;
      return toStream(stored.bytes.slice(offset, offset + length));
    },
    async stat(key: string): Promise<BlobStat | BlobNotFound> {
      const stored = bucket.objects.get(namespaced(key));
      if (!stored) return notFound(key);
      return {
        len: stored.bytes.byteLength,
        etagSource: `fake-${stored.bytes.byteLength}`,
        ...(stored.contentType !== undefined ? { contentType: stored.contentType } : {}),
      };
    },
    async delete(key: string): Promise<void> {
      bucket.objects.delete(namespaced(key));
    },
    async deleteTenant(target: string): Promise<void> {
      // The real impl's law: a handle erases ONLY its own bound tenant — refuse anything else.
      if (target !== tenantId) {
        throw new Error(
          'fake blob jail: deleteTenant target does not match the bound tenant (fail-closed).',
        );
      }
      for (const key of [...bucket.objects.keys()]) {
        if (key.startsWith(`${tenantId}/`)) bucket.objects.delete(key);
      }
    },
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}
