/**
 * NEGATIVE tests — each asserts a REAL rejection with the RIGHT
 * SpecError code. These are NOT blind: every case takes a spec that WOULD parse, injects exactly
 * one defect, and asserts (a) `ok:false` and (b) the specific closed `SpecErrorCode` is present.
 * A field-flip in the grammar (e.g. dropping `.strict()`, or a default on `idempotent`) BREAKS the
 * corresponding case.
 *
 * The base spec below is a known-good minimal-but-complete spec; each test builds a variant from it.
 */
import { describe, expect, it } from 'vitest';
import type { SpecErrorCode } from './errors.js';
import { parseSpec } from './parse.js';

/** A known-good base spec (every section present, all cross-refs resolve). */
const BASE = `
version: '1.0'
metadata:
  name: base
deployment:
  durableWorker: true
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
api:
  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }
agents:
  - id: helper
    name: helper
    backend: openai
    model: gpt-4o-mini
    instructions: do things
    tools: [echo]
tooling:
  - id: echo
    name: echo
    description: echo back
    parameters:
      type: object
      properties:
        msg: { type: string }
    handler: echo_handler
    idempotent: true
    timeoutMs: 1000
triggers:
  - name: nightly
    kind: cron
    schedule: '0 0 * * *'
    action: { kind: handler, handler: nightly_handler }
handlers:
  - { id: echo_handler, module: handlers/echo.ts, export: echo, kind: tool }
  - { id: nightly_handler, module: handlers/nightly.ts, export: nightly, kind: trigger }
`;

/** Assert the parse failed AND at least one error carries the expected closed code. */
function expectRejection(yaml: string, code: SpecErrorCode): void {
  const res = parseSpec(yaml);
  expect(res.ok).toBe(false);
  if (res.ok) return; // narrow
  const codes = res.errors.map((e) => e.code);
  expect(codes).toContain(code);
}

describe('the base spec is valid (sanity — so each negative case isolates ONE defect)', () => {
  it('parses ok', () => {
    const res = parseSpec(BASE);
    if (!res.ok) throw new Error(`base must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });
});

describe('negative — unsupported_version', () => {
  it('rejects an unknown major BEFORE the strict shape parse (clean single error)', () => {
    const yaml = BASE.replace("version: '1.0'", "version: '2.0'");
    const res = parseSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Two-phase: a bad version yields EXACTLY the version error, not a wall of strict errors.
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.code).toBe('unsupported_version');
  });

  it('rejects a missing version', () => {
    const yaml = BASE.replace("version: '1.0'\n", '');
    expectRejection(yaml, 'unsupported_version');
  });
});

describe('negative — yaml_parse_error', () => {
  it('rejects non-YAML text with a yaml_parse_error', () => {
    // An unterminated flow-map is a real YAML syntax error.
    expectRejection("version: '1.0'\nmetadata: { name: ", 'yaml_parse_error');
  });
});

describe('negative — unknown_field (strict, fail-closed)', () => {
  it('rejects an unknown TOP-LEVEL section', () => {
    const yaml = `${BASE}\nbogusSection: []\n`;
    expectRejection(yaml, 'unknown_field');
  });

  it('rejects a typoed field inside a store column', () => {
    // `typ` instead of `type` — strict rejects the unknown key (and `type` becomes missing).
    const yaml = BASE.replace('{ name: label, type: text }', '{ name: label, typ: text }');
    expectRejection(yaml, 'unknown_field');
  });

  it('rejects an unknown field on an agent', () => {
    const yaml = BASE.replace(
      '    backend: openai\n',
      '    backend: openai\n    temperature: 0.7\n',
    );
    expectRejection(yaml, 'unknown_field');
  });

  it('rejects an unknown field inside the deployment section (strict)', () => {
    // The deployment section is .strict(): a typo'd key is fail-closed-rejected (no silent passthrough).
    // BASE already has a deployment block (durableWorker:true for the cron); inject the bogus key INTO
    // it (appending a 2nd `deployment:` would be a YAML duplicate-key error, not the unknown_field we test).
    const yaml = BASE.replace(
      'deployment:\n  durableWorker: true\n',
      'deployment:\n  durableWorker: true\n  bogus: 1\n',
    );
    expectRejection(yaml, 'unknown_field');
  });
});

describe('negative — schema_violation', () => {
  it('rejects a column with a type outside the closed ColumnType enum', () => {
    const yaml = BASE.replace('{ name: label, type: text }', '{ name: label, type: blob }');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a tool MISSING the required idempotent field (no default — reviewed declaration)', () => {
    const yaml = BASE.replace('    idempotent: true\n', '');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a cron trigger missing its schedule (kind→field coherence)', () => {
    const yaml = BASE.replace("    schedule: '0 0 * * *'\n", '');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a cron trigger WITHOUT deployment.durableWorker:true (coupling)', () => {
    // BASE declares a cron AND deployment.durableWorker:true. Strip the durableWorker coupling: the
    // cron would be silently never scheduled, so the linter must reject it (fail-the-fix: keeping the
    // durableWorker line keeps BASE valid; removing it is the ONLY defect).
    const yaml = BASE.replace('deployment:\n  durableWorker: true\n', '');
    const res = parseSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const cronCoupling = res.errors.find(
      (e) => e.code === 'schema_violation' && /durableWorker/.test(e.message),
    );
    expect(cronCoupling).toBeDefined();
    expect(cronCoupling?.path).toMatch(/triggers\[\d+\]\.kind/);
  });
});

describe('negative — dangling_ref', () => {
  it('rejects a tool referencing an unknown handler', () => {
    const yaml = BASE.replace('handler: echo_handler', 'handler: nonexistent_handler');
    expectRejection(yaml, 'dangling_ref');
  });

  it('rejects an agent referencing an unknown tool', () => {
    const yaml = BASE.replace('tools: [echo]', 'tools: [does_not_exist]');
    expectRejection(yaml, 'dangling_ref');
  });

  it('rejects an api route referencing an unknown store', () => {
    const yaml = BASE.replace('store: widgets, op: list', 'store: gadgets, op: list');
    expectRejection(yaml, 'dangling_ref');
  });

  it('rejects a tool whose handler is the WRONG kind (route, not tool)', () => {
    // Point echo at the trigger-kind handler — a real wiring mistake.
    const yaml = BASE.replace('handler: echo_handler', 'handler: nightly_handler');
    expectRejection(yaml, 'dangling_ref');
  });

  it('rejects a store FK referencing an unknown store', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      '      - { name: label, type: text }\n      - { name: parent_id, type: uuid }\n    foreignKeys:\n      - { column: parent_id, references: ghosts }',
    );
    expectRejection(yaml, 'dangling_ref');
  });
});

describe('negative — duplicate_name', () => {
  it('rejects two stores with the same name', () => {
    const yaml = BASE.replace(
      'stores:\n  - name: widgets',
      'stores:\n  - name: widgets\n    columns:\n      - { name: x, type: text }\n  - name: widgets',
    );
    expectRejection(yaml, 'duplicate_name');
  });

  it('rejects two tools with the same id', () => {
    const yaml = BASE.replace(
      'tooling:\n  - id: echo',
      'tooling:\n  - id: echo\n    name: echo2\n    description: dup\n    parameters: { type: object }\n    handler: echo_handler\n    idempotent: true\n    timeoutMs: 1000\n  - id: echo',
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

describe('negative — capability_violation', () => {
  it('rejects an agent demanding NATIVE structured output on pi (which lacks it)', () => {
    // Self-contained so the one defect (native structured output demanded on pi) is unambiguous.
    const yaml = `
version: '1.0'
metadata:
  name: cap
agents:
  - id: structured
    name: structured
    backend: pi
    model: pi-model
    instructions: produce json
    requireNativeStructuredOutput: true
    outputSchema:
      name: result
      schema:
        type: object
`;
    // Sanity: the SAME spec on openai (which HAS native structured output) parses ok — proving the
    // rejection is the capability check firing, not an unrelated shape error.
    const okOnOpenai = parseSpec(yaml.replace('backend: pi', 'backend: openai'));
    expect(okOnOpenai.ok).toBe(true);
    expectRejection(yaml, 'capability_violation');
  });
});

describe('negative — invalid_embedded_schema', () => {
  it('rejects a tool whose parameters JSON-Schema is structurally malformed', () => {
    // `type: not-a-type` is not a valid JSON-Schema type — Ajv2020 compile throws at load.
    const yaml = BASE.replace(
      'parameters:\n      type: object\n      properties:\n        msg: { type: string }',
      'parameters:\n      type: not-a-type',
    );
    expectRejection(yaml, 'invalid_embedded_schema');
  });

  it('rejects a tool whose outputSchema JSON-Schema is malformed', () => {
    const yaml = BASE.replace(
      '    idempotent: true\n',
      '    outputSchema:\n      type: object\n      required: notanarray\n    idempotent: true\n',
    );
    expectRejection(yaml, 'invalid_embedded_schema');
  });

  it('rejects an agent whose outputSchema.schema JSON-Schema is malformed (fix #3)', () => {
    const yaml = `
version: '1.0'
metadata:
  name: badagentschema
agents:
  - id: a
    name: a
    backend: openai
    model: m
    instructions: i
    outputSchema:
      name: result
      schema:
        type: not-a-type
`;
    expectRejection(yaml, 'invalid_embedded_schema');
  });
});

describe('negative — agent outputSchema is fail-closed (fix #1, core OutputSchemaSpec .strict())', () => {
  it('rejects a typo/extra sibling key inside agents[].outputSchema', () => {
    // `schemaa` (typo of schema) is a stray sibling — strict OutputSchemaSpec must reject it,
    // not silently drop it. Without core .strict() this would parse ok (the headline finding).
    const yaml = `
version: '1.0'
metadata:
  name: strictoutput
agents:
  - id: a
    name: a
    backend: openai
    model: m
    instructions: i
    outputSchema:
      name: result
      schema:
        type: object
      schemaa: oops
`;
    expectRejection(yaml, 'unknown_field');
  });
});

describe('negative — tool parameters must be an object schema (fix #7)', () => {
  it('rejects a tool whose parameters is a (compilable) non-object schema', () => {
    // type:'string' compiles fine as JSON-Schema but is invalid as model-facing tool args.
    const yaml = BASE.replace(
      'parameters:\n      type: object\n      properties:\n        msg: { type: string }',
      'parameters:\n      type: string',
    );
    expectRejection(yaml, 'schema_violation');
  });
});

describe('negative — duplicate tool NAME (fix #5; dispatchTool keys on name)', () => {
  it('rejects two tools with distinct ids but the SAME name', () => {
    const yaml = BASE.replace(
      'tooling:\n  - id: echo',
      'tooling:\n  - id: echo2\n    name: echo\n    description: dup-name\n    parameters: { type: object }\n    handler: echo_handler\n    idempotent: true\n    timeoutMs: 1000\n  - id: echo',
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

describe('negative — duplicate api route (fix #4)', () => {
  it('rejects two routes with the same method + path', () => {
    const yaml = BASE.replace(
      "api:\n  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }",
      "api:\n  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }\n  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }",
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

describe('negative — duplicate column name within a store (fix #6)', () => {
  it('rejects two columns with the same name', () => {
    const yaml = BASE.replace(
      '    columns:\n      - { name: label, type: text }',
      '    columns:\n      - { name: label, type: text }\n      - { name: label, type: text }',
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

describe('negative — reserved column name (fix #9)', () => {
  it('rejects a business column named tenant_id (an injected tenancy column)', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      '      - { name: label, type: text }\n      - { name: tenant_id, type: uuid }',
    );
    expectRejection(yaml, 'reserved_column_name');
  });

  it('rejects a business column named id', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      '      - { name: label, type: text }\n      - { name: id, type: uuid }',
    );
    expectRejection(yaml, 'reserved_column_name');
  });
});

describe('negative — reserved list-query control keyword as a column name', () => {
  // A business column named `order`/`after`/`limit` collides with the declarative list route's control
  // query keys — it would be silently un-equality-filterable AND emit a DUPLICATE OpenAPI query param
  // (control param + per-column filter param, same name+location) → an invalid OpenAPI 3.1 doc.
  // Fail-the-fix: without the RESERVED_QUERY_KEYWORDS check the spec parses+lints CLEAN (the keyword is a
  // valid safe-identifier), so each rejection below goes RED.
  for (const kw of ['order', 'after', 'limit'] as const) {
    it(`rejects a business column named '${kw}'`, () => {
      const yaml = BASE.replace(
        '      - { name: label, type: text }',
        `      - { name: label, type: text }\n      - { name: ${kw}, type: text }`,
      );
      expectRejection(yaml, 'reserved_query_keyword');
    });
  }

  it('a column named `ordering` (a non-keyword) is NOT rejected — the check is exact, not substring', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      '      - { name: label, type: text }\n      - { name: ordering, type: text }',
    );
    const res = parseSpec(yaml);
    // No reserved_query_keyword for a merely keyword-adjacent name (exact-match set, not substring).
    if (!res.ok) {
      expect(res.errors.map((e) => e.code)).not.toContain('reserved_query_keyword');
    } else {
      expect(res.ok).toBe(true);
    }
  });
});

describe('negative — FK onDelete set null on a NOT NULL column (fix #8)', () => {
  it('rejects set-null on a non-nullable FK column', () => {
    const yaml = `
version: '1.0'
metadata:
  name: fknull
stores:
  - name: parents
    columns:
      - { name: label, type: text }
  - name: children
    columns:
      - { name: parent_id, type: uuid }
    foreignKeys:
      - { column: parent_id, references: parents, onDelete: 'set null' }
`;
    // Sanity: the SAME store with a NULLABLE FK column parses ok — isolating the coherence check.
    const ok = parseSpec(
      yaml.replace(
        '{ name: parent_id, type: uuid }',
        '{ name: parent_id, type: uuid, nullable: true }',
      ),
    );
    expect(ok.ok).toBe(true);
    expectRejection(yaml, 'schema_violation');
  });
});

describe('negative — unquoted numeric version (fix #10; helpful diagnostic, no coercion)', () => {
  it('rejects YAML `version: 1.0` (the number) with a quote-it hint, NOT a coercion', () => {
    const yaml = 'version: 1.0\nmetadata:\n  name: numericversion\n';
    const res = parseSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.code).toBe('unsupported_version');
    // The message names the YAML number + tells the author to quote it (not a misleading "'1.0'").
    expect(res.errors[0]?.message).toMatch(/quoted string/i);
    expect(res.errors[0]?.message).toMatch(/number/i);
  });
});

// ---- fix #12: untested correct branches (each a regression tripwire) ------------------------
describe('negative — previously-untested lint branches (fix #12)', () => {
  it('FK references a declared store but an UNDECLARED column → dangling_ref', () => {
    const yaml = `
version: '1.0'
metadata:
  name: fkcol
stores:
  - name: parents
    columns:
      - { name: label, type: text }
  - name: children
    columns:
      - { name: label, type: text }
    foreignKeys:
      - { column: ghost_col, references: parents }
`;
    expectRejection(yaml, 'dangling_ref');
  });

  it('api {handler} action pointing at a TOOL-kind handler → dangling_ref', () => {
    const yaml = BASE.replace(
      "  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }",
      "  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }\n  - { method: POST, path: '/x', action: { kind: handler, handler: echo_handler } }",
    );
    // echo_handler is kind:'tool' — wrong kind for an api route handler.
    expectRejection(yaml, 'dangling_ref');
  });

  it('trigger {agent} action pointing at an unknown agent → dangling_ref', () => {
    const yaml = BASE.replace(
      'action: { kind: handler, handler: nightly_handler }',
      'action: { kind: agent, agent: ghost_agent }',
    );
    expectRejection(yaml, 'dangling_ref');
  });

  it('trigger {handler} action pointing at a TOOL-kind handler → dangling_ref', () => {
    const yaml = BASE.replace(
      'action: { kind: handler, handler: nightly_handler }',
      'action: { kind: handler, handler: echo_handler }',
    );
    // echo_handler is kind:'tool' — wrong kind for a trigger handler.
    expectRejection(yaml, 'dangling_ref');
  });

  it('event-kind trigger missing its event → schema_violation', () => {
    const yaml = BASE.replace("    kind: cron\n    schedule: '0 0 * * *'", '    kind: event');
    expectRejection(yaml, 'schema_violation');
  });

  it('duplicate handler id → duplicate_name', () => {
    const yaml = BASE.replace(
      '  - { id: echo_handler, module: handlers/echo.ts, export: echo, kind: tool }',
      '  - { id: echo_handler, module: handlers/echo.ts, export: echo, kind: tool }\n  - { id: echo_handler, module: handlers/echo2.ts, export: echo2, kind: tool }',
    );
    expectRejection(yaml, 'duplicate_name');
  });

  it('duplicate trigger name → duplicate_name', () => {
    const yaml = BASE.replace(
      'triggers:\n  - name: nightly',
      "triggers:\n  - name: nightly\n    kind: cron\n    schedule: '0 1 * * *'\n    action: { kind: handler, handler: nightly_handler }\n  - name: nightly",
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

// ---------------------------------------------------------------------------------------
// Identifier-injection, FK-uuid, and camelCase-collision checks. Each takes the valid BASE and
// injects exactly one defect.
// ---------------------------------------------------------------------------------------

describe('negative — TEN-1 identifier injection (safe-identifier shape, schema_violation)', () => {
  it('rejects a store NAME with a SQL metacharacter (quote/semicolon)', () => {
    // The exact injection from the review: a store name that would inject DDL if interpolated.
    const evil = 'm" ); ALTER TABLE orgs DISABLE ROW LEVEL SECURITY; CREATE TABLE "m2';
    const yaml = BASE.replace('  - name: widgets', `  - name: ${JSON.stringify(evil)}`);
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a store name with a space', () => {
    const yaml = BASE.replace('  - name: widgets', '  - name: "my table"');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a COLUMN name with a metacharacter', () => {
    const yaml = BASE.replace('{ name: label, type: text }', '{ name: "lab\'el", type: text }');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects an over-long identifier (> 63 chars, the Postgres limit)', () => {
    const long = 'a'.repeat(64);
    const yaml = BASE.replace('  - name: widgets', `  - name: ${long}`);
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects an uppercase identifier (we keep lowercase snake_case)', () => {
    const yaml = BASE.replace('  - name: widgets', '  - name: Widgets');
    expectRejection(yaml, 'schema_violation');
  });
});

describe('negative — GEN-1 FK local column must be uuid (schema_violation)', () => {
  // A store with a child FK column declared as text (not uuid) — diverges the generators.
  const FK_BASE = BASE.replace(
    'stores:\n  - name: widgets\n    columns:\n      - { name: label, type: text }',
    `stores:
  - name: widgets
    columns:
      - { name: label, type: text }
  - name: parts
    columns:
      - { name: widget_id, type: TYPE_PLACEHOLDER }
    foreignKeys:
      - { column: widget_id, references: widgets, onDelete: cascade }`,
  );

  it('rejects an FK column of type text', () => {
    expectRejection(FK_BASE.replace('TYPE_PLACEHOLDER', 'text'), 'schema_violation');
  });

  it('ACCEPTS the same FK column when it is uuid (the fix does not over-reject)', () => {
    const res = parseSpec(FK_BASE.replace('TYPE_PLACEHOLDER', 'uuid'));
    if (!res.ok) throw new Error(`uuid FK must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });
});

describe('negative — TEN-3 camelCase identifier collision (duplicate_name)', () => {
  // The lowercase-only safe-identifier rule already prevents the camelCase-vs-uppercase form
  // (an uppercase name is a schema_violation, asserted in the TEN-1 block). The collision that
  // SURVIVES the rule is `_<digit>` vanishing: `x_1` -> `x1` and `x1` -> `x1` BOTH camelCase to
  // `x1` (a duplicate const/object key in the generated TS). That is what this check catches.
  it('rejects two store COLUMNS that camelCase to the same JS identifier (x_1 / x1)', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      '      - { name: x_1, type: text }\n      - { name: x1, type: text }',
    );
    expectRejection(yaml, 'duplicate_name');
  });

  it('rejects two STORE names that camelCase to the same const identifier (t_1 / t1)', () => {
    const yaml = BASE.replace(
      'stores:\n  - name: widgets\n    columns:\n      - { name: label, type: text }',
      `stores:
  - name: t_1
    columns:
      - { name: label, type: text }
  - name: t1
    columns:
      - { name: note, type: text }`,
    ).replace('store: widgets', 'store: t_1');
    expectRejection(yaml, 'duplicate_name');
  });
});
