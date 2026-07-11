/**
 * The injected, tenant-bound ports the capability core operates over — the EXACT platform
 * capability shape (`HandlerDb` from @rayspec/handler-sdk, type-only, erased at runtime), so the
 * RaySpec binding threads `init.db` straight through with no adapter. The core NEVER constructs a
 * capability — it is given tenant-bound handles. (No blob port: this capability moves JSON records
 * only — document/file ingest is deliberately out of scope.)
 */
import type { HandlerDb } from '@rayspec/handler-sdk';
import type { ResolvedRecordConfig } from './config.js';

export type { HandlerDb } from '@rayspec/handler-sdk';

/**
 * The tenant-bound context a capability operation runs against. `tenantId` is SERVER-DERIVED
 * (never client-supplied); `db` is bound to that tenant BY CONSTRUCTION (the binding built it from
 * the request's tenant).
 */
export interface RecordCoreContext {
  readonly tenantId: string;
  readonly db: HandlerDb;
  readonly config: ResolvedRecordConfig;
}

/** The route path params a record operation reads (all DATA — server-parsed strings). */
export interface RecordParams {
  readonly record_id?: string;
}
