/**
 * `parseProductSpec` — the two-phase, fail-closed Product-YAML entry point: raw YAML text →
 * a validated `ProductSpec` or the FULL list of `SpecError`s. Mirrors `parseSpec` (parse.ts) for the
 * RaySpec family; the two are dispatched by document kind in `detect.ts`.
 *
 * Pipeline (each stage aggregates; the value is NEVER returned partially):
 *   1. YAML safe-load       — `yaml@2.9.0` `parse()` (safe by default). A syntax error → `yaml_parse_error`.
 *   2. VERSION CHECK FIRST   — a product document declares `version:'1.0'` with a `product:` section;
 *                              a missing/unsupported version → one clean `unsupported_version`.
 *   3. NO-CODE GUARDRAILS    — `scanProductGuardrails` over the RAW object: specific,
 *                              explaining `no_code_in_yaml`/`provider_native_leak` errors. If ANY fire,
 *                              they are returned WITHOUT running the shape/lint passes — a doc smuggling
 *                              code/handlers/provider blobs is categorically rejected; shape-checking the
 *                              rest proves nothing (and the guardrail message is the actionable one).
 *   4. STRICT ZOD PARSE      — `ProductSpec.safeParse`. Every Zod issue → a `SpecError` (unknown key →
 *                              `unknown_field`, else `schema_violation`). Returns the FULL issue list.
 *   5. SEMANTIC LINT         — `lintProductSpec` (cross-refs, dups, capability status, contract vocab).
 *                              Only run when the shape parse SUCCEEDS.
 */
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { type Result, type SpecError, specError } from './errors.js';
import { SPEC_VERSION } from './grammar.js';
import { ProductSpec } from './product-grammar.js';
import { lintProductSpec, scanProductGuardrails } from './product-lint.js';

/** Render a Zod issue path as a JSON path (identical convention to parse.ts). */
function renderPath(path: ReadonlyArray<PropertyKey>): string | undefined {
  if (path.length === 0) return undefined;
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length === 0 ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

function joinKey(base: string | undefined, key: string): string {
  return base === undefined ? key : `${base}.${key}`;
}

/** Map a single Zod issue to one or more SpecErrors (an unrecognized-keys issue fans out per key). */
function issueToSpecErrors(issue: z.core.$ZodIssue): SpecError[] {
  const base = renderPath(issue.path);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) =>
      specError(
        'unknown_field',
        `unknown field '${key}' (unknown keys are rejected)`,
        joinKey(base, key),
      ),
    );
  }
  return [specError('schema_violation', issue.message, base)];
}

/**
 * Parse + validate a raw Product-YAML spec. Returns the typed `ProductSpec` on success, or the FULL
 * aggregated list of fail-closed violations.
 */
export function parseProductSpec(rawYamlText: string): Result<ProductSpec, SpecError> {
  // ---- 1. YAML SAFE-LOAD ----------------------------------------------------------------
  let loaded: unknown;
  try {
    loaded = parseYaml(rawYamlText);
  } catch (e) {
    return {
      ok: false,
      errors: [
        specError(
          'yaml_parse_error',
          `YAML parse error: ${String(e instanceof Error ? e.message : e)}`,
        ),
      ],
    };
  }

  if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return {
      ok: false,
      errors: [
        specError(
          'unsupported_version',
          'spec root must be a mapping with a `version` field (got an empty or non-object document)',
        ),
      ],
    };
  }

  // ---- 2. VERSION CHECK FIRST -----------------------------------------------------------
  // A product document declares exactly `version:'1.0'` with a `product:` section; anything else fails
  // closed with a single clean `unsupported_version` SpecError before the strict-shape parse runs.
  const doc = loaded as Record<string, unknown>;
  const version = doc.version;
  if (version !== SPEC_VERSION) {
    let message: string;
    if (version === undefined) {
      message =
        `product version is missing; a product document declares version '${SPEC_VERSION}' with a ` +
        '`product:` section';
    } else if (typeof version !== 'string') {
      message =
        `product version must be the quoted string '${SPEC_VERSION}' ` +
        `(got the YAML ${typeof version} ${String(version)} — wrap it in quotes)`;
    } else {
      message =
        `unsupported product version '${version}'; a product document declares version '${SPEC_VERSION}' ` +
        'with a `product:` section';
    }
    return {
      ok: false,
      errors: [specError('unsupported_version', message, 'version')],
    };
  }

  // ---- 3. NO-CODE GUARDRAILS (raw scan; short-circuit on any hit) -----------------------
  const guardrailErrors = scanProductGuardrails(loaded);
  if (guardrailErrors.length > 0) {
    return { ok: false, errors: guardrailErrors };
  }

  // ---- 4. STRICT ZOD PARSE (full issue list) --------------------------------------------
  const parsed = ProductSpec.safeParse(loaded);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.flatMap(issueToSpecErrors) };
  }

  // ---- 5. SEMANTIC LINT -----------------------------------------------------------------
  const lintErrors = lintProductSpec(parsed.data);
  if (lintErrors.length > 0) {
    return { ok: false, errors: lintErrors };
  }

  return { ok: true, value: parsed.data };
}
