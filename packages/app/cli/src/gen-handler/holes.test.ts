/**
 * `validateHoles` fail-closed tests (the holes contract).
 *
 * The validator is the authoring-time fence: every name that gets string-templated into the emitted
 * handler is checked against a strict charset HERE, so the renderer can splice names without an
 * injection risk. These prove the fence FIRES on every malformed hole-set vector (a bad name, an
 * injected-column write, a missing required field, a cross-field violation) and PASSES the clean
 * reference hole-sets.
 */
import { describe, expect, it } from 'vitest';
import { HolesError, validateHoles } from './holes.js';

/** A minimal valid persist hole-set (update-by-id). */
function persist(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    template: 'persist',
    exportName: 'codeClaim',
    store: 'expense_claims',
    mode: 'update-by-id',
    idArg: 'claim_id',
    successStatus: 'coded',
    columns: [{ col: 'category_code', jsonType: 'text', required: true, nullable: false }],
    ...over,
  };
}

/** A minimal valid lookup hole-set. */
function lookup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    template: 'lookup',
    exportName: 'lookupCategories',
    store: 'expense_categories',
    filterCols: [],
    projectCols: ['code', 'name'],
    maxRows: 200,
    ...over,
  };
}

describe('validateHoles — clean hole-sets pass', () => {
  it('accepts a minimal persist (update-by-id)', () => {
    expect(() => validateHoles(persist())).not.toThrow();
  });
  it('accepts a persist with an enum column, fixedValues, and FK re-validation', () => {
    expect(() =>
      validateHoles(
        persist({
          columns: [
            { col: 'category_code', jsonType: 'text', required: true, nullable: false },
            {
              col: 'policy_flag',
              jsonType: 'text',
              required: true,
              nullable: false,
              enumValues: ['ok', 'review'],
            },
          ],
          fixedValues: { status: 'coded' },
          fkRevalidate: {
            codeArg: 'category_code',
            lookupStore: 'expense_categories',
            lookupColumn: 'code',
          },
        }),
      ),
    ).not.toThrow();
  });
  it('accepts a persist with upsert-by-natural-key', () => {
    expect(() =>
      validateHoles(
        persist({
          mode: 'upsert-by-natural-key',
          idArg: undefined,
          naturalKeyCol: 'category_code',
        }),
      ),
    ).not.toThrow();
  });
  it('accepts a minimal lookup + a substring filter', () => {
    expect(() => validateHoles(lookup())).not.toThrow();
    expect(() =>
      validateHoles(
        lookup({
          substringArg: 'query',
          substringCol: 'name',
          filterCols: ['code'],
          fixedFilter: { active: true },
        }),
      ),
    ).not.toThrow();
  });
});

describe('validateHoles — fail-closed on malformed hole-sets', () => {
  it('rejects a non-object', () => {
    expect(() => validateHoles(null)).toThrow(HolesError);
    expect(() => validateHoles('x')).toThrow(HolesError);
  });
  it('rejects an unknown template', () => {
    expect(() => validateHoles(persist({ template: 'frobnicate' }))).toThrow(/template/);
  });
  it('rejects a non-identifier exportName (the string-templating fence)', () => {
    expect(() => validateHoles(persist({ exportName: 'code claim' }))).toThrow(/exportName/);
    expect(() => validateHoles(persist({ exportName: 'x; rmrf()' }))).toThrow(/exportName/);
    expect(() => validateHoles(persist({ exportName: '1bad' }))).toThrow(/exportName/);
  });
  it('rejects a non-snake store name (no quotes/backticks/newlines can survive)', () => {
    expect(() => validateHoles(persist({ store: 'Expense Claims' }))).toThrow(/store/);
    expect(() => validateHoles(persist({ store: "a'); DROP" }))).toThrow(/store/);
    expect(() => validateHoles(persist({ store: 'a`b' }))).toThrow(/store/);
  });
  it('rejects writing an injected/server column', () => {
    for (const col of ['id', 'tenant_id', 'created_at', 'deleted_at', 'retention_days', 'region']) {
      expect(() =>
        validateHoles(
          persist({ columns: [{ col, jsonType: 'text', required: true, nullable: false }] }),
        ),
      ).toThrow(/server-controlled\/injected/);
    }
  });
  it('rejects an injected column in fixedValues', () => {
    expect(() => validateHoles(persist({ fixedValues: { tenant_id: 'x' } }))).toThrow(
      /server-controlled\/injected/,
    );
  });
  it('rejects an unknown ColumnType', () => {
    expect(() =>
      validateHoles(
        persist({ columns: [{ col: 'x', jsonType: 'float', required: true, nullable: false }] }),
      ),
    ).toThrow(/jsonType/);
  });
  it('rejects enumValues on a non-text column', () => {
    expect(() =>
      validateHoles(
        persist({
          columns: [
            { col: 'n', jsonType: 'integer', required: true, nullable: false, enumValues: ['1'] },
          ],
        }),
      ),
    ).toThrow(/enumValues/);
  });
  it('rejects update-by-id without idArg, upsert without naturalKeyCol', () => {
    expect(() => validateHoles(persist({ idArg: undefined }))).toThrow(/idArg/);
    expect(() =>
      validateHoles(persist({ mode: 'upsert-by-natural-key', idArg: undefined })),
    ).toThrow(/naturalKeyCol/);
  });
  it('rejects a naturalKeyCol not in columns, and an fkRevalidate.codeArg not in columns', () => {
    expect(() =>
      validateHoles(
        persist({ mode: 'upsert-by-natural-key', idArg: undefined, naturalKeyCol: 'missing' }),
      ),
    ).toThrow(/must be one of holes.columns/);
    expect(() =>
      validateHoles(
        persist({ fkRevalidate: { codeArg: 'nope', lookupStore: 's', lookupColumn: 'c' } }),
      ),
    ).toThrow(/must be one of holes.columns/);
  });
  it('rejects lookup with empty projectCols, bad maxRows, half-set substring', () => {
    expect(() => validateHoles(lookup({ projectCols: [] }))).toThrow(/projectCols/);
    expect(() => validateHoles(lookup({ maxRows: 0 }))).toThrow(/maxRows/);
    expect(() => validateHoles(lookup({ maxRows: 99999 }))).toThrow(/maxRows/);
    expect(() => validateHoles(lookup({ substringArg: 'q' }))).toThrow(/together/);
  });
  it('rejects a fixedFilter with a non-scalar value (a SQL/object injection vector)', () => {
    expect(() => validateHoles(lookup({ fixedFilter: { active: { evil: true } } }))).toThrow(
      /scalar/,
    );
  });
  it('rejects a successStatus carrying a comment-breaking sequence (the JSDoc-splice fence)', () => {
    // successStatus is spliced into a JSDoc comment in the rendered handler; an unescaped `*/` (or a
    // newline / backtick / ${) would close the comment early and emit a non-compiling file. The fence
    // rejects anything outside the comment-safe label charset. RED-first: drop STATUS_LABEL_RE → RED.
    expect(() => validateHoles(persist({ successStatus: 'coded */ evil' }))).toThrow(
      /successStatus/,
    );
    expect(() => validateHoles(persist({ successStatus: 'a`b' }))).toThrow(/successStatus/);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal — proving the fence rejects a ${…} interpolation start in a successStatus.
    expect(() => validateHoles(persist({ successStatus: 'a${x}' }))).toThrow(/successStatus/);
    expect(() => validateHoles(persist({ successStatus: 'a\nb' }))).toThrow(/successStatus/);
    // A normal label (incl. a hyphen) is still accepted.
    expect(() => validateHoles(persist({ successStatus: 're-coded' }))).not.toThrow();
  });
  it('rejects an fkRevalidate.lookupFixedFilter that pins the lookupColumn (a duplicate filter key)', () => {
    // A lookupFixedFilter key == lookupColumn would emit a duplicate object key in the FK re-check filter
    // ({ code: 'X', code: code }) — last-wins silently drops the fixed predicate. Fail closed. RED-first:
    // remove the Object.hasOwn check → this goes RED.
    expect(() =>
      validateHoles(
        persist({
          fkRevalidate: {
            codeArg: 'category_code',
            lookupStore: 'expense_categories',
            lookupColumn: 'code',
            lookupFixedFilter: { code: 'X' },
          },
        }),
      ),
    ).toThrow(/must not contain the lookupColumn/);
    // A fixed predicate on a DIFFERENT column (the normal `active:true` case) is still accepted.
    expect(() =>
      validateHoles(
        persist({
          fkRevalidate: {
            codeArg: 'category_code',
            lookupStore: 'expense_categories',
            lookupColumn: 'code',
            lookupFixedFilter: { active: true },
          },
        }),
      ),
    ).not.toThrow();
  });
  it('rejects a fixedValues key that overlaps fkRevalidate.codeArg (silently no-ops the FK safety)', () => {
    // The renderer FK-validates the model's coerced value, then Object.assign(coerced.row, fixedValues)
    // overwrites it with the author constant as the LAST write — so a non-FK-validated constant persists,
    // silently no-op-ing the FK re-validation. Fail closed on the incoherent overlap. RED-first: remove
    // the overlap check in validateHoles → this goes RED (the malformed hole-set would render).
    expect(() =>
      validateHoles(
        persist({
          fixedValues: { category_code: 'CONST' },
          fkRevalidate: {
            codeArg: 'category_code',
            lookupStore: 'expense_categories',
            lookupColumn: 'code',
          },
        }),
      ),
    ).toThrow(/overlaps holes.fkRevalidate.codeArg/);
    // A NON-overlapping fixedValues (a different column) alongside the same FK is still ACCEPTED.
    expect(() =>
      validateHoles(
        persist({
          fixedValues: { status: 'coded' },
          fkRevalidate: {
            codeArg: 'category_code',
            lookupStore: 'expense_categories',
            lookupColumn: 'code',
          },
        }),
      ),
    ).not.toThrow();
  });
});
