# Public API report — @rayspec/pack-sdk

<!--
GENERATED FILE — do not edit by hand.

Derived from this package's BUILT type declarations by scripts/check-public-api-report.mjs, so it
records the surface a consumer of the published package actually gets. Any change to that surface
must be regenerated here and committed in the same change:

    node scripts/check-public-api-report.mjs --write
-->

## Entry point `.` — `dist/index.d.ts`

21 export(s).

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
 | 'dangling_ref'
 | 'duplicate_name'
 | 'capability_violation'
 | 'invalid_embedded_schema'
 | 'reserved_column_name'
 | 'reserved_query_keyword'
 | 'reserved_store_name'
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

### `PackHandlerKind` — `dist/manifest.d.ts`

```ts
export type PackHandlerKind = 'tool' | 'route' | 'trigger';
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

### `PackJournalStepType` — `dist/journal.d.ts`

```ts
export type PackJournalStepType = 'llm' | 'tool' | 'store';
```

### `PackManifest` — `dist/manifest.d.ts`

```ts
export interface PackManifest {
    readonly version: string;
    readonly fragments: PackFragments;
    readonly capabilities?: PackCapabilities;
}
```

### `PackManifestBrand` — `dist/manifest.d.ts`

```ts
export type PackManifestBrand = '@rayspec/extension@1';
```

### `PackStoreFragment` — `dist/manifest.d.ts`

```ts
export interface PackStoreFragment {
    readonly name: string;
    readonly [declaredKey: string]: unknown;
}
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

### `SAFE_IDENTIFIER_RE` — `dist/identifier.d.ts`

```ts
export declare const SAFE_IDENTIFIER_RE: RegExp;
```

### `isSafeIdentifier` — `dist/identifier.d.ts`

```ts
export declare function isSafeIdentifier(value: string): boolean;
```
