/**
 * Mount-time FAIL-CLOSED tests (the mount gate: every unknown/unsupported construct is REJECTED at
 * validate/mount time — never skipped). Each case injects exactly one defect into a known-good
 * mount config and asserts the compile/mount THROWS naming it. The set covers the WHOLE mount-only
 * check table: read-surface resolution (stores/columns), the injected-column allowlist,
 * column-type-awareness (json/items on non-jsonb, leaf-type vs column-type, filter coercibility),
 * artifact bindings, auth deny-by-default, unmountable declaration-only views, and missing
 * capability delegates.
 */
import type { ProductViewSpec, StoreSpec } from '@rayspec/spec';
import { describe, expect, it } from 'vitest';
import { compileProductViews, type ViewsCompileConfig } from './compile.js';
import { mountProductViews } from './mount.js';

const STORES: StoreSpec[] = [
  {
    name: 'things',
    columns: [
      { name: 'thing_id', type: 'text', nullable: false, unique: false },
      { name: 'label', type: 'text', nullable: false, unique: false },
      { name: 'count', type: 'integer', nullable: false, unique: false },
      { name: 'flag', type: 'boolean', nullable: false, unique: false },
      { name: 'payload', type: 'jsonb', nullable: true, unique: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'children',
    columns: [
      { name: 'thing_id', type: 'text', nullable: false, unique: false },
      { name: 'kind', type: 'text', nullable: false, unique: false },
      { name: 'payload', type: 'jsonb', nullable: true, unique: false },
    ],
    foreignKeys: [],
  },
];

const CONTRACTS = { open_response: { type: 'object' } };

/** A known-good single-row view (every defect case mutates a copy of this). */
function goodView(): ProductViewSpec {
  return {
    id: 'v',
    route: { method: 'GET', path: '/things/{thing_id}' },
    auth: 'bearer_tenant',
    params: { thing_id: { in: 'path', shape: 'safe_id' } },
    source: { kind: 'store', ref: 'things' },
    absent_state: 'empty_200',
    read: {
      mode: 'single',
      filter: { thing_id: { param: 'thing_id' } },
      shape: {
        fields: {
          label: { kind: 'column', column: 'label', type: 'string', default: '' },
        },
      },
      absent: { fields: { label: { kind: 'const', value: '' } } },
    },
    response_contract: 'open_response',
  } as ProductViewSpec;
}

function config(view: ProductViewSpec, extra?: Partial<ViewsCompileConfig>): ViewsCompileConfig {
  return { views: [view], contracts: CONTRACTS, stores: STORES, ...extra };
}

function compileError(view: ProductViewSpec, extra?: Partial<ViewsCompileConfig>): string {
  try {
    compileProductViews(config(view, extra));
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  throw new Error('expected compileProductViews to THROW (fail-closed) but it succeeded');
}

describe('the known-good base compiles (each defect case isolates ONE violation)', () => {
  it('compiles + mounts', () => {
    const compiled = compileProductViews(config(goodView()));
    expect(compiled.interpreted).toHaveLength(1);
    const mounted = mountProductViews(config(goodView()));
    expect(mounted.api).toEqual([
      { method: 'GET', path: '/things/{thing_id}', action: { kind: 'handler', handler: 'view_v' } },
    ]);
    expect(mounted.handlers.get('view_v')?.kind).toBe('route');
  });
});

describe('read-surface resolution (fail-closed)', () => {
  it('REJECTS an unknown backing store', () => {
    const v = goodView();
    (v.source as { ref: string }).ref = 'ghost_store';
    expect(compileError(v)).toContain("backing store 'ghost_store' is not in the read surface");
  });

  it('REJECTS an unknown filter column', () => {
    const v = goodView();
    (v.read as { filter: unknown }).filter = { ghost_col: { param: 'thing_id' } };
    expect(compileError(v)).toContain("unknown column 'ghost_col'");
  });

  it('REJECTS an unknown shape column', () => {
    const v = goodView();
    (v.read as { shape: unknown }).shape = {
      fields: { x: { kind: 'column', column: 'ghost', type: 'string' } },
    };
    expect(compileError(v)).toContain("unknown column 'ghost'");
  });

  it('REJECTS an unknown sub-read store and unknown match columns (child + parent)', () => {
    const v = goodView();
    (v.read as { shape: unknown }).shape = {
      fields: {
        kids: {
          kind: 'list',
          source: { store: 'ghost_children', match: { thing_id: { column: 'thing_id' } } },
          shape: { fields: {} },
        },
      },
    };
    expect(compileError(v)).toContain("unknown store 'ghost_children'");

    const v2 = goodView();
    (v2.read as { shape: unknown }).shape = {
      fields: {
        kids: {
          kind: 'list',
          source: { store: 'children', match: { ghost_child: { column: 'thing_id' } } },
          shape: { fields: {} },
        },
      },
    };
    expect(compileError(v2)).toContain("unknown column 'ghost_child'");

    const v3 = goodView();
    (v3.read as { shape: unknown }).shape = {
      fields: {
        kids: {
          kind: 'list',
          source: { store: 'children', match: { thing_id: { column: 'ghost_parent' } } },
          shape: { fields: {} },
        },
      },
    };
    expect(compileError(v3)).toContain("unknown column 'ghost_parent'");
  });

  it('REJECTS an artifact_query view without an artifact binding', () => {
    const v = goodView();
    v.source = { kind: 'artifact_query', ref: 'thing_notes' };
    const err = compileError(v, {
      artifacts: [{ kind: 'note', contract: 'open_response', collection: 'thing_notes' }],
    });
    expect(err).toContain('no artifact binding');
  });
});

describe('the injected-column allowlist (least exposure)', () => {
  it("ALLOWS 'id' and 'created_at'", () => {
    const v = goodView();
    (v.read as { shape: unknown }).shape = {
      fields: {
        id: { kind: 'column', column: 'id', type: 'string', default: '' },
        at: { kind: 'column', column: 'created_at', type: 'string' },
      },
    };
    expect(compileProductViews(config(v)).interpreted).toHaveLength(1);
  });

  it('REJECTS every forbidden injected column, in EVERY reference position', () => {
    for (const col of ['tenant_id', 'deleted_at', 'retention_days', 'region']) {
      // as a shape column
      const v = goodView();
      (v.read as { shape: unknown }).shape = {
        fields: { x: { kind: 'column', column: col, type: 'string' } },
      };
      expect(compileError(v)).toContain(`injected column '${col}'`);
      // as a filter column
      const v2 = goodView();
      (v2.read as { filter: unknown }).filter = { [col]: { const: 'x' } };
      expect(compileError(v2)).toContain(`injected column '${col}'`);
      // as an order_by column
      const v3 = goodView();
      (v3.read as { order_by: unknown }).order_by = [{ column: col }];
      expect(compileError(v3)).toContain(`injected column '${col}'`);
    }
  });
});

describe('column-type-awareness (never a blunt check)', () => {
  it('REJECTS a json path into a non-jsonb column', () => {
    const v = goodView();
    (v.read as { shape: unknown }).shape = {
      fields: { x: { kind: 'json', column: 'label', path: ['a'], type: 'string' } },
    };
    expect(compileError(v)).toContain('requires a jsonb column');
  });

  it('REJECTS items over a non-jsonb column', () => {
    const v = goodView();
    (v.read as { shape: unknown }).shape = {
      fields: {
        x: {
          kind: 'items',
          column: 'count',
          shape: { fields: { y: { kind: 'item', path: ['y'], type: 'string' } } },
        },
      },
    };
    expect(compileError(v)).toContain('requires a jsonb column');
  });

  it('REJECTS a leaf type the column cannot produce (and ACCEPTS what it can)', () => {
    const bad: Array<[string, string]> = [
      ['label', 'integer'], // text → string only
      ['count', 'string'], // integer → integer|number
      ['flag', 'string'], // boolean → boolean
      ['created_at', 'number'], // timestamp → string (ISO)
    ];
    for (const [column, type] of bad) {
      const v = goodView();
      (v.read as { shape: unknown }).shape = {
        fields: { x: { kind: 'column', column, type } },
      };
      expect(compileError(v)).toContain(`declares leaf type '${type}'`);
    }
    const ok = goodView();
    (ok.read as { shape: unknown }).shape = {
      fields: {
        a: { kind: 'column', column: 'count', type: 'number' }, // integer column → number is fine
        b: { kind: 'column', column: 'payload', type: 'array' }, // jsonb → anything
      },
    };
    expect(compileProductViews(config(ok)).interpreted).toHaveLength(1);
  });

  it('REJECTS a non-coercible param filter (string param on an integer/boolean column)', () => {
    const v = goodView();
    v.params = {
      thing_id: { in: 'path', shape: 'safe_id' },
      n: { in: 'query', shape: 'string', required: true },
    };
    (v.read as { filter: unknown }).filter = {
      thing_id: { param: 'thing_id' },
      count: { param: 'n' },
    };
    expect(compileError(v)).toContain('not coercible');
    // ... while an int-shaped param on an integer column is fine.
    const ok = goodView();
    ok.params = {
      thing_id: { in: 'path', shape: 'safe_id' },
      n: { in: 'query', shape: 'positive_int', required: true },
    };
    (ok.read as { filter: unknown }).filter = {
      thing_id: { param: 'thing_id' },
      count: { param: 'n' },
    };
    expect(compileProductViews(config(ok)).interpreted).toHaveLength(1);
  });

  it('REJECTS a type-mismatched or null const filter', () => {
    const v = goodView();
    (v.read as { filter: unknown }).filter = { count: { const: 'not-a-number' } };
    expect(compileError(v)).toContain('does not match the column');
    const v2 = goodView();
    (v2.read as { filter: unknown }).filter = { label: { const: null } };
    expect(compileError(v2)).toContain('null is never an equality filter');
  });
});

describe('auth + mountability (deny-by-default; nothing skipped)', () => {
  it('REJECTS a view without an auth policy', () => {
    const v = goodView();
    delete (v as { auth?: string }).auth;
    expect(compileError(v)).toContain('no auth policy declared');
  });

  it('REJECTS an unknown auth policy', () => {
    const v = goodView();
    (v as { auth: string }).auth = 'anonymous';
    expect(compileError(v)).toContain("unknown auth policy 'anonymous'");
  });

  it('TEN-2 (red-first): an ALLOWLISTED policy with NO mapped enforcement FAILS the compile — a recognized-but-unenforced policy is decorative', () => {
    const v = goodView();
    (v as { auth: string }).auth = 'mtls_tenant';
    const err = compileError(v, { authPolicies: new Set(['bearer_tenant', 'mtls_tenant']) });
    expect(err).toContain('no mapped enforcement');
  });

  it('TEN-2: a policy compiles when BOTH allowlisted AND enforcement-mapped', () => {
    const v = goodView();
    (v as { auth: string }).auth = 'mtls_tenant';
    const compiled = compileProductViews(
      config(v, {
        authPolicies: new Set(['bearer_tenant', 'mtls_tenant']),
        authPolicyEnforcement: new Map([
          ['bearer_tenant', 'platform_handler_chain'],
          ['mtls_tenant', 'platform_handler_chain'],
        ]),
      }),
    );
    expect(compiled.interpreted).toHaveLength(1);
  });

  it('REJECTS a declaration-only view (no read, no capability source) — never silently skipped', () => {
    const v = goodView();
    delete (v as { read?: unknown }).read;
    delete (v as { absent_state?: unknown }).absent_state;
    expect(compileError(v)).toContain('cannot be mounted');
  });

  it('REJECTS a capability view without a delegated handler (mount-level)', () => {
    const v: ProductViewSpec = {
      id: 'cap_view',
      route: { method: 'POST', path: '/things/{thing_id}/token' },
      auth: 'bearer_tenant',
      source: { kind: 'capability', ref: 'media.token' },
      response_contract: 'open_response',
    } as ProductViewSpec;
    expect(() =>
      mountProductViews({
        views: [v],
        contracts: CONTRACTS,
        stores: STORES,
        capabilities: [{ id: 'media', tier: 'B', status: 'reserved', contracts: ['media.token'] }],
      }),
    ).toThrow(/no delegated handler/);
  });

  it('MOUNTS a capability view through its injected delegate', () => {
    const v: ProductViewSpec = {
      id: 'cap_view',
      route: { method: 'POST', path: '/things/{thing_id}/token' },
      auth: 'bearer_tenant',
      source: { kind: 'capability', ref: 'media.token' },
      response_contract: 'open_response',
    } as ProductViewSpec;
    const delegate = { kind: 'route' as const, fn: async () => ({ ok: true }) };
    const mounted = mountProductViews({
      views: [v],
      contracts: CONTRACTS,
      stores: STORES,
      capabilities: [{ id: 'media', tier: 'B', status: 'reserved', contracts: ['media.token'] }],
      capabilityViewHandlers: new Map([['cap_view', delegate]]),
    });
    expect(mounted.handlers.get('view_cap_view')).toBe(delegate);
    expect(mounted.api[0]?.action).toEqual({ kind: 'handler', handler: 'view_cap_view' });
  });
});

describe('the parser lint runs INSIDE the mount (a code-built spec cannot bypass it)', () => {
  it('REJECTS the CL-BRIDGE-MINOR-1 conflation at mount time', () => {
    const v = goodView();
    v.source = { kind: 'artifact_query', ref: 'open_response' }; // = its response contract
    const err = compileError(v);
    expect(err).toContain('CL-BRIDGE-MINOR-1');
  });

  it('REJECTS an out-of-context field at mount time (context table enforced here too)', () => {
    const v = goodView();
    (v.read as { shape: unknown }).shape = {
      fields: {
        g: {
          kind: 'group',
          column: 'label',
          equals: 'a',
          mode: 'list',
          value: { column: 'payload', type: 'object' },
        },
      },
    };
    expect(compileError(v)).toContain("kind 'group' is not allowed");
  });

  it('REJECTS a reserved (__proto__-class) shape field name at mount time', () => {
    const v = goodView();
    (v.read as { shape: unknown }).shape = {
      fields: { ['__proto__']: { kind: 'const', value: 1 } },
    };
    expect(compileError(v)).toContain('reserved');
  });
});
