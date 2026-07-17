/**
 * Focused unit coverage for the OPT-IN quote-text branch of `closedReferenceGroundingChecker`
 * (grounding.ts). Exercises the checker DIRECTLY (no runtime/product wrapper) over the three
 * quote outcomes:
 *   (a) a quote that IS a token-run subset of a cited span's text  → NO unsupported_claim finding;
 *   (b) a quote that is NOT a subset of any cited span             → an unsupported_claim at $.quote;
 *   (c) an EMPTY quote ("")                                        → SKIPPED (no finding — the
 *       deliberate empty-skip: an absent/empty quote is not a fabricated one).
 *
 * Fail-the-fix: case (b) fails RED if the quote-subset check is weakened (an invented quote would
 * then produce no finding); case (a)/(c) fail RED if a false unsupported_claim is raised.
 */
import { describe, expect, it } from 'vitest';
import { closedReferenceGroundingChecker } from './grounding.js';
import type { GroundingCheckInput } from './types.js';

const SPAN_TEXT = 'we shipped the release on friday';

function checkWithQuote(quote?: string): ReturnType<typeof closedReferenceGroundingChecker> {
  const input: GroundingCheckInput = {
    source_artifact: {
      kind: 'source.spans',
      content: { spans: [{ id: 'sp-1', text: SPAN_TEXT }] },
    },
    candidate_artifact: { kind: 'candidate.excerpt', content: {} },
    references: [{ id: 'sp-1' }],
    closed_reference_ids: ['sp-1'],
    ...(quote !== undefined ? { quote } : {}),
  };
  return closedReferenceGroundingChecker(input);
}

describe('closedReferenceGroundingChecker — opt-in quote-text branch', () => {
  it('(a) a quote that IS a token-run subset of a cited span raises NO unsupported_claim', () => {
    const result = checkWithQuote('shipped the release');
    expect(result.findings.some((f) => f.code === 'unsupported_claim')).toBe(false);
    expect(result.verdict).toBe('grounded');
  });

  it('(b) a quote that is NOT a subset of any cited span raises unsupported_claim at $.quote', () => {
    const result = checkWithQuote('cancelled the release entirely');
    const finding = result.findings.find((f) => f.code === 'unsupported_claim');
    expect(finding).toBeDefined();
    expect(finding?.path).toBe('$.quote');
    expect(result.verdict).toBe('ungrounded');
  });

  it('(c) an EMPTY quote is SKIPPED — the deliberate empty-skip raises no finding', () => {
    const result = checkWithQuote('');
    expect(result.findings.some((f) => f.code === 'unsupported_claim')).toBe(false);
    expect(result.verdict).toBe('grounded');
  });
});
