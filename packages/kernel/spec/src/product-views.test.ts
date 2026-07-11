/**
 * Product-YAML VIEW declarations — the read+projection vocabulary.
 *
 * RED-FIRST anchor: the workflow bridge — and the earlier fixtures — conflated a
 * view's SOURCE (what backing data the view reads) with its RESPONSE CONTRACT (what DTO shape it
 * returns): `source.ref` pointed at the view's own `response_contract`. The first describe block
 * asserts the separation the design mandates:
 *   - an `artifact_query` source must resolve to a DECLARED ARTIFACT (kind or collection) — a ref
 *     that merely names a contract (including the view's own response contract) is REJECTED;
 *   - a `store` source names a Tier-A/B STORE (safe identifier) — it is NEVER resolved against
 *     contracts, and a dotted contract-id-shaped ref is REJECTED;
 *   - a `capability` source must resolve to a CAPABILITY-declared contract — a top-level product
 *     contract does not satisfy it.
 * These three were written BEFORE the kind-aware lint existed and failed against the earlier lint
 * (which resolved every source ref against the flat contract set) — the red-first evidence.
 */
import { describe, expect, it } from 'vitest';
import type { SpecError } from './errors.js';
import { parseProductSpec } from './product-parse.js';

/** Build a minimal valid Product-YAML doc with the given views/artifacts/contracts YAML fragments. */
function doc(fragments: { artifacts?: string; contracts?: string; views: string }): string {
  return `
version: '1.0'
product:
  id: demoapp
  name: Demo App
capabilities:
  - id: audio_input
    tier: B
    status: reserved
    contracts:
      - audio_input.finalized_session
      - audio_input.upload_status
artifacts:
${
  fragments.artifacts ??
  `  - kind: note
    contract: demo.note
    collection: demo_notes`
}
contracts:
  demo.note:
    type: object
  demo.open_response:
    type: object
  demo.list_response:
    type: object
    properties:
      items:
        type: array
      total:
        type: integer
      next_offset:
        type: [integer, "null"]
    required: [items, total, next_offset]
${fragments.contracts ?? ''}
views:
${fragments.views}
`;
}

/** A minimal interpretable read (collect mode, empty projection) against the OPEN contract. */
const MINIMAL_READ = `    read:
      mode: collect
      shape:
        fields: {}`;

function errorsOf(yaml: string): SpecError[] {
  const res = parseProductSpec(yaml);
  if (res.ok) return [];
  return res.errors;
}

describe('CL-BRIDGE-MINOR-1 — view source (backing data) ≠ response contract (DTO shape)', () => {
  it('REJECTS an INTERPRETED artifact_query source whose ref is the view’s own response contract (the conflation)', () => {
    const errors = errorsOf(
      doc({
        views: `  - id: v_list
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    source:
      kind: artifact_query
      ref: demo.open_response
${MINIMAL_READ}
    response_contract: demo.open_response`,
      }),
    );
    // The whole point: a response contract is NOT backing data. The ref must fail to resolve as an
    // artifact (kind/collection), with an error pointing at the source ref.
    expect(errors.some((e) => e.path === 'views[0].source.ref' && e.code === 'invalid_view')).toBe(
      true,
    );
  });

  it('REJECTS an INTERPRETED artifact_query source naming ANY contract id that is not a declared artifact', () => {
    const errors = errorsOf(
      doc({
        views: `  - id: v_list
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    source:
      kind: artifact_query
      ref: demo.note
${MINIMAL_READ}
    response_contract: demo.open_response`,
      }),
    );
    // demo.note is a CONTRACT id (the artifact's payload contract) — not the artifact kind itself.
    expect(errors.some((e) => e.path === 'views[0].source.ref' && e.code === 'invalid_view')).toBe(
      true,
    );
  });

  it('LEGACY: a DECLARATION-ONLY (no read) artifact_query view may still ref a contract — but it can never mount', () => {
    // A frozen legacy donor (byte-synced to the committed product fixture)
    // declares the conflated form; a declaration-only view keeps parsing (documented judgment call).
    // The separation is STRICT for every view that can EXECUTE (`read` present — the cases above).
    const res = parseProductSpec(
      doc({
        views: `  - id: v_legacy
    route: { method: GET, path: /notes-legacy }
    auth: bearer_tenant
    source:
      kind: artifact_query
      ref: demo.list_response
    response_contract: demo.list_response`,
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('a DECLARATION-ONLY artifact_query ref naming a CAPABILITY contract is REJECTED (carve-out = contract ids ONLY, the frozen donor class)', () => {
    // Red-first: the legacy carve-out silently accepted ANY read-less artifact_query view naming a
    // capability contract. The frozen legacy donor (the class the carve-out exists
    // for) only ever refs TOP-LEVEL contract ids (top-level response contracts) —
    // everything outside that class is dead-on-arrival.
    const errs = errorsOf(
      doc({
        views: `  - id: v_legacy_cap
    route: { method: GET, path: /notes-legacy-cap }
    auth: bearer_tenant
    source:
      kind: artifact_query
      ref: audio_input.upload_status
    response_contract: demo.open_response`,
      }),
    );
    expect(errs.some((e) => e.path === 'views[0].source.ref' && e.code === 'invalid_view')).toBe(
      true,
    );
  });

  it('ACCEPTS an artifact_query source resolving to a declared artifact KIND', () => {
    const res = parseProductSpec(
      doc({
        views: `  - id: v_list
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    source:
      kind: artifact_query
      ref: note
    response_contract: demo.list_response`,
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('ACCEPTS an artifact_query source resolving to a declared artifact COLLECTION', () => {
    const res = parseProductSpec(
      doc({
        views: `  - id: v_list
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    source:
      kind: artifact_query
      ref: demo_notes
    response_contract: demo.list_response`,
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('REJECTS a store source whose ref is a dotted contract id (a store is a safe identifier, never a contract)', () => {
    const errors = errorsOf(
      doc({
        views: `  - id: v_list
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    source:
      kind: store
      ref: demo.list_response
    response_contract: demo.list_response`,
      }),
    );
    expect(errors.some((e) => e.path === 'views[0].source.ref')).toBe(true);
  });

  it('ACCEPTS a store source naming a plain safe-identifier store', () => {
    const res = parseProductSpec(
      doc({
        views: `  - id: v_list
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    source:
      kind: store
      ref: demo_notes_store
    response_contract: demo.list_response`,
      }),
    );
    expect(res.ok).toBe(true);
  });

  it('REJECTS a capability source whose ref is a top-level product contract (must be capability-declared)', () => {
    const errors = errorsOf(
      doc({
        views: `  - id: v_cap
    route: { method: GET, path: /notes-cap }
    auth: bearer_tenant
    source:
      kind: capability
      ref: demo.list_response
    response_contract: demo.list_response`,
      }),
    );
    expect(errors.some((e) => e.path === 'views[0].source.ref')).toBe(true);
  });

  it('ACCEPTS a capability source resolving to a capability-declared contract', () => {
    const res = parseProductSpec(
      doc({
        views: `  - id: v_cap
    route: { method: GET, path: /notes-cap }
    auth: bearer_tenant
    source:
      kind: capability
      ref: audio_input.upload_status
    response_contract: demo.list_response`,
      }),
    );
    expect(res.ok).toBe(true);
  });
});

// =========================================================================================
// THE WHOLE-INVARIANT REJECTION TABLE (S8 gate: "route declarations cannot run arbitrary code"
// + the fail-open lesson: reject loudly). NOT "≥1 rejection": every field kind is checked against every
// context it is NOT allowed in, every law has its violation case, and every name position is
// checked against the whole reserved-name set.
// =========================================================================================

import type { ProductViewSpec } from './product-grammar.js';
import { VIEW_RESERVED_NAMES, type ViewField } from './product-views.js';
import { lintProductViews, type ViewLintInput, viewPathParams } from './product-views-lint.js';

/** Minimal constructible instance of EVERY ViewField kind (the closed union, enumerated). */
const FIELD_INSTANCES: Record<ViewField['kind'], ViewField> = {
  column: { kind: 'column', column: 'a_col', type: 'string' },
  json: { kind: 'json', column: 'payload', path: ['x'], type: 'string' },
  param: { kind: 'param', param: 'pid' },
  const: { kind: 'const', value: null },
  items: {
    kind: 'items',
    column: 'payload',
    path: ['xs'],
    shape: { fields: { v: { kind: 'item', path: ['v'], type: 'string' } } },
  },
  list: {
    kind: 'list',
    source: { store: 'child_store', match: { parent_id: { column: 'id' } } },
    shape: { fields: { v: { kind: 'column', column: 'v', type: 'string' } } },
  },
  lookup: {
    kind: 'lookup',
    source: { store: 'child_store', match: { parent_id: { column: 'id' } } },
    field: { column: 'v' },
    type: 'string',
  },
  counts: {
    kind: 'counts',
    of: { store: 'child_store', match: { parent_id: { column: 'id' } } },
    by: 'k',
    buckets: ['a'],
    total: 'all_rows',
  },
  group: {
    kind: 'group',
    column: 'k',
    equals: 'a',
    mode: 'list',
    value: { column: 'payload', type: 'object' },
  },
  page_items: { kind: 'page_items', shape: { fields: {} } },
  page_total: { kind: 'page_total' },
  page_next_offset: { kind: 'page_next_offset' },
};

const ALL_KINDS = Object.keys(FIELD_INSTANCES) as Array<ViewField['kind']>;

/** The intended context table (mirrors the lint's ALLOWED_KINDS — asserted kind-by-kind below). */
const CONTEXT_ALLOWED: Record<'list' | 'single' | 'collect', ReadonlySet<ViewField['kind']>> = {
  list: new Set(['page_items', 'page_total', 'page_next_offset', 'param', 'const']),
  single: new Set(['column', 'json', 'param', 'const', 'items', 'list', 'lookup', 'counts']),
  collect: new Set(['param', 'const', 'group', 'counts']),
};

/** Build a code-built lint input around ONE view (the mount-facing entry views-runtime uses). */
function lintInputFor(view: Partial<ProductViewSpec>): ViewLintInput {
  return {
    views: [
      {
        id: 'v',
        route: { method: 'GET', path: '/things/{pid}' },
        auth: 'bearer_tenant',
        params: { pid: { in: 'path', shape: 'safe_id' } },
        response_contract: 'open_response',
        ...view,
      } as ProductViewSpec,
    ],
    contracts: { open_response: { type: 'object' } },
    artifacts: [{ kind: 'thing', contract: 'open_response', collection: 'thing_artifacts' }],
    capabilities: [{ id: 'cap_a', tier: 'B', status: 'reserved', contracts: ['cap_a.thing'] }],
  };
}

function lintErrors(view: Partial<ProductViewSpec>) {
  return lintProductViews(lintInputFor(view));
}

/** A valid read per mode (so each table case isolates exactly the out-of-context field). */
function readFor(mode: 'list' | 'single' | 'collect', field: ViewField) {
  const shape = { fields: { probe: field } };
  if (mode === 'list') {
    // keep the mandatory page_items alongside the probe so ONLY the probe is the violation
    return {
      read: {
        mode,
        shape: { fields: { items: FIELD_INSTANCES.page_items, probe: field } },
      },
      pagination: { limit_param: 'limit', offset_param: 'offset', max_limit: 50 },
    } as Partial<ProductViewSpec>;
  }
  if (mode === 'single') {
    return {
      read: { mode, shape, absent: { fields: {} } },
      absent_state: 'empty_200',
      source: { kind: 'store', ref: 'things_store' },
    } as Partial<ProductViewSpec>;
  }
  return { read: { mode, shape } } as Partial<ProductViewSpec>;
}

describe('context table — EVERY field kind × EVERY context it is not allowed in is REJECTED', () => {
  for (const mode of ['list', 'single', 'collect'] as const) {
    const allowed = CONTEXT_ALLOWED[mode];
    for (const kind of ALL_KINDS) {
      const field = FIELD_INSTANCES[kind];
      const base: Partial<ProductViewSpec> = {
        source: { kind: 'store', ref: 'things_store' },
        ...readFor(mode, field),
      };
      if (allowed.has(kind)) {
        it(`${mode}: ALLOWS '${kind}'`, () => {
          const errs = lintErrors(base).filter((e) =>
            e.message.includes(`'${kind}' is not allowed`),
          );
          expect(errs).toEqual([]);
        });
      } else {
        it(`${mode}: REJECTS '${kind}' (out of context — never skipped)`, () => {
          const errs = lintErrors(base);
          expect(
            errs.some(
              (e) =>
                e.code === 'invalid_view' && e.message.includes(`kind '${kind}' is not allowed`),
            ),
          ).toBe(true);
        });
      }
    }
  }

  it('NESTED row shapes reject group/page fields (the whole nested set)', () => {
    for (const kind of ['group', 'page_items', 'page_total', 'page_next_offset'] as const) {
      const errs = lintErrors({
        source: { kind: 'store', ref: 'things_store' },
        absent_state: 'empty_200',
        read: {
          mode: 'single',
          shape: {
            fields: {
              children: {
                kind: 'list',
                source: { store: 'child_store', match: { parent_id: { column: 'id' } } },
                shape: { fields: { probe: FIELD_INSTANCES[kind] } },
              },
            },
          },
          absent: { fields: {} },
        },
      });
      expect(
        errs.some(
          (e) => e.code === 'invalid_view' && e.message.includes(`kind '${kind}' is not allowed`),
        ),
      ).toBe(true);
    }
  });
});

describe('unknown constructs are rejected at the GRAMMAR (never silently dropped)', () => {
  const readView = (readYaml: string) =>
    doc({
      views: `  - id: v
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    params:
      q: { in: query, shape: safe_id }
    source: { kind: store, ref: notes_store }
${readYaml}
    response_contract: demo.open_response`,
    });

  it('rejects an unknown field kind', () => {
    const errs = errorsOf(
      readView(`    read:
      mode: collect
      shape:
        fields:
          x: { kind: compute, expression: "1+1" }`),
    );
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((e) => e.code === 'schema_violation' || e.code === 'unknown_field')).toBe(
      true,
    );
  });

  it('rejects an unknown key inside a known field (strict)', () => {
    const errs = errorsOf(
      readView(`    read:
      mode: collect
      shape:
        fields:
          x: { kind: const, value: 1, transform: upper }`),
    );
    expect(errs.some((e) => e.code === 'unknown_field' || e.code === 'schema_violation')).toBe(
      true,
    );
  });

  it('rejects an unknown read mode', () => {
    const errs = errorsOf(
      readView(`    read:
      mode: stream
      shape: { fields: {} }`),
    );
    expect(errs.some((e) => e.code === 'schema_violation')).toBe(true);
  });

  it('rejects an unknown param shape preset (no free-form regex slot exists)', () => {
    const errs = errorsOf(
      doc({
        views: `  - id: v
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    params:
      q: { in: query, shape: "regex:.*" }
    response_contract: demo.open_response`,
      }),
    );
    expect(errs.some((e) => e.code === 'schema_violation')).toBe(true);
  });

  it('rejects an unknown conditional_read value', () => {
    const errs = errorsOf(
      doc({
        views: `  - id: v
    route: { method: GET, path: /notes }
    auth: bearer_tenant
    conditional_read: last_modified
    response_contract: demo.open_response`,
      }),
    );
    expect(errs.some((e) => e.code === 'schema_violation')).toBe(true);
  });

  it('rejects a row-context field inside an ITEMS shape (closed by construction)', () => {
    const errs = errorsOf(
      readView(`    read:
      mode: collect
      shape:
        fields:
          xs:
            kind: group
            column: k
            equals: a
            mode: list
            shape:
              fields:
                ys:
                  kind: items
                  column: payload
                  shape:
                    fields:
                      bad: { kind: column, column: v, type: string }`),
    );
    expect(errs.some((e) => e.code === 'schema_violation')).toBe(true);
  });

  it('rejects a row-context field inside the ABSENT shape (closed by construction)', () => {
    const errs = errorsOf(
      readView(`    read:
      mode: single
      shape: { fields: {} }
      absent:
        fields:
          bad: { kind: column, column: v, type: string }`),
    );
    expect(errs.some((e) => e.code === 'schema_violation')).toBe(true);
  });

  it('rejects a non-literal const value (nested object smuggling)', () => {
    const errs = errorsOf(
      readView(`    read:
      mode: collect
      shape:
        fields:
          x: { kind: const, value: { nested: { deep: true } } }`),
    );
    expect(errs.some((e) => e.code === 'schema_violation')).toBe(true);
  });
});

describe('param laws (full coverage — an interpreted view validates EVERY input)', () => {
  it('REJECTS an undeclared route path param when read is present', () => {
    const errs = lintErrors({
      params: {},
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'collect', shape: { fields: {} } },
    });
    expect(errs.some((e) => e.code === 'invalid_view' && e.message.includes("'{pid}'"))).toBe(true);
  });

  it('REJECTS a declared path param that is not in the route path', () => {
    const errs = lintErrors({
      params: {
        pid: { in: 'path', shape: 'safe_id' },
        ghost: { in: 'path', shape: 'safe_id' },
      },
    });
    expect(errs.some((e) => e.path === 'views[0].params.ghost')).toBe(true);
  });

  it('REJECTS an optional path param', () => {
    const errs = lintErrors({
      params: { pid: { in: 'path', shape: 'safe_id', required: false } },
    });
    expect(errs.some((e) => e.path === 'views[0].params.pid.required')).toBe(true);
  });

  it('REJECTS a param colliding with a pagination param', () => {
    const errs = lintErrors({
      params: {
        pid: { in: 'path', shape: 'safe_id' },
        limit: { in: 'query', shape: 'positive_int' },
      },
      source: { kind: 'store', ref: 'things_store' },
      read: {
        mode: 'list',
        shape: { fields: { items: FIELD_INSTANCES.page_items } },
      },
      pagination: { limit_param: 'limit', offset_param: 'offset', max_limit: 10 },
    });
    expect(errs.some((e) => e.path === 'views[0].params.limit')).toBe(true);
  });

  it('REJECTS an undeclared param ref in filter, shape, sub-read match, and absent (every position)', () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      absent_state: 'empty_200',
      read: {
        mode: 'single',
        filter: { a_col: { param: 'nope_filter' } },
        shape: {
          fields: {
            echo: { kind: 'param', param: 'nope_shape' },
            look: {
              kind: 'lookup',
              source: { store: 'child_store', match: { k: { param: 'nope_match' } } },
              field: { column: 'v' },
              type: 'string',
            },
          },
        },
        absent: { fields: { echo: { kind: 'param', param: 'nope_absent' } } },
      },
    });
    for (const name of ['nope_filter', 'nope_shape', 'nope_match', 'nope_absent']) {
      expect(errs.some((e) => e.code === 'invalid_view' && e.message.includes(`'${name}'`))).toBe(
        true,
      );
    }
  });
});

describe('pagination + absent-state laws', () => {
  it('REJECTS a list view without bounded pagination', () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'list', shape: { fields: { items: FIELD_INSTANCES.page_items } } },
    });
    expect(errs.some((e) => e.path === 'views[0].pagination')).toBe(true);
  });

  it('REJECTS default_limit > max_limit', () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'list', shape: { fields: { items: FIELD_INSTANCES.page_items } } },
      pagination: {
        limit_param: 'limit',
        offset_param: 'offset',
        max_limit: 10,
        default_limit: 50,
      },
    });
    expect(errs.some((e) => e.path === 'views[0].pagination.default_limit')).toBe(true);
  });

  it('REJECTS pagination on a non-list read', () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'collect', shape: { fields: {} } },
      pagination: { limit_param: 'limit', offset_param: 'offset', max_limit: 10 },
    });
    expect(errs.some((e) => e.path === 'views[0].pagination')).toBe(true);
  });

  it('REJECTS a list envelope with zero page_items and with two page_items', () => {
    const zero = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'list', shape: { fields: {} } },
      pagination: { limit_param: 'limit', offset_param: 'offset', max_limit: 10 },
    });
    expect(zero.some((e) => e.message.includes('exactly one page_items'))).toBe(true);
    const two = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: {
        mode: 'list',
        shape: { fields: { a: FIELD_INSTANCES.page_items, b: FIELD_INSTANCES.page_items } },
      },
      pagination: { limit_param: 'limit', offset_param: 'offset', max_limit: 10 },
    });
    expect(two.some((e) => e.message.includes('exactly one page_items'))).toBe(true);
  });

  it('REJECTS a single view without absent_state; empty_200 without absent; not_ready_409 WITH absent', () => {
    const noState = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'single', shape: { fields: {} } },
    });
    expect(noState.some((e) => e.path === 'views[0].absent_state')).toBe(true);

    const noAbsent = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      absent_state: 'empty_200',
      read: { mode: 'single', shape: { fields: {} } },
    });
    expect(noAbsent.some((e) => e.path === 'views[0].read.absent')).toBe(true);

    const both = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      absent_state: 'not_ready_409',
      read: { mode: 'single', shape: { fields: {} }, absent: { fields: {} } },
    });
    expect(both.some((e) => e.path === 'views[0].read.absent')).toBe(true);
  });

  it('REJECTS not_ready_409 and read.absent on list/collect reads', () => {
    for (const mode of ['list', 'collect'] as const) {
      const errs = lintErrors({
        source: { kind: 'store', ref: 'things_store' },
        absent_state: 'not_ready_409',
        read: {
          mode,
          shape:
            mode === 'list' ? { fields: { items: FIELD_INSTANCES.page_items } } : { fields: {} },
          absent: { fields: {} },
        },
        ...(mode === 'list'
          ? { pagination: { limit_param: 'limit', offset_param: 'offset', max_limit: 10 } }
          : {}),
      });
      expect(errs.some((e) => e.path === 'views[0].absent_state')).toBe(true);
      expect(errs.some((e) => e.path === 'views[0].read.absent')).toBe(true);
    }
  });
});

describe('group / counts / sub-read laws', () => {
  it('REJECTS a group with BOTH value and shape, and with NEITHER', () => {
    const both = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: {
        mode: 'collect',
        shape: {
          fields: {
            g: {
              kind: 'group',
              column: 'k',
              equals: 'a',
              mode: 'first',
              value: { column: 'payload', type: 'object' },
              shape: { fields: {} },
            },
          },
        },
      },
    });
    expect(both.some((e) => e.message.includes('exactly ONE of value|shape'))).toBe(true);
    const neither = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: {
        mode: 'collect',
        shape: { fields: { g: { kind: 'group', column: 'k', equals: 'a', mode: 'first' } } },
      },
    });
    expect(neither.some((e) => e.message.includes('exactly ONE of value|shape'))).toBe(true);
  });

  it("REJECTS a list-mode group with an 'absent' literal", () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: {
        mode: 'collect',
        shape: {
          fields: {
            g: {
              kind: 'group',
              column: 'k',
              equals: 'a',
              mode: 'list',
              value: { column: 'payload', type: 'object' },
              absent: null,
            },
          },
        },
      },
    });
    expect(errs.some((e) => e.message.includes("mode 'list'"))).toBe(true);
  });

  it('REJECTS self-counts (no of) outside a collect top level', () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      absent_state: 'empty_200',
      read: {
        mode: 'single',
        shape: {
          fields: {
            c: { kind: 'counts', by: 'k', buckets: ['a'], total: 'all_rows' },
          },
        },
        absent: { fields: {} },
      },
    });
    expect(errs.some((e) => e.message.includes("no 'of' sub-read"))).toBe(true);
  });

  it("FCY-3: REJECTS a counts bucket literally named 'total' (it would double-count into the grand-total key)", () => {
    // Red-first: the tally hardcodes the grand total under `total` — a bucket of the same name is
    // silently double-counted (interpret.ts tallyCounts). Reserve the name at lint time.
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: {
        mode: 'collect',
        shape: {
          fields: { c: { kind: 'counts', by: 'k', buckets: ['total'], total: 'all_rows' } },
        },
      },
    });
    expect(
      errs.some((e) => e.code === 'invalid_view' && e.message.includes("bucket 'total'")),
    ).toBe(true);
  });

  it('REJECTS an EMPTY sub-read match (would read the whole tenant table per parent row)', () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      absent_state: 'empty_200',
      read: {
        mode: 'single',
        shape: {
          fields: {
            look: {
              kind: 'lookup',
              source: { store: 'child_store', match: {} },
              field: { column: 'v' },
              type: 'string',
            },
          },
        },
        absent: { fields: {} },
      },
    });
    expect(errs.some((e) => e.message.includes('EMPTY match'))).toBe(true);
  });
});

describe('read/source pairing + conditional_read', () => {
  it('REJECTS read without a source', () => {
    const errs = lintErrors({ read: { mode: 'collect', shape: { fields: {} } } });
    expect(errs.some((e) => e.message.includes('no source'))).toBe(true);
  });

  it('REJECTS read on a capability source (delegated, never interpreted)', () => {
    const errs = lintErrors({
      source: { kind: 'capability', ref: 'cap_a.thing' },
      read: { mode: 'collect', shape: { fields: {} } },
    });
    expect(errs.some((e) => e.message.includes('capability source'))).toBe(true);
  });

  it('REJECTS conditional_read on a POST view', () => {
    const errs = lintErrors({
      route: { method: 'POST', path: '/things/{pid}' },
      conditional_read: 'etag',
    });
    expect(errs.some((e) => e.path === 'views[0].conditional_read')).toBe(true);
  });

  it('REJECTS a read view whose response_contract is not a top-level product contract', () => {
    const errs = lintErrors({
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'collect', shape: { fields: {} } },
      response_contract: 'cap_a.thing',
    });
    expect(errs.some((e) => e.path === 'views[0].response_contract')).toBe(true);
  });
});

describe('reserved names — EVERY name position × the WHOLE reserved set (code-built, mount-facing)', () => {
  it('rejects each reserved name as shape field, param, filter column, match column, bucket, absent field', () => {
    for (const bad of VIEW_RESERVED_NAMES) {
      const positions: Array<[string, Partial<ProductViewSpec>]> = [
        [
          'shape field',
          {
            source: { kind: 'store', ref: 's' },
            read: { mode: 'collect', shape: { fields: { [bad]: { kind: 'const', value: 1 } } } },
          },
        ],
        [
          'param name',
          {
            params: {
              pid: { in: 'path', shape: 'safe_id' },
              [bad]: { in: 'query', shape: 'string' },
            },
          },
        ],
        [
          'filter column',
          {
            source: { kind: 'store', ref: 's' },
            read: { mode: 'collect', filter: { [bad]: { const: 1 } }, shape: { fields: {} } },
          },
        ],
        [
          'match column',
          {
            source: { kind: 'store', ref: 's' },
            absent_state: 'empty_200',
            read: {
              mode: 'single',
              shape: {
                fields: {
                  l: {
                    kind: 'lookup',
                    source: { store: 'c', match: { [bad]: { const: 1 } } },
                    field: { column: 'v' },
                    type: 'string',
                  },
                },
              },
              absent: { fields: {} },
            },
          },
        ],
        [
          'counts bucket',
          {
            source: { kind: 'store', ref: 's' },
            read: {
              mode: 'collect',
              shape: {
                fields: { c: { kind: 'counts', by: 'k', buckets: [bad], total: 'all_rows' } },
              },
            },
          },
        ],
        [
          'absent field',
          {
            source: { kind: 'store', ref: 's' },
            absent_state: 'empty_200',
            read: {
              mode: 'single',
              shape: { fields: {} },
              absent: { fields: { [bad]: { kind: 'const', value: 1 } } },
            },
          },
        ],
        // TH-2: the 7th name position — an ITEMS-shape field (checkItemShape). Previously untested,
        // so a regression there would have passed the loop silently.
        [
          'item-shape field',
          {
            source: { kind: 'store', ref: 's' },
            absent_state: 'empty_200',
            read: {
              mode: 'single',
              shape: {
                fields: {
                  xs: {
                    kind: 'items',
                    column: 'payload',
                    path: ['xs'],
                    shape: { fields: { [bad]: { kind: 'const', value: 1 } } },
                  },
                },
              },
              absent: { fields: {} },
            },
          },
        ],
      ];
      for (const [label, view] of positions) {
        const errs = lintErrors(view);
        expect(
          errs.some((e) => e.code === 'invalid_view' && e.message.includes('reserved')),
          `expected reserved-name rejection for '${bad}' as ${label}`,
        ).toBe(true);
      }
    }
  });
});

describe('response-contract CONFORMANCE (the DTO half of the separation)', () => {
  const closedContract = {
    closed_response: {
      type: 'object',
      additional_properties: false,
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['name', 'count'],
    },
  };

  function conformErrors(
    shapeFields: Record<string, ViewField>,
    absentFields?: Record<string, ViewField>,
  ) {
    return lintProductViews({
      views: [
        {
          id: 'v',
          route: { method: 'GET', path: '/things/{pid}' },
          auth: 'bearer_tenant',
          params: { pid: { in: 'path', shape: 'safe_id' } },
          source: { kind: 'store', ref: 'things_store' },
          absent_state: 'empty_200',
          read: {
            mode: 'single',
            shape: { fields: shapeFields },
            absent: {
              fields:
                absentFields ??
                ({
                  name: { kind: 'const', value: 'none' },
                  count: { kind: 'const', value: 0 },
                } as never),
            },
          },
          response_contract: 'closed_response',
        } as ProductViewSpec,
      ],
      contracts: closedContract,
      artifacts: [],
      capabilities: [],
    });
  }

  const validFields: Record<string, ViewField> = {
    name: { kind: 'column', column: 'name', type: 'string', default: '' },
    count: { kind: 'column', column: 'count', type: 'integer', default: 0 },
  };

  it('ACCEPTS a conforming shape', () => {
    expect(conformErrors(validFields)).toEqual([]);
  });

  it('REJECTS projecting a field the closed contract does not declare', () => {
    const errs = conformErrors({ ...validFields, ghost: { kind: 'const', value: 1 } });
    expect(errs.some((e) => e.message.includes("'ghost'"))).toBe(true);
  });

  it('REJECTS a shape missing a required contract property', () => {
    const { count: _dropped, ...partial } = validFields;
    const errs = conformErrors(partial);
    expect(errs.some((e) => e.message.includes("requires property 'count'"))).toBe(true);
  });

  it('REJECTS a leaf type the contract property does not admit', () => {
    const errs = conformErrors({
      ...validFields,
      name: { kind: 'column', column: 'name', type: 'boolean', default: false },
    });
    expect(errs.some((e) => e.message.includes('not admitted'))).toBe(true);
  });

  it('REJECTS a null-defaulting leaf against a non-nullable property', () => {
    const errs = conformErrors({
      ...validFields,
      name: { kind: 'column', column: 'name', type: 'string' }, // default omitted ⇒ null
    });
    expect(errs.some((e) => e.message.includes("does not admit 'null'"))).toBe(true);
  });

  it('REJECTS an absent shape missing a required property', () => {
    const errs = conformErrors(validFields, {
      name: { kind: 'const', value: 'none' },
    } as never);
    expect(errs.some((e) => e.message.includes('absent shape'))).toBe(true);
  });

  it('SEP-2: a `{type: object, additional_properties: false}` node with NO properties is CLOSED-EMPTY — every projected field is rejected', () => {
    // Red-first: nodeProperties treated a propertyless additional_properties:false node as OPEN,
    // making the conformance pass a NO-OP on it. Such a node declares "no keys at all" — a projection
    // into it must FAIL, not silently conform.
    const errs = lintProductViews({
      views: [
        {
          id: 'v',
          route: { method: 'GET', path: '/things/{pid}' },
          auth: 'bearer_tenant',
          params: { pid: { in: 'path', shape: 'safe_id' } },
          source: { kind: 'store', ref: 'things_store' },
          read: {
            mode: 'collect',
            shape: { fields: { ghost: { kind: 'const', value: 1 } } },
          },
          response_contract: 'closed_empty',
        } as ProductViewSpec,
      ],
      contracts: { closed_empty: { type: 'object', additional_properties: false } },
      artifacts: [],
      capabilities: [],
    });
    expect(errs.some((e) => e.code === 'invalid_view' && e.message.includes("'ghost'"))).toBe(true);
  });

  it('SEP-2: a closed-empty ITEMS node rejects every projected item field (same law through conformItemShape)', () => {
    const errs = lintProductViews({
      views: [
        {
          id: 'v',
          route: { method: 'GET', path: '/things/{pid}' },
          auth: 'bearer_tenant',
          params: { pid: { in: 'path', shape: 'safe_id' } },
          source: { kind: 'store', ref: 'things_store' },
          absent_state: 'empty_200',
          read: {
            mode: 'single',
            shape: {
              fields: {
                xs: {
                  kind: 'items',
                  column: 'payload',
                  path: ['xs'],
                  shape: { fields: { ghost: { kind: 'const', value: 1 } } },
                },
              },
            },
            absent: { fields: {} },
          },
          response_contract: 'closed_items',
        } as ProductViewSpec,
      ],
      contracts: {
        closed_items: {
          type: 'object',
          properties: {
            xs: { type: 'array', items: { type: 'object', additional_properties: false } },
          },
        },
      },
      artifacts: [],
      capabilities: [],
    });
    expect(errs.some((e) => e.code === 'invalid_view' && e.message.includes("'ghost'"))).toBe(true);
  });
});

describe('viewPathParams', () => {
  it('extracts {param} names', () => {
    expect(viewPathParams('/sessions/{session_id}/{track}/transcript')).toEqual([
      'session_id',
      'track',
    ]);
    expect(viewPathParams('/sessions')).toEqual([]);
  });
});

describe('filter params must be required (the read is never ambiguous)', () => {
  it('REJECTS a read.filter referencing an OPTIONAL query param', () => {
    const errs = lintErrors({
      params: {
        pid: { in: 'path', shape: 'safe_id' },
        tag: { in: 'query', shape: 'string' }, // optional (required defaults false)
      },
      source: { kind: 'store', ref: 'things_store' },
      read: { mode: 'collect', filter: { tag_col: { param: 'tag' } }, shape: { fields: {} } },
    });
    expect(errs.some((e) => e.message.includes('OPTIONAL param'))).toBe(true);
  });

  it('ACCEPTS a read.filter referencing a REQUIRED query param or a path param', () => {
    const errs = lintErrors({
      params: {
        pid: { in: 'path', shape: 'safe_id' },
        tag: { in: 'query', shape: 'string', required: true },
      },
      source: { kind: 'store', ref: 'things_store' },
      read: {
        mode: 'collect',
        filter: { tag_col: { param: 'tag' }, pid_col: { param: 'pid' } },
        shape: { fields: {} },
      },
    });
    expect(errs.filter((e) => e.message.includes('OPTIONAL param'))).toEqual([]);
  });
});
