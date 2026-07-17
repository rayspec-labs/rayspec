import { tokenRunSubset } from '@rayspec/core';
import type { CapabilityInvocationResult, CapabilityNodeHandler } from '@rayspec/foundation';
import type {
  GroundingChecker,
  GroundingCheckInput,
  GroundingCheckNodeOptions,
  GroundingCheckResult,
  GroundingFinding,
  GroundingReference,
} from './types.js';

/**
 * Read the closed span TEXTS from a source-artifact content envelope: `{ spans: { id, text }[] }`.
 * Any other shape (null, an array, a bare object) yields an EMPTY map — so a quote check over it is
 * fail-closed UNSUPPORTED, never a silent pass on a malformed/absent span-text carrier.
 */
function spanTextMap(content: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return out;
  const spans = (content as { spans?: unknown }).spans;
  if (!Array.isArray(spans)) return out;
  for (const s of spans) {
    if (s === null || typeof s !== 'object') continue;
    const id = (s as { id?: unknown }).id;
    const text = (s as { text?: unknown }).text;
    if (typeof id === 'string' && typeof text === 'string') out.set(id, text);
  }
  return out;
}

export const GROUNDING_CHECK_OPERATION = 'grounding.check';

export function createGroundingCheckNode(
  options: GroundingCheckNodeOptions = {},
): GroundingChecker {
  return options.checker ?? closedReferenceGroundingChecker;
}

export function createGroundingCheckHandler(
  options: GroundingCheckNodeOptions = {},
): CapabilityNodeHandler {
  const checker = createGroundingCheckNode(options);
  return async ({ input, step }): Promise<CapabilityInvocationResult> => {
    const result = await checker(input as unknown as GroundingCheckInput);
    return {
      status: 'completed',
      artifact_refs: [
        {
          id: `${step.id}:grounding_result`,
          kind: 'grounding.result',
          source_node_id: step.id,
          value: result,
        },
      ],
      output: result,
    };
  };
}

export function closedReferenceGroundingChecker(input: GroundingCheckInput): GroundingCheckResult {
  const allowed = new Set(input.closed_reference_ids);
  const corrected: GroundingReference[] = [];
  const dropped: GroundingReference[] = [];
  const findings: GroundingFinding[] = [];

  if (input.references.length === 0) {
    findings.push({
      code: 'empty_evidence',
      message: 'Candidate artifact did not provide grounding references.',
      path: '$.references',
    });
  }

  for (const reference of input.references) {
    if (allowed.has(reference.id)) {
      corrected.push(reference);
      continue;
    }
    dropped.push(reference);
    findings.push({
      code: 'unknown_reference',
      message: `Reference '${reference.id}' is not present in the closed source set.`,
      path: '$.references',
      reference_id: reference.id,
    });
  }

  // OPT-IN quote-text verification. When a verbatim quote is supplied, it must appear as a token-run
  // subset in the TEXT of at least ONE cited, in-closed-set span (per-span, NEVER the concatenation of
  // spans — concatenation would admit a contiguous run that was never spoken in one span). No cited
  // span supports it ⇒ the claim is unsupported (a real span id with fabricated wording). Fail-closed:
  // an empty span-text map (missing/malformed carrier) yields no support, so the claim is UNSUPPORTED.
  //
  // The empty-string skip (`length > 0`) is DELIBERATE, and is NOT a bypass: an ABSENT quote is not the
  // same as a FABRICATED one, so a checker with no quote to verify emits no unsupported finding. An
  // EMPTY/blank quote never reaches this branch as a silent pass in the product pipeline — the
  // materializer (`applyGroundingPolicy`) classifies an absent/empty/blank/whitespace-only quote_field
  // value as a `missingQuote` and applies the declared `on_unquoted_claim` consequence (prune/drop/fail/
  // ignore) directly, and it passes a quote to this checker ONLY when it is a non-blank string. So the
  // enforcement of empty quotes lives THERE; this guard is the matching defense-in-depth for a direct
  // caller.
  if (typeof input.quote === 'string' && input.quote.length > 0) {
    const quote = input.quote;
    const texts = spanTextMap(input.source_artifact.content);
    const supported = corrected.some((r) => {
      const text = texts.get(r.id);
      return typeof text === 'string' && tokenRunSubset(quote, text);
    });
    if (!supported) {
      findings.push({
        code: 'unsupported_claim',
        message: 'The cited quote is not a verbatim token-run subset of any cited source span.',
        path: '$.quote',
      });
    }
  }

  return {
    verdict: findings.length === 0 ? 'grounded' : 'ungrounded',
    findings,
    corrected_references: corrected,
    dropped_references: dropped,
  };
}
