/**
 * `deriveProductStores` (item 4) — derive the deployment's Tier-A product store
 * bindings (the transcript sink + the artifact collection stores + the DECLARED product stores)
 * FROM the validated product declarations + the canonical Tier-A row contracts, so the env-driven
 * boot composition stays PRODUCT-FREE (it reads no hardcoded product store definitions).
 *
 * The store NAMES come from the YAML: an artifact collection is `artifacts[].collection`; a DECLARED
 * product store is `stores[].name`; the transcript sink is the unique
 * `source: { kind: store }` view reference that is neither an audio capability store, an artifact
 * collection, NOR a declared store. The COLUMN SHAPES: collections/transcripts carry the canonical
 * Tier-A contracts (`compose.ts` COLLECTION_ROW_CONTRACT / TRANSCRIPT_ROW_CONTRACT); a declared store
 * carries its OWN declared business columns (the store column vocabulary) with the conflict-key column
 * deriving `unique: true` (the backing index the store_write upsert targets). Every derived store is a
 * standard `StoreSpec`, so the tenancy/GDPR columns are INJECTED downstream identically
 * (`generateProductSql`) and diff/drift/classify/update-seam/eraseTenant consume them unchanged.
 * `composeProductDeploy` fail-closed-verifies the same shapes at deploy, so a derived store that ever
 * drifts is caught there too.
 */
import type { ColumnType, ProductSpec, StoreSpec } from '@rayspec/spec';
import { COLLECTION_ROW_CONTRACT, TRANSCRIPT_ROW_CONTRACT } from './compose.js';

/** A fail-closed derivation defect (an ambiguous / unsatisfiable declaration). */
export class DeriveStoresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeriveStoresError';
  }
}

export interface DerivedProductStores {
  /** The Tier-A product stores (collection store(s) + the transcript sink), deploy-verifiable shapes. */
  readonly stores: StoreSpec[];
  /** The transcript sink binding (present iff the doc declares an `stt.*` workflow step). */
  readonly transcripts?: { readonly store: string };
  /** Declared `artifacts[].collection` → its backing store (store name == collection name). */
  readonly artifactCollections: Map<string, { readonly store: string }>;
}

/** Column nullability/uniqueness overrides on top of the canonical (name,type) contracts. */
const NOT_NULL_UNIQUE: ReadonlyMap<string, { nullable: boolean; unique: boolean }> = new Map([
  // transcript sink
  ['track_ref', { nullable: false, unique: true }],
  ['session_id', { nullable: false, unique: false }],
  ['track', { nullable: false, unique: false }],
  ['status', { nullable: false, unique: false }],
  ['model', { nullable: true, unique: false }],
  ['detected_language', { nullable: true, unique: false }],
  ['full_text', { nullable: true, unique: false }],
  ['word_count', { nullable: true, unique: false }],
  ['payload', { nullable: false, unique: false }], // overridden per-store below (collection: not-null)
  // collection
  ['artifact_ref', { nullable: false, unique: true }],
  ['artifact_kind', { nullable: false, unique: false }],
  ['human_edited', { nullable: false, unique: false }],
  ['dismissed', { nullable: false, unique: false }],
]);

function column(name: string, type: ColumnType, nullable: boolean, unique: boolean) {
  return { name, type, nullable, unique };
}

/** Build a StoreSpec from a canonical (name,type) contract + a per-column null/unique lookup + extras. */
function storeFromContract(
  name: string,
  contract: ReadonlyArray<readonly [string, ColumnType]>,
  overrides: ReadonlyMap<string, { nullable: boolean; unique: boolean }>,
  leadColumns: ReadonlyArray<readonly [string, ColumnType, boolean, boolean]> = [],
): StoreSpec {
  const columns = [
    ...leadColumns.map(([n, t, nl, uq]) => column(n, t, nl, uq)),
    ...contract.map(([n, t]) => {
      const o = overrides.get(n) ?? { nullable: false, unique: false };
      return column(n, t, o.nullable, o.unique);
    }),
  ];
  return { name, columns, foreignKeys: [] };
}

export function deriveProductStores(
  spec: ProductSpec,
  audioStoreNames: ReadonlySet<string>,
): DerivedProductStores {
  const persisting = spec.artifacts.filter((a) => a.lifecycle?.persist !== false);

  // ── artifact collection stores (name = the declared collection; scope column = `<scope>_id`) ──
  const collectionNames = new Set<string>();
  for (const a of persisting) {
    if (!a.collection) {
      throw new DeriveStoresError(
        `artifact kind '${a.kind}' declares lifecycle.persist but no collection — cannot derive its store.`,
      );
    }
    collectionNames.add(a.collection);
  }
  let scopeColumn: string | undefined;
  if (persisting.length > 0) {
    const scopes = [...new Set(persisting.map((a) => a.scope))];
    if (scopes.length !== 1 || typeof scopes[0] !== 'string' || scopes[0].length === 0) {
      throw new DeriveStoresError(
        `every persisted artifact kind must declare the SAME non-empty scope; got: ${scopes
          .map((s) => s ?? '(none)')
          .join(', ')}.`,
      );
    }
    scopeColumn = `${scopes[0]}_id`;
  }

  const stores: StoreSpec[] = [];
  const artifactCollections = new Map<string, { store: string }>();
  for (const collection of collectionNames) {
    if (!scopeColumn) {
      throw new DeriveStoresError(
        `collection '${collection}' has persisting kinds but no derivable scope.`,
      );
    }
    // The collection `payload` is NOT NULL (unlike the transcript sink's nullable payload).
    const collectionOverrides = new Map(NOT_NULL_UNIQUE);
    collectionOverrides.set('payload', { nullable: false, unique: false });
    stores.push(
      storeFromContract(collection, COLLECTION_ROW_CONTRACT, collectionOverrides, [
        [scopeColumn, 'text', false, false],
      ]),
    );
    artifactCollections.set(collection, { store: collection });
  }

  // ── the DECLARED product stores (the product `stores` section) ───────────────────────
  // Each declared store is a standard StoreSpec: the declared business columns ride verbatim, the
  // conflict-key column derives `unique: true` (the backing unique index every store_write upsert
  // targets — the at-least-once law needs it to exist), and there are no FKs (deliberate v1 scope).
  // Tenancy/GDPR columns are injected downstream by generateProductSql exactly like every other
  // derived store. Fail-closed on a name colliding with a capability-owned or collection store
  // (lint already rejects the collection collision at doc level; this guards code-built specs).
  const declaredNames = new Set<string>();
  for (const declared of spec.stores) {
    if (audioStoreNames.has(declared.name)) {
      throw new DeriveStoresError(
        `declared store '${declared.name}' collides with a capability-owned store of the same ` +
          'name — capability stores are owned by their Tier-B runtime; declare a distinct name.',
      );
    }
    if (collectionNames.has(declared.name)) {
      throw new DeriveStoresError(
        `declared store '${declared.name}' collides with the derived artifact collection store of ` +
          'the same name — collections are derived from artifacts[].collection; declare a distinct name.',
      );
    }
    const keyColumns = new Set(declared.key);
    stores.push({
      name: declared.name,
      columns: declared.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        unique: c.unique || keyColumns.has(c.name),
      })),
      foreignKeys: [],
    });
    declaredNames.add(declared.name);
  }

  // ── the transcript sink (only when an stt.* workflow step is declared) ────────────────────────
  const usesStt = spec.workflows.some((wf) => wf.steps.some((s) => s.use?.startsWith('stt.')));
  let transcripts: { store: string } | undefined;
  if (usesStt) {
    const storeSources = new Set<string>();
    for (const view of spec.views) {
      if (view.source?.kind === 'store') storeSources.add(view.source.ref);
    }
    // A DECLARED store name is excluded from the sink candidates (S2): a store-sourced view over a
    // declared store is that store's own read view, never the transcript sink.
    const candidates = [...storeSources].filter(
      (n) => !audioStoreNames.has(n) && !collectionNames.has(n) && !declaredNames.has(n),
    );
    if (candidates.length !== 1 || !candidates[0]) {
      throw new DeriveStoresError(
        'expected EXACTLY ONE transcript sink store (a store-sourced view that is neither an audio ' +
          'capability store, an artifact collection, nor a declared product store); got: ' +
          `${candidates.join(', ') || '(none)'}. ` +
          'Declare the transcript read view with a `source: { kind: store }` on the sink store.',
      );
    }
    const transcriptOverrides = new Map(NOT_NULL_UNIQUE);
    transcriptOverrides.set('payload', { nullable: true, unique: false }); // transcript payload is nullable
    stores.push(storeFromContract(candidates[0], TRANSCRIPT_ROW_CONTRACT, transcriptOverrides));
    transcripts = { store: candidates[0] };
  }

  return { stores, ...(transcripts ? { transcripts } : {}), artifactCollections };
}
