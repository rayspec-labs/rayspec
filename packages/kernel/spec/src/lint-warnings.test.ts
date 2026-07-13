/**
 * `lintSpecWarnings` — the NON-FATAL advisory pass. A warning is surfaced (doctor/plan) but never
 * fails a parse. These tests pin the ONE interaction it flags today: a `softDelete` store that is the
 * TARGET of a `restrict` business-key (`referencesColumn`) foreign key — soft-deleting such a parent is
 * an `UPDATE(deleted_at)` that does NOT fire the database ON DELETE restrict, so children keep pointing
 * at the tombstoned row.
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

  it('does NOT fire for an ID-TARGET restrict FK (the warning is scoped to business-key FKs)', () => {
    // No referencesColumn ⇒ an id-target FK; the local column must be uuid to parse.
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
    expect(lintSpecWarnings(parseOk(yaml))).toEqual([]);
  });
});
