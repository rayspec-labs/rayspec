/**
 * `rayspec doctor <spec.yaml>` — the STATIC validity check (no Postgres, no network).
 *
 * Wraps the already-shipped `parseSpec` (which itself runs the strict Zod parse + `lintSpec` as its
 * lint stage — see packages/kernel/spec/src/parse.ts) and emits its result as a stable JSON envelope:
 *
 *     { "ok": true,  "errors": [] }                                  // exit 0
 *     { "ok": false, "errors": [{ code, message, path? }, ...] }     // exit 1
 *
 * This is the `terraform validate` floor an authoring skill iterates against: a fast, deterministic,
 * machine-parseable "is this spec well-formed?" with the FULL fail-closed violation list (the validator
 * aggregates every problem, never just the first). NO new mechanism — `doctor` adds only argv/IO
 * plumbing around the existing validator. NO secret can appear in the output: the only inputs are the
 * operator-supplied path (echoed in a read error) and the spec's own validation errors.
 *
 * `doctor` validates BOTH profiles of the `version:'1.0'` language via `validateAnySpec`, which
 * dispatches on the `product:` discriminant (a `product:` section → the product profile; absent → the
 * backend profile). So `doctor <product>.yaml` fully validates a product doc's sections (product/
 * requires/capabilities/artifacts/contracts/extractors/workflows/grounding/views), not just a backend doc.
 */
import { type SpecError, validateAnySpec } from '@rayspec/spec';
import { ReadSpecError, readSpecFile, resolveSpecPath } from './read-spec.js';

/** The `doctor` JSON result. Mirrors `parseSpec`'s `{ ok, errors }` shape exactly. */
export interface DoctorResult {
  readonly ok: boolean;
  readonly errors: SpecError[];
}

/**
 * Run `doctor` over the positional args. Reads the spec fail-closed, runs `parseSpec`, and returns
 * the `{ ok, errors }` result. A spec-read failure (missing/escape/oversized/not-a-file) is mapped to
 * a single SpecError-shaped entry with code `yaml_parse_error` so the envelope is uniform (the closed
 * SpecError vocabulary has no "io" code; a read failure is surfaced as the document being unreadable).
 * NEVER throws for an invalid spec — only `ok:false`.
 */
export async function runDoctor(positionals: readonly string[]): Promise<DoctorResult> {
  let text: string;
  try {
    const path = resolveSpecPath(positionals);
    text = await readSpecFile(path);
  } catch (e) {
    if (e instanceof ReadSpecError) {
      return { ok: false, errors: [{ code: 'yaml_parse_error', message: e.message }] };
    }
    throw e;
  }

  const result = validateAnySpec(text);
  if (result.ok) return { ok: true, errors: [] };
  return { ok: false, errors: result.errors };
}
