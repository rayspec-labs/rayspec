/**
 * `validateHoles` fail-closed tests (the holes contract).
 *
 * The validator is the authoring-time fence: every name that gets string-templated into the emitted
 * handler is checked against a strict charset HERE, so the renderer can splice names without an
 * injection risk. These prove the fence FIRES on every malformed hole-set vector (a bad name, an
 * injected-column write, a missing required field, a cross-field violation) and PASSES the clean
 * reference hole-sets.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HandlerHoles } from './holes.js';
import {
  CLAMP_HOLE_KEYS,
  COLUMN_HOLE_KEYS,
  FK_REVALIDATE_KEYS,
  HolesError,
  LOOKUP_HOLE_KEYS,
  PERSIST_HOLE_KEYS,
  validateHoles,
} from './holes.js';
import { renderHandler } from './templates.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../../../..');
const HOLES_DIR = join(REPO_ROOT, 'examples/expense-claim-coder/holes');

/** The committed reference hole-set, read VERBATIM off disk (the accept control for the edits below). */
function committed(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(HOLES_DIR, name), 'utf8')) as Record<string, unknown>;
}

/**
 * Rename exactly ONE top-level key, keeping its value and its position — the object equivalent of the
 * one-line diff an author makes by mistyping a key in the committed file.
 */
function renameKey(o: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  expect(Object.hasOwn(o, from)).toBe(true);
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k === from ? to : k, v]));
}

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

/** A persist column list carrying BOTH a plain text column and a closed-enum (rankable) one. */
function enumColumns(): Record<string, unknown>[] {
  return [
    { col: 'category_code', jsonType: 'text', required: true, nullable: false },
    {
      col: 'policy_flag',
      jsonType: 'text',
      required: true,
      nullable: false,
      enumValues: ['ok', 'review', 'violation'],
    },
  ];
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
  it('accepts a persist with a clampValues bound on a declared enum column', () => {
    expect(() =>
      validateHoles(
        persist({
          columns: enumColumns(),
          clampValues: { policy_flag: { max: 'review' } },
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

  it('accepts `bigint`, and its rejection message names the CURRENT vocabulary', () => {
    // This local `ColumnType` union is a HAND-MAINTAINED copy with no type link to `@rayspec/spec`,
    // so widening the grammar produces zero errors here — a bigint persist column would be blocked
    // with a message quoting a vocabulary the grammar has outgrown. Fail-closed, but wrong.
    expect(() =>
      validateHoles(
        persist({ columns: [{ col: 'x', jsonType: 'bigint', required: true, nullable: false }] }),
      ),
    ).not.toThrow();
    // The enumerated list in the failure text is hand-written and is the edit most likely to be
    // dropped; if it is, the message lies about what the renderer accepts.
    expect(() =>
      validateHoles(
        persist({ columns: [{ col: 'x', jsonType: 'float', required: true, nullable: false }] }),
      ),
    ).toThrow(/bigint/);
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
  it('rejects DUPLICATE enumValues — the declared order is what a clamp ranks by', () => {
    // Duplicates were harmless while enumValues only fed a membership check: `['ok','review','ok']`
    // admits exactly the same values as `['ok','review']`. A clamp made the ORDER load-bearing, and it
    // ranks with `indexOf`, so the FIRST occurrence silently wins and the later one is a position the
    // ladder never reaches. An author who writes a duplicate has some ordering in mind; whichever it
    // is, the rendered bound will not be it. There is no safe interpretation to pick, so fail closed.
    expect(() =>
      validateHoles(
        persist({
          columns: [
            {
              col: 'policy_flag',
              jsonType: 'text',
              required: true,
              nullable: false,
              enumValues: ['ok', 'review', 'ok'],
            },
          ],
        }),
      ),
    ).toThrow(/duplicate/i);
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
  it('rejects a clampValues bound that cannot mean what its author declared', () => {
    // A clamp RANKS a model-chosen classification by the column's DECLARED enumValues order and caps it
    // server-side. Each arm below is a hole-set whose bound could never do that — and every one of them
    // fails SILENTLY if it is allowed through (the render simply emits no bound, or a bound that is
    // overwritten before the write), which is the worst failure mode for a safety hole. RED-first:
    // remove the clampValues block in validateHoles → every arm goes RED.
    const columns = enumColumns();
    // (a) a clamp on a column with NO declared enumValues — there is no order to rank by.
    expect(() =>
      validateHoles(persist({ columns, clampValues: { category_code: { max: 'TRAVEL' } } })),
    ).toThrow(/not an enum column/);
    // (b) a clamp key that is not a declared column at all (nothing to bound).
    expect(() =>
      validateHoles(persist({ columns, clampValues: { severity: { max: 'ok' } } })),
    ).toThrow(/must be one of holes.columns/);
    // (c) a max outside the column's own declared enumValues (an unrankable bound).
    expect(() =>
      validateHoles(persist({ columns, clampValues: { policy_flag: { max: 'catastrophic' } } })),
    ).toThrow(/enumValues/);
    // (d) a clamp key that also carries a fixedValues constant — the stamp is the LAST mutation before
    // the write, so the author constant would overwrite the clamped value and the bound would never
    // reach the store.
    expect(() =>
      validateHoles(
        persist({
          columns,
          clampValues: { policy_flag: { max: 'review' } },
          fixedValues: { policy_flag: 'violation' },
        }),
      ),
    ).toThrow(/overlaps holes.fixedValues/);
    // (e) a clamp key that is the fkRevalidate.codeArg — that column is a model-chosen IDENTIFIER
    // re-checked against a lookup store, not a ranked classification, so the clamp would persist a
    // value the FK re-check never saw. (Enum-typed here so it reaches the overlap rule, not the
    // not-an-enum-column rule above.)
    expect(() =>
      validateHoles(
        persist({
          columns,
          clampValues: { policy_flag: { max: 'review' } },
          fkRevalidate: {
            codeArg: 'policy_flag',
            lookupStore: 'expense_categories',
            lookupColumn: 'code',
          },
        }),
      ),
    ).toThrow(/overlaps holes.fkRevalidate.codeArg/);
    // (f) a clamp key that is the upsert naturalKeyCol. ARM B reads the key BEFORE the clamp block and
    // stamps the tenant-namespaced ref back onto the row AFTER it, so the bound would never reach the
    // store — while the result STILL journals a clamp record asserting that it did. That false
    // attestation is worse than a plain no-op, so fail closed.
    expect(() =>
      validateHoles(
        persist({
          mode: 'upsert-by-natural-key',
          idArg: undefined,
          naturalKeyCol: 'policy_flag',
          columns,
          clampValues: { policy_flag: { max: 'review' } },
        }),
      ),
    ).toThrow(/is holes.naturalKeyCol/);
    // A clamp on a DIFFERENT column of the same upsert hole-set is still ACCEPTED — only the key
    // column carries the last-mutation problem.
    expect(() =>
      validateHoles(
        persist({
          mode: 'upsert-by-natural-key',
          idArg: undefined,
          naturalKeyCol: 'category_code',
          columns,
          clampValues: { policy_flag: { max: 'review' } },
        }),
      ),
    ).not.toThrow();
  });
  it('rejects a CONDITIONAL clamp form (a clamp is an unconditional max bound)', () => {
    // A conditional key would be SILENTLY IGNORED by the renderer, leaving the author believing the
    // bound is narrower than it is. Fail closed rather than emit a bound nobody declared.
    expect(() =>
      validateHoles(
        persist({
          columns: enumColumns(),
          clampValues: {
            policy_flag: { max: 'review', unless: { field: 'employee_email', equals: 'x' } },
          },
        }),
      ),
    ).toThrow(/unsupported key/);
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

describe('validateHoles — an UNKNOWN top-level key is named, never ignored', () => {
  // A hole key is the whole configuration of the mechanism it names, so a key the validator does not
  // recognise cannot be treated as decoration: mistyping `clampValues` drops the entire server-side
  // clamp, mistyping `fkRevalidate` drops the entire FK re-check, and a tolerant parser renders a
  // DIFFERENT program while still reporting success. Every case below starts from the VERBATIM
  // committed hole-set, which is asserted to validate in the same run — so a broken fixture cannot
  // make the rejections look real.

  it('ACCEPT CONTROL: both committed hole-sets validate exactly as they are on disk', () => {
    expect(() => validateHoles(committed('code-claim.holes.json'))).not.toThrow();
    expect(() => validateHoles(committed('lookup-categories.holes.json'))).not.toThrow();
  });

  it('rejects `clampValues` mistyped as `clampValue` — and names the key it nearly is', () => {
    const typo = renameKey(committed('code-claim.holes.json'), 'clampValues', 'clampValue');
    expect(() => validateHoles(typo)).toThrow(HolesError);
    expect(() => validateHoles(typo)).toThrow(/'clampValue'/);
    expect(() => validateHoles(typo)).toThrow(/did you mean 'clampValues'/);
  });

  it('rejects `fkRevalidate` mistyped as `fkRevalidates` — and names the key it nearly is', () => {
    const typo = renameKey(committed('code-claim.holes.json'), 'fkRevalidate', 'fkRevalidates');
    expect(() => validateHoles(typo)).toThrow(HolesError);
    expect(() => validateHoles(typo)).toThrow(/'fkRevalidates'/);
    expect(() => validateHoles(typo)).toThrow(/did you mean 'fkRevalidate'/);
  });

  it('rejects an unknown key on a lookup hole-set too', () => {
    const typo = renameKey(committed('lookup-categories.holes.json'), 'maxRows', 'maxRow');
    expect(() => validateHoles(typo)).toThrow(/'maxRow'/);
    expect(() => validateHoles(typo)).toThrow(/did you mean 'maxRows'/);
  });

  it('the allow-list is PER TEMPLATE — a key of the other template is unknown here', () => {
    // `clampValues` is a real persist key and `maxRows` a real lookup key; neither means anything to
    // the template it is not part of, and the renderer for that template never reads it.
    expect(() =>
      validateHoles(lookup({ clampValues: { policy_flag: { max: 'review' } } })),
    ).toThrow(/'clampValues'/);
    expect(() => validateHoles(persist({ maxRows: 200 }))).toThrow(/'maxRows'/);
  });

  it('names EVERY unknown key in one message, not just the first', () => {
    const two = persist({ clampValue: { policy_flag: { max: 'review' } }, note: 'why' });
    expect(() => validateHoles(two)).toThrow(/'clampValue'/);
    expect(() => validateHoles(two)).toThrow(/'note'/);
  });

  it('tolerates no annotation key either — nothing unknown is carried through', () => {
    // There is no reserved comment/annotation prefix: a hole-set is the renderer's whole input, and a
    // key the renderer never reads is indistinguishable from a key it was meant to read.
    expect(() => validateHoles(persist({ $comment: 'why this handler exists' }))).toThrow(
      /'\$comment'/,
    );
    expect(() => validateHoles(persist({ _note: 'x' }))).toThrow(/'_note'/);
  });

  it('an unknown key is rejected BEFORE any per-field message, so the typo is what the author reads', () => {
    // The typo is the cause; a downstream complaint about the field it displaced would send the author
    // to the wrong line.
    expect(() => validateHoles(persist({ exportNam: 'codeClaim', exportName: undefined }))).toThrow(
      /'exportNam'/,
    );
  });
});

describe('validateHoles — an UNKNOWN key INSIDE a fixed-shape hole is named too', () => {
  // The same rule one level down, for the same reason. These are one-character edits of the committed
  // hole-set, and each one silently removed a server-side safety while the render still reported
  // success: dropping the `r` from `lookupFixedFilter` renders an FK re-check WITHOUT the
  // `active: true` predicate (it starts matching DEACTIVATED lookup rows), and dropping the `s` from
  // `enumValues` renders a coercion WITHOUT the closed-set membership check (any string the model
  // emits is persisted into the classification column). Each case carries its own ACCEPT CONTROL, so
  // the rejection is attributable to the renamed key and to nothing else in the hole-set.

  it('rejects `lookupFixedFilter` mistyped inside fkRevalidate — and names the key it nearly is', () => {
    expect(() => validateHoles(committed('code-claim.holes.json'))).not.toThrow(); // accept control
    const h = committed('code-claim.holes.json');
    h.fkRevalidate = renameKey(
      h.fkRevalidate as Record<string, unknown>,
      'lookupFixedFilter',
      'lookupFixedFilters',
    );
    expect(() => validateHoles(h)).toThrow(HolesError);
    expect(() => validateHoles(h)).toThrow(
      /holes\.fkRevalidate carries the unknown key\(s\) 'lookupFixedFilters'/,
    );
    expect(() => validateHoles(h)).toThrow(/did you mean 'lookupFixedFilter'/);
  });

  it('rejects `enumValues` mistyped inside a column hole — and names the key it nearly is', () => {
    // The clamp is dropped from BOTH the control and the edit: `clampValues` ranks by the column's
    // enumValues, so on the committed file an unrelated rule would notice the missing enumValues and
    // the column check would not be what fires. A hole-set whose enum column carries no clamp is the
    // shape where nothing else notices — which is exactly the silent case this closes.
    const control = committed('code-claim.holes.json');
    delete control.clampValues;
    expect(() => validateHoles(control)).not.toThrow(); // accept control
    const h = committed('code-claim.holes.json');
    delete h.clampValues;
    const cols = h.columns as Record<string, unknown>[];
    const i = cols.findIndex((c) => c.col === 'policy_flag');
    expect(i).toBeGreaterThan(-1);
    cols[i] = renameKey(cols[i] as Record<string, unknown>, 'enumValues', 'enumValue');
    expect(() => validateHoles(h)).toThrow(HolesError);
    expect(() => validateHoles(h)).toThrow(
      new RegExp(`holes\\.columns\\[${i}\\] carries the unknown key\\(s\\) 'enumValue'`),
    );
    expect(() => validateHoles(h)).toThrow(/did you mean 'enumValues'/);
  });

  it('tolerates no annotation key one level down either', () => {
    const inFk = committed('code-claim.holes.json');
    (inFk.fkRevalidate as Record<string, unknown>).$comment = 'why this handler exists';
    expect(() => validateHoles(inFk)).toThrow(/holes\.fkRevalidate carries the unknown key/);
    expect(() => validateHoles(inFk)).toThrow(/'\$comment'/);
    const inCol = committed('code-claim.holes.json');
    (inCol.columns as Record<string, unknown>[])[0]!.$comment = 'the FK-checked code';
    expect(() => validateHoles(inCol)).toThrow(/holes\.columns\[0\] carries the unknown key/);
    expect(() => validateHoles(inCol)).toThrow(/'\$comment'/);
  });

  it('rejects a non-object fkRevalidate rather than reading absent fields off it', () => {
    expect(() => validateHoles(persist({ fkRevalidate: 'category_code' }))).toThrow(
      /holes\.fkRevalidate must be a plain object/,
    );
    expect(() => validateHoles(persist({ fkRevalidate: ['category_code'] }))).toThrow(
      /holes\.fkRevalidate must be a plain object/,
    );
  });
});

describe('the allow-lists cover the whole hole shape (a new key cannot become silently optional)', () => {
  // The rejections above are only as good as the lists they check against: a hole key added later and
  // NOT listed would be rejected on every hole-set that carries it — the mirror-image failure, which
  // makes a declared, rendered key UNPASSABLE. These two tests hold every list to the shape from both
  // directions, so the suite goes RED on the omission rather than shipping a key nobody can pass.
  const holesSrc = readFileSync(join(here, 'holes.ts'), 'utf8');
  /** `template` + `exportName` + `store` — the floor every hole-set's observed reads must clear. */
  const SHARED_KEY_COUNT = 3;

  /**
   * The members declared by one hole interface, read out of the source of truth itself. The `readonly`
   * modifier is OPTIONAL in the match on purpose: it is a convention no compiler or lint rule enforces
   * here, so a member declared without it is just as declared, just as renderable — and would slip past
   * a modifier-bound pattern into exactly the unpassable state this test exists to prevent.
   */
  function interfaceMembers(name: string): string[] {
    const start = holesSrc.indexOf(`export interface ${name} {`);
    expect(start).toBeGreaterThan(-1);
    const body = holesSrc.slice(start, holesSrc.indexOf('\n}', start));
    return [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(
      (m) => m[1] as string,
    );
  }

  it('each allow-list is EXACTLY the interface that declares that hole shape', () => {
    expect([...PERSIST_HOLE_KEYS].sort()).toEqual(interfaceMembers('PersistHandlerHoles').sort());
    expect([...LOOKUP_HOLE_KEYS].sort()).toEqual(interfaceMembers('LookupHandlerHoles').sort());
    expect([...FK_REVALIDATE_KEYS].sort()).toEqual(interfaceMembers('FkRevalidateHole').sort());
    expect([...COLUMN_HOLE_KEYS].sort()).toEqual(interfaceMembers('ColumnHole').sort());
    expect([...CLAMP_HOLE_KEYS].sort()).toEqual(interfaceMembers('ClampHole').sort());
    // A sanity floor: the parse found the real members, not an empty match set.
    expect(PERSIST_HOLE_KEYS).toContain('clampValues');
    expect(LOOKUP_HOLE_KEYS).toContain('substringCol');
    expect(FK_REVALIDATE_KEYS).toContain('lookupFixedFilter');
    expect(COLUMN_HOLE_KEYS).toContain('enumValues');
    expect(CLAMP_HOLE_KEYS).toContain('max');
  });

  /** The committed persist set with every OPTIONAL mechanism dropped (the arms the golden never takes). */
  function barePersist(): Record<string, unknown> {
    const h = committed('code-claim.holes.json');
    delete h.fkRevalidate;
    delete h.fixedValues;
    delete h.clampValues;
    return h;
  }

  /**
   * The committed lookup set with a NON-EMPTY filterCols, NO substring pair and NO fixed predicate —
   * the lookup analogue of `barePersist()`. `renderLookupHandler` branches on `fixedFilter` presence
   * for the base filter literal, and the committed set carries one, so without this fixture that arm
   * is rendered by nothing.
   */
  function bareLookup(): Record<string, unknown> {
    const h = committed('lookup-categories.holes.json');
    h.filterCols = ['code'];
    delete h.fixedFilter;
    delete h.substringArg;
    delete h.substringCol;
    return h;
  }

  /**
   * The committed persist set widened to the remaining renderer arms: one column per `jsonType` (the
   * coercion switch renders a different block for each, and all four committed columns are `text`),
   * the optional/nullable missing-value tails (every committed column is `required`), and an
   * `fkRevalidate` WITHOUT `lookupFixedFilter` (the unfiltered FK re-check literal).
   */
  function everyColumnArm(): Record<string, unknown> {
    const h = committed('code-claim.holes.json');
    h.columns = [
      ...(h.columns as Record<string, unknown>[]),
      { col: 'receipt_ref', jsonType: 'uuid', required: false, nullable: true },
      { col: 'coded_at', jsonType: 'timestamp', required: false, nullable: false },
      { col: 'line_count', jsonType: 'integer', required: true, nullable: false },
      { col: 'amount_cents', jsonType: 'bigint', required: false, nullable: true },
      { col: 'is_billable', jsonType: 'boolean', required: false, nullable: false },
      { col: 'audit_note', jsonType: 'jsonb', required: false, nullable: true },
    ];
    delete (h.fkRevalidate as Record<string, unknown>).lookupFixedFilter;
    return h;
  }

  /**
   * Hand a hole-set to `validateHoles` and to BOTH renderer targets through recording proxies — one per
   * fixed-shape hole object — and return the keys each shape was actually READ for.
   */
  function observeReads(holes: Record<string, unknown>): {
    top: Set<string>;
    fk: Set<string>;
    column: Set<string>;
    clamp: Set<string>;
  } {
    const top = new Set<string>();
    const fk = new Set<string>();
    const column = new Set<string>();
    const clamp = new Set<string>();
    const record = (
      o: object,
      into: Set<string>,
      wrap?: (prop: string, value: unknown) => unknown,
    ): unknown =>
      new Proxy(o, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof prop !== 'string') return value;
          into.add(prop);
          return wrap === undefined ? value : wrap(prop, value);
        },
      });
    const recorded = record(holes, top, (prop, value) => {
      if (prop === 'fkRevalidate' && typeof value === 'object' && value !== null) {
        return record(value, fk);
      }
      if (prop === 'columns' && Array.isArray(value)) {
        // The ARRAY itself is not a hole shape (its keys are indices), so only its ELEMENTS record.
        return new Proxy(value, {
          get(target, p, receiver) {
            const v = Reflect.get(target, p, receiver);
            return typeof v === 'object' && v !== null && typeof p === 'string' && /^\d+$/.test(p)
              ? record(v, column)
              : v;
          },
        });
      }
      if (prop === 'clampValues' && typeof value === 'object' && value !== null) {
        // The MAP itself is not a hole shape (its keys are column names), so only its RULES record.
        return new Proxy(value as object, {
          get(target, p, receiver) {
            const v = Reflect.get(target, p, receiver);
            return typeof v === 'object' && v !== null && typeof p === 'string'
              ? record(v, clamp)
              : v;
          },
        });
      }
      return value;
    });
    validateHoles(recorded);
    renderHandler(recorded as HandlerHoles, 'ts');
    renderHandler(recorded as HandlerHoles, 'js');
    return { top, fk, column, clamp };
  }

  it('the keys actually READ and the allow-lists are the SAME set (neither direction slips)', () => {
    // Observed, not asserted from a second hand-written list. A key read only on an arm no fixture
    // takes is invisible here, so the fixtures below span every arm the renderers branch on a HOLE
    // VALUE for — enumerated so the claim stays checkable against `templates.ts`: both templates and
    // both emit targets; both persist modes; fkRevalidate/fixedValues/clampValues each present AND
    // absent; fkRevalidate.lookupFixedFilter present AND absent; every `jsonType` arm of the coercion
    // switch plus the enum-text arm; the required / nullable / drop tails; and on the lookup side
    // fixedFilter present AND absent and the substring pair present AND absent.
    const upsert = {
      ...committed('code-claim.holes.json'),
      mode: 'upsert-by-natural-key',
      idArg: undefined,
      naturalKeyCol: 'category_code',
    };
    const cases: { label: string; holes: Record<string, unknown>; allowed: readonly string[] }[] = [
      {
        label: 'committed persist',
        holes: committed('code-claim.holes.json'),
        allowed: PERSIST_HOLE_KEYS,
      },
      { label: 'persist upsert-by-natural-key', holes: upsert, allowed: PERSIST_HOLE_KEYS },
      { label: 'persist without fk/fixed/clamp', holes: barePersist(), allowed: PERSIST_HOLE_KEYS },
      {
        label: 'persist over every column arm, unfiltered FK re-check',
        holes: everyColumnArm(),
        allowed: PERSIST_HOLE_KEYS,
      },
      {
        label: 'committed lookup',
        holes: committed('lookup-categories.holes.json'),
        allowed: LOOKUP_HOLE_KEYS,
      },
      {
        label: 'lookup filtered, no fixed predicate, no substring',
        holes: bareLookup(),
        allowed: LOOKUP_HOLE_KEYS,
      },
    ];
    const readPersistTop = new Set<string>();
    const readLookupTop = new Set<string>();
    const readFk = new Set<string>();
    const readColumn = new Set<string>();
    const readClamp = new Set<string>();
    for (const { label, holes, allowed } of cases) {
      const { top, fk, column, clamp } = observeReads(holes);
      for (const k of top) (holes.template === 'persist' ? readPersistTop : readLookupTop).add(k);
      for (const k of fk) readFk.add(k);
      for (const k of column) readColumn.add(k);
      for (const k of clamp) readClamp.add(k);
      expect(
        [...top].filter((k) => !allowed.includes(k)),
        label,
      ).toEqual([]);
      expect(
        [...fk].filter((k) => !FK_REVALIDATE_KEYS.includes(k)),
        label,
      ).toEqual([]);
      expect(
        [...column].filter((k) => !COLUMN_HOLE_KEYS.includes(k)),
        label,
      ).toEqual([]);
      expect(
        [...clamp].filter((k) => !CLAMP_HOLE_KEYS.includes(k)),
        label,
      ).toEqual([]);
      // The proxies really did observe the reads (an empty set would make the filters vacuously green).
      expect(top.size, label).toBeGreaterThan(SHARED_KEY_COUNT);
      if (holes.fkRevalidate !== undefined) expect(fk.size, label).toBeGreaterThanOrEqual(3);
      if (holes.columns !== undefined) expect(column.size, label).toBeGreaterThanOrEqual(4);
      if (holes.clampValues !== undefined) expect(clamp.size, label).toBeGreaterThanOrEqual(1);
    }
    // The other direction, and the one that matters for a key added LATER: every allow-listed key must
    // be READ by something. Checking only `read ⊆ allowed` accepts a key that is declared on the
    // interface and listed here but rendered by nothing — it passes validation, configures nothing, and
    // renders byte-for-byte the program without it. That is the silent drop this file exists to stop,
    // so assert set EQUALITY. The fixtures above span every arm, which is what makes equality
    // reachable rather than aspirational.
    expect([...readPersistTop].sort()).toEqual([...PERSIST_HOLE_KEYS].sort());
    expect([...readLookupTop].sort()).toEqual([...LOOKUP_HOLE_KEYS].sort());
    expect([...readFk].sort()).toEqual([...FK_REVALIDATE_KEYS].sort());
    expect([...readColumn].sort()).toEqual([...COLUMN_HOLE_KEYS].sort());
    expect([...readClamp].sort()).toEqual([...CLAMP_HOLE_KEYS].sort());
  });
});
