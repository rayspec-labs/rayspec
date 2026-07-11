/**
 * Document-kind detection + a unified validator.
 *
 * RaySpec is ONE declarative language — `version: '1.0'` — with two PROFILES, told apart by the
 * presence of the `product:` archetype discriminant:
 *   • RaySpec (backend profile)  — a `version:'1.0'` doc with NO `product:` section (grammar.ts /
 *                                       parse.ts) — the low-level surface AND the internal engine target.
 *   • Product-YAML (product profile)  — a `version:'1.0'` doc that carries the required `product:`
 *                                       section (product-grammar.ts / product-parse.ts) — the
 *                                       high-level product-meaning surface that lowers to the backend.
 *
 * `detectSpecKind` keys on `version:'1.0'` + `product:` presence: a doc that carries a top-level
 * `product:` section is the product profile, else the backend profile. A YAML parse/shape failure is
 * reported as `unknown` so the caller can surface a clean error.
 */
import { parse as parseYaml } from 'yaml';
import type { Result, SpecError } from './errors.js';
import { type RaySpec, SPEC_VERSION } from './grammar.js';
import { parseSpec } from './parse.js';
import type { ProductSpec } from './product-grammar.js';
import { parseProductSpec } from './product-parse.js';

/** Which document PROFILE a raw YAML string is. `unknown` = not parseable to an object root. */
export type SpecKind = 'rayspec' | 'product' | 'unknown';

/**
 * Detect the document profile. A `version:'1.0'` doc is the PRODUCT profile iff it carries a top-level
 * `product:` section, else the BACKEND profile. Any other object root (a version-less doc, or one with
 * an unsupported version) → the backend parser, which fails closed there with a clean
 * `unsupported_version`. Fail-closed: a non-object / unparseable root → `unknown`.
 */
export function detectSpecKind(rawYamlText: string): SpecKind {
  let loaded: unknown;
  try {
    loaded = parseYaml(rawYamlText);
  } catch {
    return 'unknown';
  }
  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) return 'unknown';
  const doc = loaded as Record<string, unknown>;
  // version:'1.0' + the `product:` discriminant selects the product profile; everything else is backend.
  if (doc.version === SPEC_VERSION && 'product' in doc) return 'product';
  return 'rayspec';
}

/** A validate-only envelope for callers (doctor/plan/deploy) that only need the fail-closed verdict. */
export interface ValidateResult {
  readonly ok: boolean;
  readonly kind: SpecKind;
  readonly errors: SpecError[];
}

/**
 * Validate a raw spec of EITHER family, collapsing to `{ ok, kind, errors }`. Routes to the correct
 * parser by `detectSpecKind`. An `unknown` root is routed to `parseSpec` so its existing
 * `unsupported_version`/`yaml_parse_error` message is preserved (no behavior change for RaySpec).
 */
export function validateAnySpec(rawYamlText: string): ValidateResult {
  const kind = detectSpecKind(rawYamlText);
  if (kind === 'product') {
    const res = parseProductSpec(rawYamlText);
    return res.ok ? { ok: true, kind, errors: [] } : { ok: false, kind, errors: res.errors };
  }
  const res = parseSpec(rawYamlText);
  return res.ok
    ? { ok: true, kind: 'rayspec', errors: [] }
    : { ok: false, kind: 'rayspec', errors: res.errors };
}

/**
 * A discriminated parse result carrying the typed value of whichever family the doc is. Callers that
 * need the parsed value (not just the verdict) use this. `unknown`/`rayspec` roots parse as RaySpec.
 */
export type AnySpecParse =
  | { readonly ok: true; readonly kind: 'rayspec'; readonly spec: RaySpec }
  | { readonly ok: true; readonly kind: 'product'; readonly spec: ProductSpec }
  | { readonly ok: false; readonly kind: SpecKind; readonly errors: SpecError[] };

/** Parse a raw spec of either family, returning the typed value on success. */
export function parseAnySpec(rawYamlText: string): AnySpecParse {
  const kind = detectSpecKind(rawYamlText);
  if (kind === 'product') {
    const res: Result<ProductSpec, SpecError> = parseProductSpec(rawYamlText);
    return res.ok
      ? { ok: true, kind: 'product', spec: res.value }
      : { ok: false, kind: 'product', errors: res.errors };
  }
  const res: Result<RaySpec, SpecError> = parseSpec(rawYamlText);
  return res.ok
    ? { ok: true, kind: 'rayspec', spec: res.value }
    : { ok: false, kind: 'rayspec', errors: res.errors };
}
