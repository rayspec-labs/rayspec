# Public API report — @rayspec/pack-sdk

<!--
GENERATED FILE — do not edit by hand. [rayspec-public-api-report/v1]

Derived from this package's BUILT type declarations by scripts/check-public-api-report.mjs, so it
records the surface a consumer of the published package actually gets. Any change to that surface
must be regenerated here and committed in the same change:

    node scripts/check-public-api-report.mjs --write
-->

## Entry point `.` — `dist/index.d.ts`

43 export(s).

### `DefinedPack` — `dist/manifest.d.ts`

```ts
export interface DefinedPack extends PackManifest {
    readonly __rayspecExtension: PackManifestBrand;
}
```

### `MAX_IDENTIFIER_LENGTH` — `dist/identifier.d.ts`

```ts
export declare const MAX_IDENTIFIER_LENGTH = 63;
```

### `PackAgentFragment` — `dist/manifest.d.ts`

```ts
export interface PackAgentFragment {
    readonly id: string;
    readonly [declaredKey: string]: unknown;
}
```

### `PackApiRouteFragment` — `dist/manifest.d.ts`

```ts
export interface PackApiRouteFragment {
    readonly method: PackHttpMethod;
    readonly path: string;
    readonly [declaredKey: string]: unknown;
}
```

### `PackCapabilities` — `dist/manifest.d.ts`

```ts
export type PackCapabilities = object;
```

### `PackDatabase` — `dist/service.d.ts`

```ts
export interface PackDatabase {
    query(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
    transaction<T>(fn: (tx: PackDatabase) => Promise<T>): Promise<T>;
}
```

### `PackError` — `dist/errors.d.ts`

```ts
export interface PackError {
    readonly code: PackErrorCode;
    readonly message: string;
    readonly path?: string;
}
```

### `PackErrorCode` — `dist/errors.d.ts`

```ts
export type PackErrorCode =
'yaml_parse_error'
 | 'unsupported_version'
 | 'schema_violation'
 | 'unknown_field'
 | 'reserved_document_key'
 | 'extension_pack_unavailable'
 | 'extension_pack_refused'
 | 'dangling_ref'
 | 'duplicate_name'
 | 'capability_violation'
 | 'invalid_embedded_schema'
 | 'reserved_column_name'
 | 'reserved_query_keyword'
 | 'reserved_store_name'
 | 'reserved_route_path'
 | 'frontend_route_collision'
 | 'frontend_dir_missing'
 | 'fk_cycle'
 | 'agent_output_schema_shortcircuits_tools'
 | 'projection_unknown_column'
 | 'projection_collision'
 | 'projection_query_shadow'
 | 'no_code_in_yaml'
 | 'provider_native_leak'
 | 'invalid_capability_status'
 | 'invalid_contract'
 | 'prompt_execution_claim'
 | 'production_execution_claim'
 | 'invalid_dependency_order'
 | 'invalid_view'
 | 'invalid_store';
```

### `PackFragments` — `dist/manifest.d.ts`

```ts
export interface PackFragments {
    readonly stores?: readonly PackStoreFragment[];
    readonly handlers?: readonly PackHandlerFragment[];
    readonly tooling?: readonly PackToolFragment[];
    readonly api?: readonly PackApiRouteFragment[];
    readonly agents?: readonly PackAgentFragment[];
}
```

### `PackHandlerFragment` — `dist/manifest.d.ts`

```ts
export interface PackHandlerFragment {
    readonly id: string;
    readonly module: string;
    readonly export: string;
    readonly kind: PackHandlerKind;
    readonly [declaredKey: string]: unknown;
}
```

### `PackHandlerInit` — `dist/handler.d.ts`

```ts
export interface PackHandlerInit {
    readonly tenantId: string;
    readonly db: PackStoreDb;
}
```

### `PackHandlerKind` — `dist/manifest.d.ts`

```ts
export type PackHandlerKind = 'tool' | 'route' | 'trigger';
```

### `PackHandlerPrincipal` — `dist/handler.d.ts`

```ts
export interface PackHandlerPrincipal {
    readonly kind: 'user' | 'apikey' | 'm2m';
    readonly id: string;
    readonly role?: string;
}
```

### `PackHttpMethod` — `dist/manifest.d.ts`

```ts
export type PackHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
```

### `PackJournalEntry` — `dist/journal.d.ts`

```ts
export interface PackJournalEntry {
    readonly stepId: string;
    readonly runId: string;
    readonly tenantId: string;
    readonly type: PackJournalStepType;
    readonly idempotencyKey: string;
    readonly inputHash: string;
    readonly output: unknown;
    readonly usage: PackTokenUsage;
    readonly costUsd: number;
    readonly latencyMs: number;
    readonly status: PackJournalStatus;
    readonly createdAt: string;
}
```

### `PackJournalStatus` — `dist/journal.d.ts`

```ts
export type PackJournalStatus = 'ok' | 'error';
```

### `PackJournalStep` — `dist/service.d.ts`

```ts
export interface PackJournalStep {
    readonly runId: string;
    readonly type: PackJournalStepType;
    readonly idempotencyKey: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly status: PackJournalStatus;
    readonly latencyMs?: number;
}
```

### `PackJournalStepType` — `dist/journal.d.ts`

```ts
export type PackJournalStepType = 'llm' | 'tool' | 'store';
```

### `PackJournalWriter` — `dist/service.d.ts`

```ts
export interface PackJournalWriter {
    record(step: PackJournalStep): Promise<void>;
}
```

### `PackManifest` — `dist/manifest.d.ts`

```ts
export interface PackManifest {
    readonly version: string;
    readonly routePrefix?: string;
    readonly fragments: PackFragments;
    readonly sections?: readonly PackSectionClaim[];
    readonly migrations?: PackMigrationChain;
    readonly services?: readonly PackServiceDeclaration[];
    readonly capabilities?: PackCapabilities;
}
```

### `PackManifestBrand` — `dist/manifest.d.ts`

```ts
export type PackManifestBrand = '@rayspec/extension@1';
```

### `PackMigrationChain` — `dist/manifest.d.ts`

```ts
export interface PackMigrationChain {
    readonly dir: string;
    readonly tablePrefix: string;
}
```

### `PackRouteHandler` — `dist/handler.d.ts`

```ts
export type PackRouteHandler<Out = unknown> = (init: PackRouteHandlerInit) => Promise<Out> | Out;
```

### `PackRouteHandlerInit` — `dist/handler.d.ts`

```ts
export interface PackRouteHandlerInit extends PackHandlerInit {
    readonly params: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly principal?: PackHandlerPrincipal;
}
```

### `PackSectionClaim` — `dist/manifest.d.ts`

```ts
export interface PackSectionClaim {
    readonly key: string;
    readonly schemaModule: string;
}
```

### `PackSelectOptions` — `dist/handler.d.ts`

```ts
export interface PackSelectOptions {
    readonly orderBy?: ReadonlyArray<{
        readonly column: string;
        readonly dir?: 'asc' | 'desc';
    }>;
    readonly limit?: number;
    readonly offset?: number;
}
```

### `PackServiceContext` — `dist/service.d.ts`

```ts
export interface PackServiceContext {
    readonly packId: string;
    readonly db: PackDatabase;
    readonly spec: Readonly<Record<string, unknown>>;
    readonly sections: Readonly<Record<string, unknown>>;
    readonly journal?: PackJournalWriter;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly dispatch?: TurnDispatch;
}
```

### `PackServiceDeclaration` — `dist/service.d.ts`

```ts
export interface PackServiceDeclaration {
    readonly module: string;
}
```

### `PackServiceModule` — `dist/service.d.ts`

```ts
export interface PackServiceModule {
    readonly name: string;
    boot(ctx: PackServiceContext): Promise<void> | void;
    shutdown(): Promise<void> | void;
}
```

### `PackStoreDb` — `dist/handler.d.ts`

```ts
export interface PackStoreDb {
    select(store: string, filter?: PackStoreFilter, opts?: PackSelectOptions): Promise<PackStoreRow[]>;
    count?(store: string, filter?: PackStoreFilter): Promise<number>;
    insert(store: string, values: PackStoreRow): Promise<PackStoreRow>;
    upsert(store: string, conflictColumns: string[], values: PackStoreRow, opts?: PackUpsertOptions): Promise<PackStoreRow | undefined>;
    update(store: string, filter: PackStoreFilter, patch: PackStoreRow): Promise<PackStoreRow[]>;
    delete(store: string, filter: PackStoreFilter): Promise<number>;
    transaction<T>(fn: (tx: PackStoreDb) => Promise<T>): Promise<T>;
}
```

### `PackStoreFilter` — `dist/handler.d.ts`

```ts
export type PackStoreFilter = Record<string, unknown>;
```

### `PackStoreFragment` — `dist/manifest.d.ts`

```ts
export interface PackStoreFragment {
    readonly name: string;
    readonly [declaredKey: string]: unknown;
}
```

### `PackStoreRow` — `dist/handler.d.ts`

```ts
export type PackStoreRow = Record<string, unknown>;
```

### `PackTokenUsage` — `dist/journal.d.ts`

```ts
export interface PackTokenUsage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly reasoningTokens?: number;
}
```

### `PackToolFragment` — `dist/manifest.d.ts`

```ts
export interface PackToolFragment {
    readonly id: string;
    readonly handler: string;
    readonly [declaredKey: string]: unknown;
}
```

### `PackToolHandler` — `dist/handler.d.ts`

```ts
export type PackToolHandler<In = unknown, Out = unknown> = (args: In, init: PackToolHandlerInit) => Promise<Out> | Out;
```

### `PackToolHandlerInit` — `dist/handler.d.ts`

```ts
export type PackToolHandlerInit = PackHandlerInit;
```

### `PackUpsertOptions` — `dist/handler.d.ts`

```ts
export interface PackUpsertOptions {
    readonly updateWhere?: PackStoreFilter;
}
```

### `SAFE_IDENTIFIER_RE` — `dist/identifier.d.ts`

```ts
export declare const SAFE_IDENTIFIER_RE: RegExp;
```

### `TurnDispatch` — `dist/service.d.ts`

```ts
export interface TurnDispatch {
    schedule(request: TurnDispatchRequest): Promise<TurnDispatchResult>;
}
```

### `TurnDispatchRequest` — `dist/service.d.ts`

```ts
export interface TurnDispatchRequest {
    readonly agentId: string;
    readonly input: string;
    readonly instructions?: string;
    readonly maxTurns?: number;
}
```

### `TurnDispatchResult` — `dist/service.d.ts`

```ts
export interface TurnDispatchResult {
    readonly runId: string;
}
```

### `isSafeIdentifier` — `dist/identifier.d.ts`

```ts
export declare function isSafeIdentifier(value: string): boolean;
```
