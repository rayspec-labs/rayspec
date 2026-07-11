/**
 * The injected, tenant-bound ports the capability core operates over — the EXACT platform
 * capability shapes (`HandlerDb`/`BlobStore` from @rayspec/handler-sdk, type-only, erased at
 * runtime), so the RaySpec binding threads `init.db`/`init.blob` straight through with no
 * adapter. The core NEVER constructs a capability — it is given tenant-bound handles.
 */
import type { BlobStore, HandlerDb } from '@rayspec/handler-sdk';
import type { ResolvedFileConfig } from './config.js';

export type { BlobStore, HandlerDb } from '@rayspec/handler-sdk';

/**
 * The tenant-bound context a capability operation runs against. `tenantId` is SERVER-DERIVED
 * (never client-supplied); `db` is bound to that tenant BY CONSTRUCTION (the binding built it from
 * the request's tenant). Submit needs no blob handle (it seals + emits over the pointer row).
 */
export interface FileCoreContext {
  readonly tenantId: string;
  readonly db: HandlerDb;
  readonly config: ResolvedFileConfig;
}

/** The blob-bearing context the upload operation runs against (`blob` is tenant-jailed inside). */
export interface FileBlobContext extends FileCoreContext {
  readonly blob: BlobStore;
}

/** The route path params a file operation reads (all DATA — server-parsed strings). */
export interface FileParams {
  readonly file_id?: string;
}

/**
 * The raw transport pieces of one upload request, extracted by the binding (headers + body
 * stream). Plain values so every guard arm is unit-testable without a `Request`. TRUST BOUNDARY: all of it
 * is UNTRUSTED CALLER DATA.
 */
export interface FileUploadRequest {
  /** The raw `Content-Length` header value (null/undefined when absent). */
  readonly contentLengthHeader: string | null | undefined;
  /** The raw `Content-Type` header value (null/undefined when absent). */
  readonly contentTypeHeader: string | null | undefined;
  /** The raw optional `x-file-name` header value (the client filename — DATA only). */
  readonly fileNameHeader: string | null | undefined;
  /** The raw body stream (null = empty body). */
  readonly body: ReadableStream<Uint8Array> | null;
}
