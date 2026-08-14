/**
 * The `__proto__` DOCUMENT-KEY refusal — the one key name a spec document may not carry.
 *
 * WHY A RAW-DOCUMENT PASS AND NOT A GRAMMAR RULE: no grammar rule can REPORT on this key. `yaml`
 * builds it as a genuine own enumerable property (`Object.defineProperty`, not assignment), and from
 * there zod does one of two things. Where the grammar READS the level — the strict-object
 * unrecognized-key walk, the generic record branch — it skips the key by name with no issue raised,
 * so the key is dropped and every rule downstream ran against a document the author did not write.
 * Where the level is a FREE-FORM `z.unknown()` slot, zod never descends into it, so the key is NOT
 * dropped: it survives the parse intact. Both halves are pinned below (`the shape parse, measured`),
 * because the refusal's justification is only honest if it describes both. These tests also pin the
 * refusal at both parse boundaries and what it does NOT touch — a `__proto__` VALUE stays legal.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { RESERVED_DOCUMENT_KEY } from './document-keys.js';
import type { SpecError } from './errors.js';
import { RaySpec } from './grammar.js';
import { parseSpec } from './parse.js';
import { ProductSpec } from './product-grammar.js';
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

  it('refuses a __proto__ key in a view `read.shape.fields` — a field name VIEW_RESERVED_NAMES could never reach', () => {
    // `VIEW_RESERVED_NAMES` (product-views.ts) denies `__proto__`/`constructor`/`prototype` as a
    // declared name, but for the positions it reads from MAPPING KEYS it is enforced over the
    // POST-shape-parse object, where the key no longer existed. This is the parse-boundary refusal
    // that makes the `__proto__` member reachable for a field name from a parsed document at all.
    // (A counts BUCKET is an array VALUE, so it reaches that lint unaided — pinned below.)
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

/**
 * THE SHAPE PARSE, MEASURED — the two behaviours the refusal's justification names.
 *
 * The error message, `docs/spec-reference.md` and the release record all say the same thing about
 * WHY this key is refused at the parse boundary: no grammar rule can report on it. That is one claim
 * with two halves, and they are opposites — where the grammar reads the level the key is DROPPED,
 * and inside a free-form `z.unknown()` slot it is KEPT. A justification that states only the first
 * half tells an author their working document was silently broken when it was in fact being served.
 * These tests run the shape parse directly (no parse-boundary scan) so both halves stay true, or go
 * red the moment zod's treatment of the name changes.
 */
describe('the shape parse, measured — what the grammar does with an own `__proto__` key', () => {
  /** A tool `parameters` JSON Schema whose `properties` map carries the key. */
  const toolingDoc = `
version: '1.0'
metadata:
  name: proto-key-backend
handlers:
  - { id: h, module: ./h.js, export: run, kind: tool }
tooling:
  - id: t
    handler: h
    idempotent: true
    timeoutMs: 1000
    name: t
    description: d
    parameters:
      type: object
      properties:
        __proto__: { type: string }
        ok: { type: string }
`;

  it('DROPS it where the grammar READS the level — a `.strict()` object raises no issue and loses the key', () => {
    const loaded = parseYaml("version: '1.0'\nmetadata:\n  name: n\n  __proto__: polluted\n");
    // Instrument check: the loader really produced an OWN key for the parse to act on.
    expect(Object.hasOwn((loaded as { metadata: object }).metadata, '__proto__')).toBe(true);

    const parsed = RaySpec.safeParse(loaded);
    // No `unrecognized_keys` issue — the strict walk skipped the name. Contrast: ACCEPT CONTROL.
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    expect(Object.hasOwn(parsed.data.metadata, '__proto__')).toBe(false);
  });

  it('ACCEPT CONTROL: the same strict object DOES reject an ordinary unknown key', () => {
    // Without this the test above would pass against a validator that rejects nothing at all.
    const parsed = RaySpec.safeParse(
      parseYaml("version: '1.0'\nmetadata:\n  name: n\n  bogus: 1\n"),
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
  });

  it('KEEPS it inside a free-form `z.unknown()` slot — the key survives the parse with its value', () => {
    const parsed = RaySpec.safeParse(parseYaml(toolingDoc));
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const props = (parsed.data.tooling[0] as unknown as { parameters: { properties: object } })
      .parameters.properties;
    // NOT dropped: an own key, its value intact, and it survives serialization to the wire.
    expect(Object.hasOwn(props, '__proto__')).toBe(true);
    expect(Object.keys(props)).toEqual(['__proto__', 'ok']);
    // Read through the descriptor, never `props.__proto__` — the dot form would consult the
    // prototype getter and prove nothing about an OWN key.
    expect(Object.getOwnPropertyDescriptor(props, '__proto__')?.value).toEqual({ type: 'string' });
    // And it is still there on the wire.
    expect(JSON.stringify(props)).toBe('{"__proto__":{"type":"string"},"ok":{"type":"string"}}');
  });

  it('KEEPS it inside a product `contracts` body — the same free-form slot on the other profile', () => {
    const parsed = ProductSpec.safeParse(
      parseYaml(
        "version: '1.0'\nproduct:\n  id: p\n  name: P\n" +
          'contracts:\n  c:\n    type: object\n    properties:\n' +
          '      __proto__: { type: string }\n      ok: { type: string }\n',
      ),
    );
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const props = (parsed.data.contracts.c as { properties: object }).properties;
    expect(Object.hasOwn(props, '__proto__')).toBe(true);
    expect(Object.keys(props)).toEqual(['__proto__', 'ok']);
  });

  it('the loader DEFINES the key rather than assigning it — no object is reparented at load', () => {
    // This is what makes the key an own property at all, and why loading such a document never
    // moved a prototype. The control shows what plain assignment would have done instead.
    const loaded = parseYaml('__proto__: { type: string }\n') as object;
    expect(Object.hasOwn(loaded, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(loaded)).toBe(Object.prototype);

    // The key is held in a variable so this stays a plain runtime assignment (a literal
    // `.__proto__` accessor is banned by lint, and the ban is the point being illustrated).
    const key = RESERVED_DOCUMENT_KEY;
    const assigned: Record<string, unknown> = {};
    assigned[key] = { type: 'string' };
    expect(Object.hasOwn(assigned, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(assigned)).not.toBe(Object.prototype);
  });

  it('a counts BUCKET named __proto__ is a VALUE — it reaches the view lint on a parsed document', () => {
    // The parse-boundary refusal is about KEYS, so this one is not refused there. It is the one
    // position where the `__proto__` member of VIEW_RESERVED_NAMES fires for a document an author
    // actually wrote — which is why the denylist member is not dead code.
    const doc = (bucket: string): string =>
      "version: '1.0'\nproduct:\n  id: p\n  name: P\n" +
      'stores:\n  - name: s\n    key: [k]\n    columns:\n      - { name: k, type: text }\n' +
      'contracts:\n  c.thing:\n    type: object\n' +
      'views:\n' +
      '  - id: v\n' +
      '    route: { method: GET, path: /things }\n' +
      '    auth: bearer_tenant\n' +
      '    source: { kind: store, ref: s }\n' +
      '    read:\n      mode: collect\n      shape:\n        fields:\n' +
      `          c: { kind: counts, by: k, buckets: [${bucket}], total: all_rows }\n` +
      '    response_contract: c.thing\n';

    // ACCEPT CONTROL: the same document with an ordinary bucket name parses.
    const control = parseProductSpec(doc('alpha'));
    expect(control.ok, `expected ok, got ${JSON.stringify(!control.ok && control.errors)}`).toBe(
      true,
    );

    expect(errorsOf(parseProductSpec(doc('__proto__')))).toEqual([
      {
        code: 'invalid_view',
        message: "view 'v' counts bucket '__proto__' is a reserved name",
        path: 'views[0].read.shape.fields.c',
      },
    ]);
  });
});
