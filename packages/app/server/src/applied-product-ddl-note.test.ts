/**
 * The note a fail-closed refusal carries when the SAME boot already applied product-store DDL.
 *
 * Pure unit coverage of both arms of `appliedProductDdlBootNote` + the in-place attachment:
 *   - NOTHING applied (every refusal raised BEFORE the migrate step) → EMPTY: the boot must never
 *     tell an operator their schema sits in a committed mid-state when it does not.
 *   - something applied → the sentence, naming the migrations, the store tables, and the recovery.
 *   - the attachment keeps the error's CLASS (the CLI + `rayspec-serve` printers switch on
 *     `instanceof`, so a re-wrap would change how the refusal prints and double its prefix), never
 *     says it twice, and leaves a message that already states the fact alone.
 */
import { describe, expect, it } from 'vitest';
import { BootConfigError } from './boot-config-error.js';
import { appliedProductDdlBootNote, attachAppliedProductDdlNote } from './composition-root.js';

/** The first-materialization migration the deployers plan for a clean database. */
const MATERIALIZE = '0000_product_stores.sql';

describe('appliedProductDdlBootNote', () => {
  it('is EMPTY when the boot applied no migration (a pre-migrate refusal leaves nothing behind)', () => {
    // The predicate is what was APPLIED, not what was planned: a boot that planned this exact
    // migration and then refused at validate / unsupported_spec / lint-gate applied nothing.
    expect(appliedProductDdlBootNote([], ['notes', 'entries'])).toBe('');
  });

  it('names the applied migrations, the store tables, and the forward-fix recovery', () => {
    const note = appliedProductDdlBootNote([MATERIALIZE], ['notes', 'entries']);
    expect(note).toContain('ALREADY COMMITTED');
    expect(note).toContain(MATERIALIZE);
    expect(note).toContain('notes, entries');
    // What is true about them, and what the next deploy does with them.
    expect(note).toContain('EMPTY');
    expect(note).toContain('MOUNTS');
    // Recovery is a reviewed forward migration — the escape the drift refusals already name.
    expect(note).toContain('rayspec plan <new-spec> --against <old-spec>');
    expect(note).toContain('rayspec deploy --apply-migration <delta.sql>');
    // The local remedy is named WITH its real blast radius (it is not a table-level cleanup).
    expect(note).toContain('rayspec dev db --reset --yes');
    expect(note).toContain('_dbos_sys');
  });

  it('counts every applied migration (the multi-migration update case needs no extra branch)', () => {
    const note = appliedProductDdlBootNote(['0006_good.sql', '0007_more.sql'], ['notes']);
    expect(note).toContain('2 migration(s)');
    expect(note).toContain('0006_good.sql, 0007_more.sql');
  });

  it('omits the table sentence when the deployment declares no store', () => {
    const note = appliedProductDdlBootNote([MATERIALIZE], []);
    expect(note).toContain('ALREADY COMMITTED');
    expect(note).not.toContain('materialize are');
  });
});

describe('attachAppliedProductDdlNote', () => {
  it('appends the note IN PLACE and hands back the SAME error object, class intact', () => {
    const err = new BootConfigError('Boot aborted — something. Fail-closed.');
    const returned = attachAppliedProductDdlNote(err, [MATERIALIZE], ['notes']);
    expect(returned).toBe(err);
    expect(returned).toBeInstanceOf(BootConfigError);
    expect(err.message).toBe(
      `Boot aborted — something. Fail-closed.\n${appliedProductDdlBootNote([MATERIALIZE], ['notes'])}`,
    );
  });

  it('leaves the message untouched when the boot applied nothing', () => {
    const err = new BootConfigError('Boot aborted — something. Fail-closed.');
    const before = err.message;
    attachAppliedProductDdlNote(err, [], ['notes']);
    expect(err.message).toBe(before);
  });

  it('says it ONCE: a second attachment to the same error is a no-op', () => {
    const err = new BootConfigError('Boot aborted — something. Fail-closed.');
    attachAppliedProductDdlNote(err, [MATERIALIZE], ['notes']);
    const once = err.message;
    attachAppliedProductDdlNote(err, [MATERIALIZE], ['notes']);
    expect(err.message).toBe(once);
  });

  it('leaves a refusal that ALREADY states the fact alone (the post-UPDATE drift gates do)', () => {
    // Verbatim from the drift gate's own paragraph — the reason the attachment is keyed on the
    // phrase rather than on the note it would add.
    const driftGate =
      'IMPORTANT — the delta migration(s) are ALREADY COMMITTED: deploy() applies each migration in ' +
      'its own transaction and this drift check fires POST-migrate, so the schema is now in a ' +
      'partially-evolved MID-STATE.';
    const err = new BootConfigError(driftGate);
    attachAppliedProductDdlNote(err, [MATERIALIZE], ['notes']);
    expect(err.message).toBe(driftGate);
  });

  it('returns a non-Error rejection unchanged (nothing to append to)', () => {
    const thrown = { not: 'an error' };
    expect(attachAppliedProductDdlNote(thrown, [MATERIALIZE], ['notes'])).toBe(thrown);
  });
});
