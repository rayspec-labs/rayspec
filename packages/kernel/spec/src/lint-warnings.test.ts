/**
 * `lintSpecWarnings` — the NON-FATAL advisory pass. A warning is surfaced (doctor/plan) but never
 * fails a parse. These tests pin the interactions it flags: a `softDelete` store that is the TARGET
 * of a `restrict` foreign key — id-target OR business-key (`referencesColumn`) — since soft-deleting
 * such a parent is an `UPDATE(deleted_at)` that does NOT fire the database ON DELETE restrict, so
 * children keep pointing at the tombstoned row; a foreign key onto a store declared LATER in the
 * array; and a `handlers[].module` that is TypeScript source, which the production loader refuses.
 *
 * Fail-the-fix: the positive case asserts the warning FIRES (RED if `lintSpecWarnings` misses it) AND
 * that the spec still parses `ok:true` (a warning is not an error); the negative cases assert NO warning
 * for each missing precondition (RED if the guard over-fires).
 */
import { describe, expect, it } from 'vitest';
import { lintSpecWarnings } from './lint.js';
import { parseSpec } from './parse.js';

/** Parse a spec that MUST be valid, returning the RaySpec (throws with the errors otherwise). */
function parseOk(yaml: string) {
  const res = parseSpec(yaml);
  if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
  return res.value;
}

/** meetings (softDelete + unique slug) ← transcripts (business-key FK on slug), with a tunable onDelete. */
const spec = (opts: { softDelete: boolean; onDelete: string; referencesColumn: boolean }) => `
version: '1.0'
metadata:
  name: sd-fk
stores:
  - name: meetings
    columns:
      - { name: slug, type: text, unique: true }
    softDelete: ${opts.softDelete}
  - name: transcripts
    columns:
      - { name: meeting_slug, type: text }
    foreignKeys:
      - { column: meeting_slug, references: meetings${
        opts.referencesColumn ? ', referencesColumn: slug' : ''
      }, onDelete: '${opts.onDelete}' }
`;

describe('lintSpecWarnings — softDelete × restrict business-key FK', () => {
  it('FIRES a softdelete_fk_restrict warning (and the spec still parses ok)', () => {
    const yaml = spec({ softDelete: true, onDelete: 'restrict', referencesColumn: true });
    const value = parseOk(yaml); // still valid — a warning is not a fail-closed error
    const warnings = lintSpecWarnings(value);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('softdelete_fk_restrict');
    expect(warnings[0]?.path).toBe('stores[0].softDelete');
    // Names the parent + child relationship, so an author can act on it.
    expect(warnings[0]?.message).toContain('meetings');
    expect(warnings[0]?.message).toContain('transcripts');
  });

  it('does NOT fire when the FK is CASCADE (only restrict is the flagged interaction)', () => {
    const value = parseOk(spec({ softDelete: true, onDelete: 'cascade', referencesColumn: true }));
    expect(lintSpecWarnings(value)).toEqual([]);
  });

  it('does NOT fire when the target store is NOT softDelete (hard delete fires the DB restrict)', () => {
    const value = parseOk(
      spec({ softDelete: false, onDelete: 'restrict', referencesColumn: true }),
    );
    expect(lintSpecWarnings(value)).toEqual([]);
  });

  it('FIRES for an ID-TARGET restrict FK too (a soft delete is an UPDATE — it fires NO ON DELETE restrict on either FK shape)', () => {
    // No referencesColumn ⇒ an id-target FK (references the parent's injected `id`); the local column
    // must be uuid to parse. A soft delete of the parent leaves this child pointing at the tombstone
    // exactly like the business-key case → the warning must fire.
    const yaml = `
version: '1.0'
metadata:
  name: sd-idfk
stores:
  - name: meetings
    columns:
      - { name: slug, type: text, unique: true }
    softDelete: true
  - name: transcripts
    columns:
      - { name: meeting_id, type: uuid }
    foreignKeys:
      - { column: meeting_id, references: meetings, onDelete: 'restrict' }
`;
    const warnings = lintSpecWarnings(parseOk(yaml));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('softdelete_fk_restrict');
    expect(warnings[0]?.path).toBe('stores[0].softDelete');
    // Names the parent + child so an author can act on it; references the parent's id (id-target FK).
    expect(warnings[0]?.message).toContain('meetings');
    expect(warnings[0]?.message).toContain('transcripts');
    expect(warnings[0]?.message).toContain('meetings.id');
  });

  it('does NOT fire for an ID-TARGET CASCADE FK (only restrict is the flagged interaction)', () => {
    const yaml = `
version: '1.0'
metadata:
  name: sd-idfk-cascade
stores:
  - name: meetings
    columns:
      - { name: slug, type: text, unique: true }
    softDelete: true
  - name: transcripts
    columns:
      - { name: meeting_id, type: uuid }
    foreignKeys:
      - { column: meeting_id, references: meetings, onDelete: 'cascade' }
`;
    expect(lintSpecWarnings(parseOk(yaml))).toEqual([]);
  });
});

describe('lintSpecWarnings — fk_forward_reference (child declared before its parent)', () => {
  it('FIRES when a store references another declared LATER (topo-sort reorders; still parses ok)', () => {
    // `books` (index 0) references `authors` (index 1) — a forward reference. The generator topo-sorts
    // so `authors` is created first, so this is valid (a warning, not an error).
    const yaml = `
version: '1.0'
metadata:
  name: fwd
stores:
  - name: books
    columns:
      - { name: author_id, type: uuid }
    foreignKeys:
      - { column: author_id, references: authors, onDelete: cascade }
  - name: authors
    columns:
      - { name: name, type: text }
`;
    const value = parseOk(yaml); // still valid — the forward reference applies via the topo-sort
    const warnings = lintSpecWarnings(value);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('fk_forward_reference');
    expect(warnings[0]?.path).toBe('stores[0].foreignKeys[0]');
    expect(warnings[0]?.message).toContain('books');
    expect(warnings[0]?.message).toContain('authors');
  });

  it('does NOT fire when the parent is declared FIRST (normal dependency order)', () => {
    const yaml = `
version: '1.0'
metadata:
  name: ordered
stores:
  - name: authors
    columns:
      - { name: name, type: text }
  - name: books
    columns:
      - { name: author_id, type: uuid }
    foreignKeys:
      - { column: author_id, references: authors, onDelete: cascade }
`;
    expect(lintSpecWarnings(parseOk(yaml))).toEqual([]);
  });

  it('does NOT fire for a SELF-referencing FK (a self-FK applies after its own CREATE)', () => {
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
    expect(lintSpecWarnings(parseOk(yaml))).toEqual([]);
  });
});

describe('lintSpecWarnings — typescript_handler_module (a handler module the deploy loader refuses)', () => {
  /**
   * A backend doc with ONE handler whose module path carries the given extension. The handler id
   * shares NO token with the module path on purpose: a message that dropped the id would otherwise
   * still satisfy an id assertion through the path, and the whole point of the advisory on a
   * multi-handler document is saying WHICH handler is at fault.
   */
  const handlerSpec = (modulePath: string) => `
version: '1.0'
metadata:
  name: ts-handler
handlers:
  - { id: catalog_sync, module: ${modulePath}, export: run, kind: tool }
`;

  it.each([
    ['handlers/lookup.ts', '.ts'],
    ['handlers/lookup.tsx', '.tsx'],
    ['handlers/lookup.mts', '.mts'],
    ['handlers/lookup.cts', '.cts'],
  ])('FIRES for a TypeScript-source handler module (%s) — and the doc still parses ok', (modulePath, ext) => {
    const value = parseOk(handlerSpec(modulePath)); // still valid — a warning is not an error
    const warnings = lintSpecWarnings(value);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('typescript_handler_module');
    expect(warnings[0]?.path).toBe('handlers[0].module');
    // Names the handler, the offending path and the extension that made it one, and points at
    // BOTH documented ways out.
    expect(warnings[0]?.message).toContain('catalog_sync');
    expect(warnings[0]?.message).toContain(modulePath);
    expect(warnings[0]?.message).toContain(`('${ext}')`);
    expect(warnings[0]?.message).toContain('build.mjs');
    expect(warnings[0]?.message).toContain('rayspec gen-handler --emit js');
  });

  it('FIRES for an UPPERCASE TypeScript extension — the match is case-INSENSITIVE', () => {
    // The same pin the loader's reject-set carries for `X.TS`: the deploy loader refuses the module
    // on a case-insensitive extension match, so an advisory that only recognised lowercase would let
    // `handlers/lookup.TS` lint green and abort at boot — the exact dead end this rule exists to
    // close. FAIL-THE-FIX: drop the case fold from the advisory's extension match and this arm flips.
    const warnings = lintSpecWarnings(parseOk(handlerSpec('handlers/lookup.TS')));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe('typescript_handler_module');
    expect(warnings[0]?.path).toBe('handlers[0].module');
    // The message quotes the module path AS AUTHORED and reports the extension case-folded.
    expect(warnings[0]?.message).toContain('handlers/lookup.TS');
    expect(warnings[0]?.message).toContain("('.ts')");
  });

  it.each([
    'handlers/lookup.js',
    'handlers/lookup.mjs',
    'handlers/lookup.cjs',
  ])('does NOT fire for a compiled JavaScript handler module (%s)', (modulePath) => {
    expect(lintSpecWarnings(parseOk(handlerSpec(modulePath)))).toEqual([]);
  });

  it('does NOT fire for an `extensions[].module` path — that field is a pack DIRECTORY, out of scope', () => {
    // The rule is scoped to `handlers[]`. `extensions[].module` is a pack ROOT DIRECTORY reference (the
    // extension loader jails it as the root and appends its own entry file inside it), so it carries no
    // authored module extension for this rule to read. A `.ts` there is a mis-declared directory the
    // loader rejects fail-closed at boot with its own message — a different defect, not this advisory's.
    // The fixture keeps the `.ts` shape on purpose: it is the one that would fire if the rule ever
    // widened past `handlers[]`, so this arm stays the scope guard rather than a tautology.
    const yaml = `
version: '1.0'
metadata:
  name: ts-extension
extensions:
  - { id: pack, module: ./packs/notes/index.ts, version: 1.0.0 }
`;
    expect(lintSpecWarnings(parseOk(yaml))).toEqual([]);
  });

  it('fires ONCE PER TypeScript handler, pinning each handler index', () => {
    // TWO offending handlers around a compiled one: a rule that fired once per DOCUMENT would report
    // only the first and leave the second dead end invisible, so the count is asserted as well as
    // both indices.
    const yaml = `
version: '1.0'
metadata:
  name: ts-handlers
handlers:
  - { id: billing_export, module: handlers/compiled.js, export: run, kind: tool }
  - { id: catalog_reindex, module: handlers/source.gen.ts, export: run, kind: route }
  - { id: digest_rollup, module: handlers/other.mts, export: run, kind: tool }
`;
    const warnings = lintSpecWarnings(parseOk(yaml));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.code).toBe('typescript_handler_module');
    expect(warnings[0]?.path).toBe('handlers[1].module');
    expect(warnings[1]?.code).toBe('typescript_handler_module');
    expect(warnings[1]?.path).toBe('handlers[2].module');
    // Each warning names ITS OWN handler AND ITS OWN module path (ids disjoint from the paths) — the
    // advisory's whole job on a multi-handler document is saying which one is the dead end and which
    // file to fix, so a message built from the FIRST handler must not satisfy either half.
    expect(warnings[0]?.message).toContain('catalog_reindex');
    expect(warnings[0]?.message).toContain('handlers/source.gen.ts');
    expect(warnings[1]?.message).toContain('digest_rollup');
    expect(warnings[1]?.message).toContain('handlers/other.mts');
  });
});
