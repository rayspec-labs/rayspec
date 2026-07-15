/**
 * `deriveProductStores` — proves the Tier-A store bindings derive from the acme-notes.product.yaml
 * declarations and match the ground-truth donor shapes (the e2e PRODUCT_STORES), so the env boot stays
 * product-free. Fail-the-fix: the derived stores are asserted column-for-column against the ground
 * truth; an ambiguous transcript sink is rejected.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_SESSIONS_STORE, AUDIO_TRACKS_STORE } from '@rayspec/audio-runtime';
import { type ProductSpec, parseProductSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { DeriveStoresError, deriveProductStores } from './derive-stores.js';

const here = dirname(fileURLToPath(import.meta.url));
const ACME_YAML = resolve(here, '../../../../examples/acme-notes/acme-notes.product.yaml');
const AUDIO_STORES = new Set([AUDIO_SESSIONS_STORE, AUDIO_TRACKS_STORE]);

function acmeSpec(): ProductSpec {
  const parsed = parseProductSpec(readFileSync(ACME_YAML, 'utf8'));
  if (!parsed.ok)
    throw new Error(`acme-notes.product.yaml must parse: ${JSON.stringify(parsed.errors)}`);
  return parsed.value;
}

describe('deriveProductStores (acme-notes.product.yaml)', () => {
  it('derives the transcript sink + the artifact collection + their bindings from the YAML', () => {
    const derived = deriveProductStores(acmeSpec(), AUDIO_STORES);
    expect(derived.transcripts).toEqual({ store: 'track_transcripts' });
    expect([...derived.artifactCollections.entries()]).toEqual([
      ['note_artifacts', { store: 'note_artifacts' }],
    ]);
    expect(derived.stores.map((s) => s.name).sort()).toEqual([
      'note_artifacts',
      'track_transcripts',
    ]);
  });

  it('the derived store shapes MATCH the ground-truth donor stores (the e2e PRODUCT_STORES)', () => {
    const derived = deriveProductStores(acmeSpec(), AUDIO_STORES);
    const byName = new Map(derived.stores.map((s) => [s.name, s]));

    expect(byName.get('track_transcripts')?.columns).toEqual([
      { name: 'session_id', type: 'text', nullable: false, unique: false },
      { name: 'track', type: 'text', nullable: false, unique: false },
      { name: 'track_ref', type: 'text', nullable: false, unique: true },
      { name: 'status', type: 'text', nullable: false, unique: false },
      { name: 'model', type: 'text', nullable: true, unique: false },
      { name: 'detected_language', type: 'text', nullable: true, unique: false },
      { name: 'full_text', type: 'text', nullable: true, unique: false },
      { name: 'word_count', type: 'integer', nullable: true, unique: false },
      { name: 'payload', type: 'jsonb', nullable: true, unique: false },
    ]);

    expect(byName.get('note_artifacts')?.columns).toEqual([
      { name: 'session_id', type: 'text', nullable: false, unique: false }, // scope column (<scope>_id)
      { name: 'artifact_kind', type: 'text', nullable: false, unique: false },
      { name: 'payload', type: 'jsonb', nullable: false, unique: false },
      { name: 'human_edited', type: 'boolean', nullable: false, unique: false },
      { name: 'dismissed', type: 'boolean', nullable: false, unique: false },
      { name: 'artifact_ref', type: 'text', nullable: false, unique: true },
    ]);
  });

  it('acme-notes.product.yaml declares NO stores section — the absent-section default is a NO-OP', () => {
    const spec = acmeSpec();
    // The product document has no `stores:` — the parsed default is [] and the derived output is
    // EXACTLY the two known stores (no additional store, no column drift). Declared-store derivation
    // must be invisible for a doc that declares none.
    expect(spec.stores).toEqual([]);
    const derived = deriveProductStores(spec, AUDIO_STORES);
    expect(derived.stores.map((s) => s.name).sort()).toEqual([
      'note_artifacts',
      'track_transcripts',
    ]);
  });

  it('fail-closed: rejects an ambiguous transcript sink (two non-audio non-collection store views)', () => {
    const spec = acmeSpec();
    const withExtra: ProductSpec = {
      ...spec,
      views: [
        ...spec.views,
        // A second store-sourced view on a NEW store makes the transcript sink ambiguous.
        {
          id: 'extra',
          route: { method: 'GET', path: '/extra' },
          auth: 'bearer_tenant',
          source: { kind: 'store', ref: 'other_store' },
          read: { mode: 'list', shape: { fields: {} } },
        } as ProductSpec['views'][number],
      ],
    };
    expect(() => deriveProductStores(withExtra, AUDIO_STORES)).toThrow(DeriveStoresError);
  });
});

// ── the DECLARED product stores ─────────────────────────────────

/** A declared 0.2 store in the PARSED shape (StoreColumn defaults applied). */
function declaredStore(name: string, keyColumn = 'item_code'): ProductSpec['stores'][number] {
  return {
    name,
    columns: [
      { name: keyColumn, type: 'text', nullable: false, unique: false },
      { name: 'label', type: 'text', nullable: true, unique: false },
    ],
    key: [keyColumn],
  };
}

describe('deriveProductStores — declared 0.2 stores', () => {
  it('emits a declared store as a STANDARD StoreSpec: declared columns, key column derives unique, no FKs', () => {
    const spec: ProductSpec = { ...acmeSpec(), stores: [declaredStore('gadget_catalog')] };
    const derived = deriveProductStores(spec, AUDIO_STORES);
    const gadget = derived.stores.find((s) => s.name === 'gadget_catalog');
    // The derived shape IS the 0.1 StoreSpec family — generateProductSql/diffProductStores/drift/
    // classify/update-seam consume it unchanged. The conflict-key column derives unique: true (the
    // backing index the store_write upsert targets).
    expect(gadget).toEqual({
      name: 'gadget_catalog',
      columns: [
        { name: 'item_code', type: 'text', nullable: false, unique: true },
        { name: 'label', type: 'text', nullable: true, unique: false },
      ],
      foreignKeys: [],
    });
    // The pre-existing derived stores are untouched by the addition.
    expect(derived.stores.map((s) => s.name).sort()).toEqual([
      'gadget_catalog',
      'note_artifacts',
      'track_transcripts',
    ]);
  });

  it('excludes DECLARED store names from the transcript-sink inference (a store-sourced view over a declared store stays a declared-store view)', () => {
    const spec = acmeSpec();
    const withDeclared: ProductSpec = {
      ...spec,
      stores: [declaredStore('gadget_catalog')],
      views: [
        ...spec.views,
        // A store-sourced view over the DECLARED store: before the fix this made the transcript
        // sink AMBIGUOUS (two non-audio non-collection store-sourced refs) — fail-the-fix.
        {
          id: 'gadgets',
          route: { method: 'GET', path: '/gadgets' },
          auth: 'bearer_tenant',
          source: { kind: 'store', ref: 'gadget_catalog' },
          read: { mode: 'list', shape: { fields: {} } },
        } as ProductSpec['views'][number],
      ],
    };
    const derived = deriveProductStores(withDeclared, AUDIO_STORES);
    expect(derived.transcripts).toEqual({ store: 'track_transcripts' });
    expect(derived.stores.some((s) => s.name === 'gadget_catalog')).toBe(true);
  });

  it('fail-closed: a declared store colliding with a capability-owned (audio) store name', () => {
    const spec: ProductSpec = { ...acmeSpec(), stores: [declaredStore(AUDIO_SESSIONS_STORE)] };
    expect(() => deriveProductStores(spec, AUDIO_STORES)).toThrow(DeriveStoresError);
    expect(() => deriveProductStores(spec, AUDIO_STORES)).toThrow(/capability-owned/);
  });

  it('fail-closed: a declared store colliding with a derived collection store name (defense-in-depth beneath lint)', () => {
    const spec: ProductSpec = { ...acmeSpec(), stores: [declaredStore('note_artifacts')] };
    expect(() => deriveProductStores(spec, AUDIO_STORES)).toThrow(DeriveStoresError);
  });
});
