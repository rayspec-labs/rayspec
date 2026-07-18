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

describe('negative — fk_cycle', () => {
  it('rejects a circular foreign-key reference (A→B, B→A) as unorderable', () => {
    const yaml = `
version: '1.0'
metadata:
  name: cyc
stores:
  - name: alpha
    columns:
      - { name: beta_id, type: uuid }
    foreignKeys:
      - { column: beta_id, references: beta, onDelete: cascade }
  - name: beta
    columns:
      - { name: alpha_id, type: uuid }
    foreignKeys:
      - { column: alpha_id, references: alpha, onDelete: cascade }
`;
    expectRejection(yaml, 'fk_cycle');
  });

  it('a SELF-referencing FK is NOT a cycle (it applies after the table CREATE) — parses ok', () => {
    const yaml = `
version: '1.0'
metadata:
  name: self
stores:
  - name: nodes
    columns:
      - { name: parent_id, type: uuid, nullable: true }
    foreignKeys:
      - { column: parent_id, references: nodes, onDelete: 'set null' }
`;
    const res = parseSpec(yaml);
    if (!res.ok) throw new Error(`self-FK must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
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

  it('rejects a manual trigger WITHOUT deployment.durableWorker:true (coupling)', () => {
    // Swap BASE's cron trigger for a MANUAL one (still WITH durableWorker → valid), then strip the
    // durableWorker coupling. A manual trigger is fired ON DEMAND through the durable off-request
    // worker, so without it the trigger could never dispatch — the linter must reject it (fail-the-fix:
    // the manual variant WITH durableWorker stays valid; removing durableWorker is the ONLY defect).
    const manualBase = BASE.replace(
      "    kind: cron\n    schedule: '0 0 * * *'\n    action: { kind: handler, handler: nightly_handler }",
      '    kind: manual\n    action: { kind: handler, handler: nightly_handler }',
    );
    // sanity: the manual variant WITH durableWorker parses (so the coupling below is the ONLY defect).
    expect(parseSpec(manualBase).ok).toBe(true);
    const yaml = manualBase.replace('deployment:\n  durableWorker: true\n', '');
    const res = parseSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const manualCoupling = res.errors.find(
      (e) => e.code === 'schema_violation' && /manual trigger.*durableWorker/.test(e.message),
    );
    expect(manualCoupling).toBeDefined();
    expect(manualCoupling?.path).toMatch(/triggers\[\d+\]\.kind/);
  });

  it("rejects 'catchUp' declared on a NON-cron trigger (catchUp is cron-only, fail-closed)", () => {
    // LINT TOOTH (fail-the-fix): catchUp is a cron-only opt-in. Swap BASE's cron trigger for a MANUAL
    // one (still WITH durableWorker → the manual variant alone is valid) and add catchUp:true. The ONLY
    // defect is catchUp-on-non-cron; disabling the lint rule lets the bad spec parse → this goes RED.
    const manualWithCatchUp = BASE.replace(
      "    kind: cron\n    schedule: '0 0 * * *'\n    action: { kind: handler, handler: nightly_handler }",
      '    kind: manual\n    catchUp: true\n    action: { kind: handler, handler: nightly_handler }',
    );
    const res = parseSpec(manualWithCatchUp);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const catchUpCoherence = res.errors.find(
      (e) => e.code === 'schema_violation' && /catchUp.*valid ONLY for 'cron'/.test(e.message),
    );
    expect(catchUpCoherence).toBeDefined();
    expect(catchUpCoherence?.path).toMatch(/triggers\[\d+\]\.catchUp/);
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

  it('rejects an agent whose outputSchema.schema JSON-Schema is malformed', () => {
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

describe('negative — agent outputSchema is fail-closed (core OutputSchemaSpec .strict())', () => {
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

describe('negative — tool parameters must be an object schema', () => {
  it('rejects a tool whose parameters is a (compilable) non-object schema', () => {
    // type:'string' compiles fine as JSON-Schema but is invalid as model-facing tool args.
    const yaml = BASE.replace(
      'parameters:\n      type: object\n      properties:\n        msg: { type: string }',
      'parameters:\n      type: string',
    );
    expectRejection(yaml, 'schema_violation');
  });
});

describe('negative — duplicate tool NAME (dispatchTool keys on name)', () => {
  it('rejects two tools with distinct ids but the SAME name', () => {
    const yaml = BASE.replace(
      'tooling:\n  - id: echo',
      'tooling:\n  - id: echo2\n    name: echo\n    description: dup-name\n    parameters: { type: object }\n    handler: echo_handler\n    idempotent: true\n    timeoutMs: 1000\n  - id: echo',
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

describe('negative — duplicate api route', () => {
  it('rejects two routes with the same method + path', () => {
    const yaml = BASE.replace(
      "api:\n  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }",
      "api:\n  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }\n  - { method: GET, path: '/widgets', action: { kind: store, store: widgets, op: list } }",
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

describe('negative — duplicate column name within a store', () => {
  it('rejects two columns with the same name', () => {
    const yaml = BASE.replace(
      '    columns:\n      - { name: label, type: text }',
      '    columns:\n      - { name: label, type: text }\n      - { name: label, type: text }',
    );
    expectRejection(yaml, 'duplicate_name');
  });
});

describe('negative — reserved column name', () => {
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
  for (const kw of ['order', 'after', 'limit', 'search', '__search'] as const) {
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

describe('negative — fullTextSearch coherence', () => {
  // A store that opts into full-text search needs at least one text column to build the tsvector over,
  // and may not declare the reserved generated `search_vector` column. Fail-the-fix: without the FTS
  // coherence rule both specs parse+lint CLEAN (the grammar accepts the optional boolean), so each
  // rejection below goes RED.
  it('rejects fullTextSearch:true on a store with NO text column → schema_violation', () => {
    const yaml = `
version: '1.0'
metadata:
  name: fts-no-text
stores:
  - name: counters
    fullTextSearch: true
    columns:
      - { name: total, type: integer }
`;
    const res = parseSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(
      res.errors.some(
        (e) => e.code === 'schema_violation' && /fullTextSearch.*no 'text' column/.test(e.message),
      ),
    ).toBe(true);
  });

  it('rejects a fullTextSearch store declaring the reserved column search_vector → reserved_column_name', () => {
    const yaml = `
version: '1.0'
metadata:
  name: fts-clash
stores:
  - name: docs
    fullTextSearch: true
    columns:
      - { name: title, type: text }
      - { name: search_vector, type: text }
`;
    expectRejection(yaml, 'reserved_column_name');
  });

  it('accepts fullTextSearch:true on a store WITH a text column (the positive counterpart)', () => {
    const yaml = `
version: '1.0'
metadata:
  name: fts-ok
stores:
  - name: docs
    fullTextSearch: true
    columns:
      - { name: title, type: text }
      - { name: views, type: integer }
`;
    const res = parseSpec(yaml);
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.stores[0]?.fullTextSearch).toBe(true);
  });
});

describe('negative — FK onDelete set null on a NOT NULL column', () => {
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

describe('negative — column enum whitelist coherence', () => {
  it('rejects an enum on a NON-text column → schema_violation', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      "      - { name: label, type: text }\n      - { name: count, type: integer, enum: ['1', '2'] }",
    );
    // Fail-the-fix: without the text-only enum lint the spec parses clean (grammar allows enum on any column).
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects an enum with a DUPLICATE value → schema_violation', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      "      - { name: status, type: text, enum: ['open', 'open'] }",
    );
    expectRejection(yaml, 'schema_violation');
  });

  it('a text column with a distinct enum parses OK (isolates the two checks above)', () => {
    const yaml = BASE.replace(
      '      - { name: label, type: text }',
      "      - { name: status, type: text, enum: ['open', 'closed'] }",
    );
    const res = parseSpec(yaml);
    if (!res.ok)
      throw new Error(`enum-on-text must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });
});

describe('negative — business-key FK (referencesColumn) coherence', () => {
  // A parent with a UNIQUE `slug` (text) column; a child referencing it by a business key.
  const withFk = (childCol: string, fk: string) => `
version: '1.0'
metadata:
  name: bizfk
stores:
  - name: meetings
    columns:
      - { name: slug, type: text, unique: true }
      - { name: title, type: text, nullable: true }
  - name: transcripts
    columns:
      - ${childCol}
    foreignKeys:
      - ${fk}
`;

  it('the well-formed business-key FK parses OK (isolates the negatives below)', () => {
    const res = parseSpec(
      withFk(
        '{ name: meeting_slug, type: text }',
        '{ column: meeting_slug, references: meetings, referencesColumn: slug }',
      ),
    );
    if (!res.ok)
      throw new Error(`business-key FK must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });

  it('referencesColumn naming an UNDECLARED target column → dangling_ref', () => {
    expectRejection(
      withFk(
        '{ name: meeting_slug, type: text }',
        '{ column: meeting_slug, references: meetings, referencesColumn: ghost }',
      ),
      'dangling_ref',
    );
  });

  it('referencesColumn naming a NON-unique target column → schema_violation', () => {
    expectRejection(
      withFk(
        '{ name: meeting_title, type: text }',
        '{ column: meeting_title, references: meetings, referencesColumn: title }',
      ),
      'schema_violation',
    );
  });

  it('a local FK column whose type MISMATCHES the referenced column → schema_violation', () => {
    // meeting_slug is uuid but references meetings.slug (text) — the FK column type must match.
    expectRejection(
      withFk(
        '{ name: meeting_slug, type: uuid }',
        '{ column: meeting_slug, references: meetings, referencesColumn: slug }',
      ),
      'schema_violation',
    );
  });

  it("referencesColumn with onDelete:'set null' → schema_violation (a compound FK cannot null tenant_id)", () => {
    expectRejection(
      withFk(
        '{ name: meeting_slug, type: text, nullable: true }',
        "{ column: meeting_slug, references: meetings, referencesColumn: slug, onDelete: 'set null' }",
      ),
      'schema_violation',
    );
  });

  it('a FK whose generated constraint name exceeds the 63-char Postgres limit → schema_violation (never silently truncated)', () => {
    // Each identifier is individually ≤63 (SafeIdentifier), but the constraint name
    // `<table>_<col>_<parent>_<refcol>_fk` concatenates four of them and here overflows 63 bytes.
    // Postgres would SILENTLY TRUNCATE such an ADD CONSTRAINT name, breaking the store-route 23503
    // update discriminator (which matches the reported constraint_name EXACTLY) — so lint rejects it
    // at config time. Fail-the-fix: without the FK-NAME-LEN check this spec parses clean.
    const yaml = `
version: '1.0'
metadata:
  name: longfk
stores:
  - name: meetings
    columns:
      - { name: meeting_reference_slug, type: text, unique: true }
  - name: transcription_note_records
    columns:
      - { name: referenced_meeting_reference_slug, type: text }
    foreignKeys:
      - { column: referenced_meeting_reference_slug, references: meetings, referencesColumn: meeting_reference_slug }
`;
    const res = parseSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return; // narrow
    const hit = res.errors.find(
      (e) => e.code === 'schema_violation' && /63-char Postgres identifier limit/.test(e.message),
    );
    expect(hit, JSON.stringify(res.errors, null, 2)).toBeTruthy();
    // names the offending FK column + the generated constraint name, and its length
    expect(hit?.message).toContain('referenced_meeting_reference_slug');
    expect(hit?.message).toMatch(/transcription_note_records_referenced_meeting_reference_slug_/);
  });
});

describe('negative — unquoted numeric version (helpful diagnostic, no coercion)', () => {
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

// ---- untested correct branches (each a regression tripwire) ------------------------
describe('negative — previously-untested lint branches', () => {
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

/**
 * An agent action's optional `persistTo` writes the run's validated output into a declared store. Each
 * defect below is caught at DEPLOY (parse/doctor), never surfacing at the runtime persist write: an
 * unknown store is a dangling ref; a missing/mismatched outputSchema shape is a schema violation.
 */
const PERSIST_BASE = `
version: '1.0'
metadata:
  name: persist-base
stores:
  - name: extracted_facts
    columns:
      - { name: title, type: text }
      - { name: score, type: integer }
      - { name: verified, type: boolean }
      - { name: details, type: jsonb }
api:
  - method: POST
    path: '/extract'
    action: { kind: agent, agent: extractor, persistTo: extracted_facts }
agents:
  - id: extractor
    name: extractor
    backend: openai
    model: gpt-4o-mini
    instructions: extract the facts
    outputSchema:
      name: Facts
      schema:
        type: object
        required: [title, score, verified, details]
        properties:
          title: { type: string }
          score: { type: integer }
          verified: { type: boolean }
          details: { type: object }
`;

describe('persistTo — output persistence target (fail-closed at deploy)', () => {
  it('the persistTo base spec is valid (so each negative case isolates ONE defect)', () => {
    const res = parseSpec(PERSIST_BASE);
    if (!res.ok)
      throw new Error(`persist base must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });

  it('rejects persistTo naming an UNKNOWN store (dangling_ref)', () => {
    const yaml = PERSIST_BASE.replace('persistTo: extracted_facts', 'persistTo: nonexistent_store');
    expectRejection(yaml, 'dangling_ref');
  });

  it('rejects persistTo when the agent declares NO outputSchema (schema_violation)', () => {
    // Drop the whole outputSchema block: there is no structured output to persist.
    const yaml = PERSIST_BASE.replace(/ {4}outputSchema:[\s\S]*$/, '    tools: []\n');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects an output property whose type MISMATCHES the store column (object → text)', () => {
    // `title` maps to a `text` column; declaring it as a JSON object is a shape mismatch.
    const yaml = PERSIST_BASE.replace('title: { type: string }', 'title: { type: object }');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects an output property that is NOT a writable business column (schema_violation)', () => {
    // A stray property with no matching column — a runtime insert would fail-closed; catch it at deploy.
    const yaml = PERSIST_BASE.replace(
      'details: { type: object }',
      'details: { type: object }\n          bogus_column: { type: string }',
    );
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects persistTo to a SERVER-CONTROLLED column (id → not writable)', () => {
    const yaml = PERSIST_BASE.replace('title: { type: string }', 'id: { type: string }');
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a TRIGGER agent action persistTo naming an unknown store (dangling_ref)', () => {
    const yaml = `${PERSIST_BASE}
deployment:
  durableWorker: true
triggers:
  - name: refresh
    kind: manual
    action: { kind: agent, agent: extractor, persistTo: nonexistent_store }
`;
    expectRejection(yaml, 'dangling_ref');
  });

  // ── Reverse required-column coverage: a NOT-NULL business column the output does not reliably fill
  // would fail the runtime INSERT (NOT-NULL violation) AFTER the run billed. The doctor must reject that
  // at deploy. Each case below leaves the store's NOT-NULL columns un-covered in exactly ONE way.
  it('rejects a NOT-NULL store column with NO matching output property (schema_violation)', () => {
    // Remove the `score` property entirely (and from `required`): the NOT-NULL `score` column is now
    // produced by nothing → a runtime NOT-NULL violation the doctor must catch at deploy.
    const yaml = PERSIST_BASE.replace('          score: { type: integer }\n', '').replace(
      'required: [title, score, verified, details]',
      'required: [title, verified, details]',
    );
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a NOT-NULL store column mapped by a property that is NOT in `required` (schema_violation)', () => {
    // `score` still has a matching property, but drop it from `required` — an optional property the model
    // may omit cannot satisfy a NOT-NULL column.
    const yaml = PERSIST_BASE.replace(
      'required: [title, score, verified, details]',
      'required: [title, verified, details]',
    );
    expectRejection(yaml, 'schema_violation');
  });

  it('rejects a NOT-NULL store column mapped by a NULLABLE-typed property (type includes null) (schema_violation)', () => {
    // `score` is required, but its type now includes `null` — an emitted null would violate the column's
    // NOT-NULL constraint at runtime.
    const yaml = PERSIST_BASE.replace(
      'score: { type: integer }',
      'score: { type: [integer, "null"] }',
    );
    expectRejection(yaml, 'schema_violation');
  });

  // ── Enum whitelist subset: a store column enum is enforced server-side; a mapped output property whose
  // enum escapes the whitelist would fail the persist fail-closed at runtime.
  const PERSIST_ENUM_BASE = `
version: '1.0'
metadata:
  name: persist-enum-base
stores:
  - name: tickets
    columns:
      - { name: status, type: text, enum: [open, closed] }
api:
  - method: POST
    path: '/tickets'
    action: { kind: agent, agent: classifier, persistTo: tickets }
agents:
  - id: classifier
    name: classifier
    backend: openai
    model: gpt-4o-mini
    instructions: classify the ticket
    outputSchema:
      name: Ticket
      schema:
        type: object
        required: [status]
        properties:
          status: { type: string, enum: [open, closed] }
`;

  it('the persistTo enum base spec is valid (a subset enum maps cleanly)', () => {
    const res = parseSpec(PERSIST_ENUM_BASE);
    if (!res.ok)
      throw new Error(`persist enum base must parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.ok).toBe(true);
  });

  it('rejects an output property enum that ESCAPES the store column enum whitelist (schema_violation)', () => {
    // `pending` is not in the column whitelist [open, closed] — the model could emit a value the store
    // rejects fail-closed at runtime.
    const yaml = PERSIST_ENUM_BASE.replace(
      'status: { type: string, enum: [open, closed] }',
      'status: { type: string, enum: [open, closed, pending] }',
    );
    expectRejection(yaml, 'schema_violation');
  });
});
