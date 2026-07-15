/**
 * The 0.2 `stores` section + the store_read/store_write step vocabulary — grammar + lint proofs,
 * RED-first.
 *
 * Every arm is fail-the-fix: the healthy fixture parses+lints CLEAN, and each violation is a
 * one-mutation red with the exact closed SpecError code asserted (never "some error fired").
 */
import { describe, expect, it } from 'vitest';
import { toJsIdentifier } from './lint.js';
import { checkProductStores } from './product-lint.js';
import { parseProductSpec } from './product-parse.js';

/** A minimal audio-triggered doc exercising the WHOLE new vocabulary (stores + read/write steps). */
const FIELDLOG_YAML = `
version: "1.0"
product:
  id: fieldlog
  name: Fieldlog
capabilities:
  - id: audio_input
    tier: B
    status: available
    contracts: [audio_input.finalized_session]
contracts:
  fieldlog.catalog_rows:
    type: array
    items: { type: object }
  fieldlog.log_row:
    type: object
stores:
  - name: equipment_catalog
    description: Reference catalog the workflow reads.
    columns:
      - { name: item_code, type: text }
      - { name: label, type: text, nullable: true }
    key: [item_code]
  - name: session_log
    columns:
      - { name: entry_ref, type: text }
      - { name: session_id, type: text }
      - { name: status, type: text }
      - { name: catalog_snapshot, type: jsonb, nullable: true }
    key: [entry_ref]
workflows:
  - id: log_session
    trigger:
      capability: audio_input
      event: session_finalized
    steps:
      - id: catalog
        type: store_read
        use: store.read
        store: equipment_catalog
        filter:
          item_code: { const: mic_kit }
        limit: 10
        outputs:
          catalog: fieldlog.catalog_rows
      - id: log
        type: store_write
        use: store.write
        store: session_log
        depends_on: [catalog]
        values:
          entry_ref: { event: session_id }
          session_id: { event: session_id }
          status: { const: processed }
          catalog_snapshot: { artifact: fieldlog.catalog_rows }
        outputs:
          log_row: fieldlog.log_row
`;

function parseOk(yaml: string) {
  const r = parseProductSpec(yaml);
  if (!r.ok) throw new Error(`expected clean parse, got:\n${JSON.stringify(r.errors, null, 2)}`);
  return r.value;
}

function parseErrors(yaml: string) {
  const r = parseProductSpec(yaml);
  if (r.ok) throw new Error('expected errors, got a clean parse');
  return r.errors;
}

function expectCode(yaml: string, code: string, pattern: RegExp): void {
  const errors = parseErrors(yaml);
  const hit = errors.find((e) => e.code === code && pattern.test(e.message));
  if (!hit) {
    throw new Error(
      `expected a '${code}' error matching ${pattern}, got:\n${JSON.stringify(errors, null, 2)}`,
    );
  }
}

describe('the 0.2 stores section — grammar', () => {
  it('the healthy fixture parses + lints CLEAN (the whole new vocabulary in one doc)', () => {
    const spec = parseOk(FIELDLOG_YAML);
    expect(spec.stores.map((s) => s.name)).toEqual(['equipment_catalog', 'session_log']);
    // The existing column vocabulary applies: nullable/unique default false.
    expect(spec.stores[0]?.columns).toEqual([
      { name: 'item_code', type: 'text', nullable: false, unique: false },
      { name: 'label', type: 'text', nullable: true, unique: false },
    ]);
    expect(spec.stores[0]?.key).toEqual(['item_code']);
    // The step vocabulary rides on WorkflowStep (additive fields).
    const steps = spec.workflows[0]?.steps ?? [];
    expect(steps[0]?.store).toBe('equipment_catalog');
    expect(steps[0]?.filter).toEqual({ item_code: { const: 'mic_kit' } });
    expect(steps[0]?.limit).toBe(10);
    expect(steps[1]?.values).toEqual({
      entry_ref: { event: 'session_id' },
      session_id: { event: 'session_id' },
      status: { const: 'processed' },
      catalog_snapshot: { artifact: 'fieldlog.catalog_rows' },
    });
  });

  it('an ABSENT stores section defaults to [] (the additive no-op — prior docs unchanged)', () => {
    const spec = parseOk(
      FIELDLOG_YAML.replace(/stores:[\s\S]*?(?=workflows:)/, '').replace(
        /steps:[\s\S]*$/,
        `steps:
      - id: noop
        type: validation
        use: validation.check
        inputs:
          doc: fieldlog.log_row
`,
      ),
    );
    expect(spec.stores).toEqual([]);
  });

  it('a COMPOSITE key is rejected at the shape level (v1: exactly one conflict-key column)', () => {
    expectCode(
      FIELDLOG_YAML.replace('key: [item_code]', 'key: [item_code, label]'),
      'schema_violation',
      /exactly one conflict-key column/i,
    );
  });

  it('a store without a key is rejected (the at-least-once law makes the conflict key mandatory)', () => {
    const errors = parseErrors(FIELDLOG_YAML.replace('    key: [item_code]\n', ''));
    expect(errors.some((e) => e.code === 'schema_violation')).toBe(true);
  });

  it('an unknown store field / unknown column type fails closed (strict)', () => {
    expect(
      parseErrors(FIELDLOG_YAML.replace('key: [item_code]', 'key: [item_code]\n    sql: evil'))
        .length,
    ).toBeGreaterThan(0);
    expect(
      parseErrors(
        FIELDLOG_YAML.replace('{ name: label, type: text', '{ name: label, type: varchar'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('a filter const NULL is rejected at the shape level (SQL equality on NULL never matches)', () => {
    expectCode(
      FIELDLOG_YAML.replace('item_code: { const: mic_kit }', 'item_code: { const: null }'),
      'schema_violation',
      /./,
    );
  });

  it('a store_read limit above the cap is rejected at the shape level', () => {
    const errors = parseErrors(FIELDLOG_YAML.replace('limit: 10', 'limit: 100000'));
    expect(errors.some((e) => e.code === 'schema_violation')).toBe(true);
  });
});

describe('the 0.2 stores section — lint (fail-closed, closed codes)', () => {
  it('duplicate store names are rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace('- name: session_log', '- name: equipment_catalog'),
      'duplicate_name',
      /equipment_catalog/,
    );
  });

  it('a store name colliding with a derived collection store is rejected', () => {
    const yaml = FIELDLOG_YAML.replace(
      '\ncontracts:\n',
      `
artifacts:
  - kind: digest
    contract: fieldlog.log_row
    scope: session
    collection: equipment_catalog
contracts:
`,
    );
    expectCode(yaml, 'invalid_store', /collides with .*collection/i);
  });

  it('a reserved (injected tenancy/GDPR) column name is rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace('{ name: label, type: text', '{ name: tenant_id, type: text'),
      'reserved_column_name',
      /tenant_id/,
    );
  });

  it('a reserved list-query control keyword (order/after/limit/search) as a column name is rejected', () => {
    // Symmetric with the backend store lint: a column named after a list-query control key would be
    // un-filterable + would emit a duplicate OpenAPI query param. Fail-the-fix: without the
    // RESERVED_QUERY_KEYWORDS check these parse+lint clean (valid safe-identifiers).
    for (const kw of ['order', 'after', 'limit', 'search']) {
      expectCode(
        FIELDLOG_YAML.replace('{ name: label, type: text', `{ name: ${kw}, type: text`),
        'reserved_query_keyword',
        new RegExp(kw),
      );
    }
  });

  it('a column name on the graph key denylist is rejected AT DECLARATION (it could never be referenced from a step)', () => {
    expectCode(
      FIELDLOG_YAML.replace('{ name: label, type: text', '{ name: model, type: text'),
      'invalid_store',
      /model/,
    );
    expectCode(
      FIELDLOG_YAML.replace('{ name: label, type: text', '{ name: body, type: text'),
      'invalid_store',
      /body/,
    );
  });

  it('two column names that COLLIDE under the snake→camel runtime mapping are rejected, naming BOTH columns (digits are the real vector: col_1 ≡ col1)', () => {
    // `_([a-z0-9])` uppercases the char after the underscore — a DIGIT uppercases to ITSELF, so
    // `rev_1` and `rev1` both map to runtime column key `rev1`: the built PgTable would key ONE
    // column for two declared names, and the node's snake-based vs the facade's camel-based
    // DO-UPDATE/DO-NOTHING classification could diverge. Reject at declaration, naming both.
    expectCode(
      FIELDLOG_YAML.replace(
        '- { name: label, type: text, nullable: true }',
        `- { name: rev_1, type: text, nullable: true }
      - { name: rev1, type: text, nullable: true }`,
      ),
      'invalid_store',
      /'rev_1' and 'rev1'/,
    );
  });

  it('negative: LETTER underscore-placement variants do NOT collide (a_bc→aBc ≠ ab_c→abC) — no false positive', () => {
    const spec = parseOk(
      FIELDLOG_YAML.replace(
        '- { name: label, type: text, nullable: true }',
        `- { name: a_bc, type: text, nullable: true }
      - { name: ab_c, type: text, nullable: true }`,
      ),
    );
    expect(spec.stores[0]?.columns.map((c) => c.name)).toContain('a_bc');
    expect(checkProductStores(spec)).toEqual([]);
  });

  it('snake→camel pin: the spec-local snake→camel copy matches the facade/table-builder rule on literal examples (KEEP-IN-SYNC guard)', () => {
    // Literal pins of the ONE rule (`/_([a-z0-9])/g` → uppercase) replicated in
    // packages/platform/src/handlers/store-facade.ts (snakeToCamel),
    // packages/api-auth/src/engine/injected-columns-view.ts (snakeToCamel), and
    // packages/db/src/generated/build-product-tables.ts / generate-product-schema.ts (toCamel).
    // If any copy changes, this pin (and its counterpart docstrings) must move WITH it.
    expect(toJsIdentifier('meeting_id')).toBe('meetingId');
    expect(toJsIdentifier('col_1')).toBe('col1'); // digit uppercase is a NO-OP → the collision vector
    expect(toJsIdentifier('col1')).toBe('col1');
    expect(toJsIdentifier('a_bc')).toBe('aBc'); // letters keep the underscore info via case…
    expect(toJsIdentifier('ab_c')).toBe('abC'); // …so letter-placement variants do NOT collide
    expect(toJsIdentifier('a__b')).toBe('a_B'); // a doubled underscore survives (no [a-z0-9] after the 1st)
    expect(toJsIdentifier('tenant_id')).toBe('tenantId');
  });

  it('a key naming an undeclared column / a NULLABLE key column is rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace('key: [item_code]', 'key: [nonexistent]'),
      'invalid_store',
      /nonexistent/,
    );
    expectCode(
      FIELDLOG_YAML.replace(
        '{ name: item_code, type: text }',
        '{ name: item_code, type: text, nullable: true }',
      ),
      'invalid_store',
      /nullable/i,
    );
  });

  it('store_read: an undeclared target store / a missing store field is rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace('store: equipment_catalog', 'store: ghost_store'),
      'invalid_store',
      /ghost_store/,
    );
    expectCode(
      FIELDLOG_YAML.replace('        store: equipment_catalog\n', ''),
      'invalid_store',
      /store_read .*must declare .*store/i,
    );
  });

  it('store_read: a filter column outside the declared columns is rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace('item_code: { const: mic_kit }', 'ghost_col: { const: mic_kit }'),
      'invalid_store',
      /ghost_col/,
    );
  });

  it('store_read: `values` on a read / a missing single rows output is rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace(
        'limit: 10',
        `limit: 10
        values:
          item_code: { const: x }`,
      ),
      'invalid_store',
      /values/,
    );
    expectCode(
      FIELDLOG_YAML.replace('        outputs:\n          catalog: fieldlog.catalog_rows\n', ''),
      'invalid_store',
      /exactly one output/i,
    );
  });

  it('store_write: missing/empty values, a values column outside the contract, filter/limit on a write — all rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace(
        `        values:
          entry_ref: { event: session_id }
          session_id: { event: session_id }
          status: { const: processed }
          catalog_snapshot: { artifact: fieldlog.catalog_rows }
`,
        '',
      ),
      'invalid_store',
      /store_write .*must declare .*values/i,
    );
    expectCode(
      FIELDLOG_YAML.replace('status: { const: processed }', 'ghost_col: { const: processed }'),
      'invalid_store',
      /ghost_col/,
    );
    expectCode(
      FIELDLOG_YAML.replace(
        'depends_on: [catalog]',
        `depends_on: [catalog]
        limit: 5`,
      ),
      'invalid_store',
      /limit/,
    );
  });

  it('store_write: the declared conflict-key column MUST be among the written values (the upsert identity)', () => {
    expectCode(
      FIELDLOG_YAML.replace('entry_ref: { event: session_id }\n          ', ''),
      'invalid_store',
      /entry_ref/,
    );
  });

  it('store_write: a dangling {artifact: ref} value source is rejected', () => {
    expectCode(
      FIELDLOG_YAML.replace(
        'catalog_snapshot: { artifact: fieldlog.catalog_rows }',
        'catalog_snapshot: { artifact: fieldlog.ghost_contract }',
      ),
      'dangling_ref',
      /ghost_contract/,
    );
  });

  it('the store step fields are FORBIDDEN on non-store step types', () => {
    const yaml = FIELDLOG_YAML.replace(
      `      - id: log
        type: store_write
        use: store.write
        store: session_log`,
      `      - id: log
        type: validation
        use: validation.check
        store: session_log`,
    ).replace(
      `        values:
          entry_ref: { event: session_id }
          session_id: { event: session_id }
          status: { const: processed }
          catalog_snapshot: { artifact: fieldlog.catalog_rows }
        outputs:
          log_row: fieldlog.log_row
`,
      `        inputs:
          doc: fieldlog.log_row
`,
    );
    expectCode(yaml, 'invalid_store', /store/);
  });

  it('the use discipline is EXACT: store_read → store.read, store_write → store.write', () => {
    expectCode(
      FIELDLOG_YAML.replace('use: store.read', 'use: store.scan'),
      'schema_violation',
      /store\.read/,
    );
    expectCode(
      FIELDLOG_YAML.replace('use: store.write', 'use: store.insert'),
      'schema_violation',
      /store\.write/,
    );
  });

  it('CW-1: checkProductStores rejects a declared store shadowing a CAPABILITY store when the caller supplies the runtime set — and documents that parse time CANNOT (no runtime names in spec)', () => {
    // A declared store named like a capability-owned (audio) store. PARSE TIME passes no capability
    // set (@rayspec/spec cannot import runtime store names), so the doc parses CLEAN — the
    // documented parse-time cut: lint covers collection collisions only, COMPOSE covers both.
    const spec = parseOk(
      FIELDLOG_YAML.replace(
        'stores:\n  - name: equipment_catalog',
        'stores:\n  - name: audio_sessions\n    columns:\n      - { name: shadow_ref, type: text }\n    key: [shadow_ref]\n  - name: equipment_catalog',
      ),
    );
    // Without the optional set (the parse-time call shape): NO capability-collision error.
    expect(checkProductStores(spec).some((e) => /capability-owned/.test(e.message))).toBe(false);
    // WITH the runtime set (the compose call shape): rejected fail-closed, naming the collision.
    const errors = checkProductStores(spec, new Set(['audio_sessions', 'audio_tracks']));
    const hit = errors.find(
      (e) => e.code === 'invalid_store' && /audio_sessions.*capability-owned/s.test(e.message),
    );
    expect(hit, JSON.stringify(errors, null, 2)).toBeTruthy();
    expect(hit?.path).toBe('stores[0].name');
  });
});

describe('the store-step {const:} literals — graph-neutrality over-rejection (GLI-1, INTENDED)', () => {
  it('a store_write {const:} BUSINESS string containing a provider name is rejected fail-closed by the graph guard — pinned so a future narrowing of the guard goes red', () => {
    // Store-step {const:} literals live in the `workflows` graph subtree, so the security-adjacent
    // neutrality guardrails scan them like every other graph string. A business constant naming a
    // provider (or code-like tokens / production-claims) is OVER-REJECTED — the DOCUMENTED, INTENDED
    // posture (see product-grammar.ts StoreWriteConstValue): the guard must NOT be narrowed for
    // literal convenience; rephrase the constant or use an {event:}/{artifact:} source instead.
    const errors = parseErrors(
      FIELDLOG_YAML.replace('status: { const: processed }', 'status: { const: sent to deepgram }'),
    );
    const hit = errors.find(
      (e) => e.code === 'provider_native_leak' && /values\.status/.test(e.path ?? ''),
    );
    expect(hit, JSON.stringify(errors, null, 2)).toBeTruthy();
  });
});
