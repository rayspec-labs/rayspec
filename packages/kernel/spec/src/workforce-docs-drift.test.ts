/**
 * The spec reference's workforce section is DRIFT-LOCKED onto the code, two ways:
 *
 *   - the worked example is the starter example file's own `workforce:` block, byte-for-byte —
 *     the block is deliberately that file's final top-level section, so the comparison is a
 *     clean suffix, and a divergence means either the docs or the shipped example lied;
 *   - the documented validation-code list is set-compared against a literal vocabulary whose
 *     every member must exist in `SpecErrorCode` — a renamed code breaks the test, and the doc
 *     can never list a code the parser does not emit.
 *
 * KNOWN GAP, recorded rather than glossed: a BRAND-NEW workforce code added to `SpecErrorCode`
 * is not auto-detected here (codes carry no `workforce_` prefix to derive the subset from — the
 * section reuses shared codes like `duplicate_name` on purpose). The compensating control is the
 * lint module's own header checklist, which enumerates its rules in checked order; adding a rule
 * there without touching the doc list below is the review finding this comment exists to cause.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SpecErrorCode } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, `../../../../${rel}`), 'utf8');

/** The codes the workforce section documents. LITERAL on purpose — see the header. */
const DOCUMENTED_WORKFORCE_CODES = new Set([
  'experimental_section_disabled',
  'invalid_orchestrator',
  'invalid_manager',
  'manager_in_members',
  'department_mismatch',
  'reporting_cycle',
  'orphan_employee',
  'invalid_reviewer',
  'budget_widening',
  'reserved_workforce_id',
  'reserved_tool_name',
]);

describe('the spec reference workforce section', () => {
  it('quotes the starter example workforce block byte-for-byte', () => {
    const page = read('docs/spec-reference.md');
    const anchor = 'byte-for-byte — the block is deliberately that file';
    const anchorAt = page.indexOf(anchor);
    expect(anchorAt, 'the worked-example anchor sentence moved or was reworded').toBeGreaterThan(
      -1,
    );
    const fenceOpen = page.indexOf('```yaml\n', anchorAt);
    expect(fenceOpen, 'no yaml fence follows the worked-example anchor').toBeGreaterThan(-1);
    const fenceClose = page.indexOf('\n```', fenceOpen + 8);
    const quoted = page.slice(fenceOpen + '```yaml\n'.length, fenceClose + 1);

    const starter = read('examples/workforce-starter/rayspec.yaml');
    const blockAt = starter.indexOf('\nworkforce:\n');
    expect(
      blockAt,
      "the starter example no longer carries a top-level 'workforce:' block",
    ).toBeGreaterThan(-1);
    const suffix = starter.slice(blockAt + 1);
    // The suffix contract: nothing may follow the workforce block in the starter file, or the
    // quote below it stops being a clean byte comparison. The failure IS the message.
    expect(
      quoted,
      "the doc's worked example diverged from examples/workforce-starter/rayspec.yaml — " +
        'either update the doc fence, or keep the workforce: block the FINAL section of the file',
    ).toBe(suffix);
  });

  it('documents exactly the workforce validation codes, each one a real SpecErrorCode', () => {
    const page = read('docs/spec-reference.md');
    const after = page.split('The workforce validation codes are:')[1];
    expect(after, 'the validation-codes anchor sentence moved or was reworded').toBeDefined();
    // Exactly the list that FOLLOWS the anchor: the prose after it names shared codes again as
    // examples, and a wider window would quietly repair a list with a member missing from it.
    const listParagraph = (after as string).trimStart().split('\n\n')[0] as string;
    const listed = new Set(
      [...listParagraph.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1] as string),
    );
    expect(listed).toEqual(DOCUMENTED_WORKFORCE_CODES);
    for (const code of DOCUMENTED_WORKFORCE_CODES) {
      expect(SpecErrorCode.options, `documented code '${code}' is not a SpecErrorCode`).toContain(
        code,
      );
    }
  });
});
