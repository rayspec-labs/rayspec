/**
 * The `__proto__` DOCUMENT-KEY refusal — the one key name a spec document may not carry.
 *
 * WHY A RAW-DOCUMENT PASS AND NOT A GRAMMAR RULE: the shape parser cannot see this key. `yaml`
 * builds it as a genuine own enumerable property (`Object.defineProperty`, not assignment), and zod
 * then skips it BY NAME in both readers a spec document goes through — the strict-object
 * unrecognized-key walk and the generic record branch — with no issue raised. So a document
 * declaring it parsed clean, and every rule downstream ran against a document the author did not
 * write: the key was simply gone. These tests pin the refusal at both parse boundaries and, just as
 * importantly, pin what it does NOT touch — a `__proto__` VALUE (a column named that) stays legal.
 */
import { describe, expect, it } from 'vitest';
import type { SpecError } from './errors.js';
import { parseSpec } from './parse.js';
import { parseProductSpec } from './product-parse.js';

/** The errors of a failed parse (an unexpected success is a loud failure, never a silent skip). */
function errorsOf(res: { ok: true } | { ok: false; errors: SpecError[] }): SpecError[] {
  if (res.ok) throw new Error('expected the parse to FAIL, but it succeeded');
  return res.errors;
}

/** Assert exactly one `reserved_document_key` error, at `path`. */
function expectRefusedAt(res: ReturnType<typeof parseSpec>, path: string): SpecError {
  const hits = errorsOf(res).filter((e) => e.code === 'reserved_document_key');
  expect(
    hits,
    `expected one reserved_document_key in ${JSON.stringify(errorsOf(res))}`,
  ).toHaveLength(1);
  const hit = hits[0] as SpecError;
  expect(hit.path).toBe(path);
  return hit;
}

/** A backend document with one store + one list route; `project` and `extra` are the variants. */
function backendYaml(args: { project?: string; extra?: string }): string {
  const project = args.project ? `    project: ${args.project}\n` : '';
  return `
version: '1.0'
metadata:
  name: proto-key-backend
stores:
  - name: relics
    columns:
      - { name: ok_col, type: text }
api:
  - method: GET
    path: /relics
    action: { kind: store, store: relics, op: list }
${project}${args.extra ?? ''}`;
}

describe('reserved_document_key — the backend profile (parseSpec)', () => {
  it('ACCEPT CONTROL: the same document without the key parses', () => {
    const res = parseSpec(backendYaml({ project: '{ rename: { ok_col: okWire } }' }));
    expect(res.ok, `expected ok, got ${JSON.stringify(!res.ok && res.errors)}`).toBe(true);
  });

  it('refuses a `rename` key named __proto__ (the rename used to parse clean and do NOTHING)', () => {
    const hit = expectRefusedAt(
      parseSpec(backendYaml({ project: '{ rename: { __proto__: pwnedWire, ok_col: okWire } }' })),
      'api[0].project.rename.__proto__',
    );
    expect(hit.message).toContain('__proto__');
  });

  it('refuses a ROOT __proto__ key, which the strict root object silently admitted', () => {
    expectRefusedAt(
      parseSpec(backendYaml({ extra: '__proto__:\n  polluted: true\n' })),
      '__proto__',
    );
  });

  it('refuses a __proto__ key inside `metadata`', () => {
    expectRefusedAt(
      parseSpec(`
version: '1.0'
metadata:
  name: proto-key-backend
  __proto__: polluted
`),
      'metadata.__proto__',
    );
  });

  it('reports EVERY occurrence, not the first (the parser aggregates)', () => {
    const errors = errorsOf(
      parseSpec(
        backendYaml({
          project: '{ rename: { __proto__: pwnedWire } }',
          extra: '__proto__:\n  polluted: true\n',
        }),
      ),
    );
    expect(errors.every((e) => e.code === 'reserved_document_key')).toBe(true);
    expect(errors.map((e) => e.path).sort()).toEqual([
      '__proto__',
      'api[0].project.rename.__proto__',
    ]);
  });

  it('terminates on a self-referential YAML alias (the walk is cycle-guarded)', () => {
    // `yaml` resolves `*a` to the very node `&a` labels, so this document's object graph contains a
    // cycle — an unguarded recursive walk never returns. Measured: `parse('root: &a\\n  child: *a')`
    // yields `d.root.child === d.root`.
    const res = parseSpec(`
version: '1.0'
metadata:
  name: proto-key-backend
stores: &loop
  - name: relics
    columns:
      - { name: ok_col, type: text }
    __proto__: { self: *loop }
`);
    expectRefusedAt(res, 'stores[0].__proto__');
  });

  it('leaves a __proto__ VALUE alone — a column named __proto__ stays legal and lint-clean', () => {
    // The refusal is about a document KEY. `name: __proto__` is a value, and a store column of that
    // name is a SafeIdentifier-legal declaration the serializer/projection paths already handle.
    const res = parseSpec(`
version: '1.0'
metadata:
  name: proto-named-column
stores:
  - name: relics
    columns:
      - { name: wire_name, type: text }
      - { name: __proto__, type: text }
api:
  - method: GET
    path: /relics
    action: { kind: store, store: relics, op: list }
    project: { rename: { wire_name: wireName }, fields: [wireName, __proto__, id] }
`);
    expect(res.ok, `expected ok, got ${JSON.stringify(!res.ok && res.errors)}`).toBe(true);
  });

  it("leaves the other Object.prototype names alone — a 'constructor' rename key still parses", () => {
    // Only `__proto__` is skipped by name inside the shape parser; `constructor` is an ordinary own
    // key that survives it, so it needs no refusal and keeps working.
    const res = parseSpec(`
version: '1.0'
metadata:
  name: constructor-rename
stores:
  - name: relics
    columns:
      - { name: constructor, type: text }
api:
  - method: GET
    path: /relics
    action: { kind: store, store: relics, op: list }
    project: { rename: { constructor: builtBy } }
`);
    expect(res.ok, `expected ok, got ${JSON.stringify(!res.ok && res.errors)}`).toBe(true);
    if (!res.ok) return;
    expect(res.value.api[0]?.project?.rename).toEqual({ constructor: 'builtBy' });
  });
});

describe('reserved_document_key — the product profile (parseProductSpec)', () => {
  /** A minimal product document; `extra` appends sections. */
  const product = (extra: string): string =>
    `version: '1.0'\nproduct:\n  id: tiny\n  name: Tiny\n${extra}`;

  it('ACCEPT CONTROL: the minimal product document parses', () => {
    const res = parseProductSpec(product(''));
    expect(res.ok, `expected ok, got ${JSON.stringify(!res.ok && res.errors)}`).toBe(true);
  });

  it('refuses a __proto__ key in `product.metadata`', () => {
    expectRefusedAt(
      parseProductSpec(
        "version: '1.0'\nproduct:\n  id: tiny\n  name: Tiny\n  metadata:\n    __proto__: polluted\n",
      ),
      'product.metadata.__proto__',
    );
  });

  it('refuses a __proto__ key in `contracts`', () => {
    expectRefusedAt(
      parseProductSpec(product('contracts:\n  __proto__:\n    type: object\n')),
      'contracts.__proto__',
    );
  });

  it('refuses a __proto__ key in a store step `filter` and in `values`', () => {
    expectRefusedAt(
      parseProductSpec(
        product(
          'workflows:\n' +
            '  - id: w\n' +
            '    trigger: { capability: c, event: e }\n' +
            '    steps:\n' +
            '      - id: s\n' +
            '        type: store_read\n' +
            '        use: store.read\n' +
            '        store: things\n' +
            '        filter:\n' +
            '          __proto__: { const: pwned }\n',
        ),
      ),
      'workflows[0].steps[0].filter.__proto__',
    );
    expectRefusedAt(
      parseProductSpec(
        product(
          'workflows:\n' +
            '  - id: w\n' +
            '    trigger: { capability: c, event: e }\n' +
            '    steps:\n' +
            '      - id: s\n' +
            '        type: store_write\n' +
            '        use: store.write\n' +
            '        store: things\n' +
            '        values:\n' +
            '          __proto__: { const: pwned }\n',
        ),
      ),
      'workflows[0].steps[0].values.__proto__',
    );
  });

  it('refuses a __proto__ key in a view `read.shape.fields` — the name VIEW_RESERVED_NAMES could never reach', () => {
    // `VIEW_RESERVED_NAMES` (product-views.ts) denies `__proto__`/`constructor`/`prototype` as a
    // declared name, but it is enforced over the POST-shape-parse object, where the key no longer
    // existed. This is the parse-boundary refusal that makes the `__proto__` member of that
    // denylist reachable from a parsed document at all.
    expectRefusedAt(
      parseProductSpec(
        product(
          'views:\n' +
            '  - id: v\n' +
            '    route: { method: GET, path: /things }\n' +
            '    auth: bearer_tenant\n' +
            '    source: { kind: store, ref: things }\n' +
            '    read:\n' +
            '      mode: collect\n' +
            '      shape:\n' +
            '        fields:\n' +
            '          __proto__: { kind: const, value: 1 }\n' +
            '    response_contract: c.thing\n',
        ),
      ),
      'views[0].read.shape.fields.__proto__',
    );
  });

  it('refuses a __proto__ key in `views[].params`', () => {
    expectRefusedAt(
      parseProductSpec(
        product(
          'views:\n' +
            '  - id: v\n' +
            '    route: { method: GET, path: /things }\n' +
            '    auth: bearer_tenant\n' +
            '    params:\n' +
            '      __proto__: { in: query, shape: string }\n' +
            '    source: { kind: store, ref: things }\n' +
            '    read: { mode: collect, shape: { fields: {} } }\n' +
            '    response_contract: c.thing\n',
        ),
      ),
      'views[0].params.__proto__',
    );
  });

  it('refuses a ROOT __proto__ key on a product document too', () => {
    expectRefusedAt(parseProductSpec(product('__proto__:\n  polluted: true\n')), '__proto__');
  });

  it("leaves 'constructor' to the view lint, which still refuses it on a parsed document", () => {
    // The other half of the VIEW_RESERVED_NAMES story: `constructor` survives the shape parse as an
    // ordinary key, so it reaches `lintProductViews` and is refused there — no parse-boundary
    // refusal needed, and none added.
    const res = parseProductSpec(
      product(
        'contracts:\n  c.thing:\n    type: object\n' +
          'stores:\n  - name: things\n    columns:\n      - { name: ref, type: text }\n    key: [ref]\n' +
          'views:\n' +
          '  - id: v\n' +
          '    route: { method: GET, path: /things }\n' +
          '    auth: bearer_tenant\n' +
          '    source: { kind: store, ref: things }\n' +
          '    read:\n' +
          '      mode: collect\n' +
          '      shape:\n' +
          '        fields:\n' +
          '          constructor: { kind: const, value: 1 }\n' +
          '    response_contract: c.thing\n',
      ),
    );
    expect(errorsOf(res)).toEqual([
      {
        code: 'invalid_view',
        message: "view 'v' shape uses reserved field name 'constructor'",
        path: 'views[0].read.shape.fields.constructor',
      },
    ]);
  });
});
