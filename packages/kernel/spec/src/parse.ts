/**
 * `parseSpec` — the two-phase, fail-closed entry point: raw YAML text -> a validated
 * `RaySpec` or the FULL list of `SpecError`s.
 *
 * Pipeline (each stage aggregates, never throws to the caller):
 *   1. YAML safe-load       — `yaml@2.9.0` `parse()` (safe by default: no code execution,
 *                             no JS-type tags). A YAML syntax error -> one `yaml_parse_error`.
 *   2. VERSION CHECK FIRST   — before the full strict Zod parse, read `version` off the loaded
 *                             object. A missing/unsupported version -> one clean
 *                             `unsupported_version` SpecError, NOT a wall of strict-shape errors.
 *  2b. EXPERIMENTAL GATE     — a `workforce:` key of any shape without the caller's opt-in -> one
 *                             `experimental_section_disabled`. Raw-document, pre-shape, same
 *                             two-phase reason as the version check.
 *  2c. ZERO-OR-ONE WORKFORCE — `scanMultipleWorkforces` over the RAW object: a LIST under
 *                             `workforce:` or a plural `workforces:` key -> one
 *                             `multiple_workforces` naming the rule (D-010). After the gate so a
 *                             non-opted-in caller still sees only the gate's refusal.
 *   3. RESERVED DOCUMENT KEY — `scanReservedDocumentKeys` over the RAW loaded object: a mapping key
 *                             named `__proto__` is refused HERE or nowhere, for two different
 *                             reasons. Where the shape parse validates keys, it skips this one BY
 *                             NAME — a strict `z.object` accepts it and raises no
 *                             `unrecognized_keys` issue. Where the grammar is free-form
 *                             (`z.unknown()`), it inspects no key at all. Either way this pass is
 *                             the only one that can see it. Short-circuits like the version check:
 *                             the document the shape parse would read is not the document the author
 *                             wrote, so its issues would be reported against a different document.
 *   4. STRICT ZOD PARSE      — `RaySpec.safeParse`. EVERY Zod issue maps to a SpecError with
 *                             a JSON path; an `unrecognized_keys` issue -> `unknown_field` (one per
 *                             offending key), everything else -> `schema_violation`. Returns the
 *                             FULL issue list.
 *   5. SEMANTIC LINT         — `lintSpec` (cross-refs, dups, capability, embedded schemas). Only
 *                             run when the shape parse SUCCEEDS (lint needs a typed spec).
 *
 * Any non-empty error list -> `{ ok:false, errors }` (the value is NEVER returned partially).
 */
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { scanReservedDocumentKeys } from './document-keys.js';
import { type Result, type SpecError, specError } from './errors.js';
import { RaySpec, SPEC_VERSION } from './grammar.js';
import { lintSpec } from './lint.js';

/** Render a Zod issue path (string/number segments) as a JSON path: `agents[0].backend`. */
function renderPath(path: ReadonlyArray<PropertyKey>): string | undefined {
  if (path.length === 0) return undefined;
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      out += out.length === 0 ? String(seg) : `.${String(seg)}`;
    }
  }
  return out;
}

/** Append a key to a (possibly empty) base JSON path. */
function joinKey(base: string | undefined, key: string): string {
  return base === undefined ? key : `${base}.${key}`;
}

/** Map a single Zod issue to one or more SpecErrors (an unrecognized-keys issue fans out per key). */
function issueToSpecErrors(issue: z.core.$ZodIssue): SpecError[] {
  const base = renderPath(issue.path);
  if (issue.code === 'unrecognized_keys') {
    // Fail-closed unknown-key rejection — one SpecError per offending key, pathed at the key.
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
 * D-010, raised as a NAMED rule: a document declares exactly zero or one workforce, and
 * `workforce:` is a single mapping. Two author spellings reach for more than one and are refused
 * here — a LIST under `workforce:`, and a plural `workforces:` key (with or without a singular
 * sibling: an author who wrote only `workforces:` believed the plural form existed, and
 * `unknown_field` does not tell them otherwise).
 *
 * A one-element list is refused too: accepting it would mint a second legal spelling for the one
 * shape. Two literal `workforce:` keys and multi-document streams stay with `yaml_parse_error` —
 * the `yaml` library refuses both before this code runs, and re-coding its refusal would mean
 * pattern-matching a library error string; `workforce-parse.negative.test.ts` pins that behavior
 * instead, so a future `yaml` upgrade that softened `uniqueKeys` fails loudly.
 *
 * The constraint is on AUTHORING only. Storage is already keyed per workforce id
 * (`workforce_runtime` rows are `(tenant, workforce_id)`), so relaxing this later is a grammar
 * change, not a migration.
 */
function scanMultipleWorkforces(doc: Record<string, unknown>): SpecError | null {
  const found =
    'workforces' in doc
      ? { what: "'workforces' as a top-level key", path: 'workforces' }
      : Array.isArray(doc.workforce)
        ? { what: "a list under 'workforce:'", path: 'workforce' }
        : null;
  if (found === null) return null;
  return specError(
    'multiple_workforces',
    "a RaySpec document declares exactly zero or one workforce, and 'workforce:' is a single " +
      `mapping — not a list and not a plural collection. Found ${found.what}. Merge the ` +
      "declarations into one 'workforce:' block, or split them across separate documents (each " +
      'deployment runs one workforce). This is a limitation of the experimental release, not a ' +
      'permanent one',
    found.path,
  );
}

/** The caller-decided options `parseSpec` accepts. */
export interface ParseSpecOptions {
  /**
   * Opt-in for the EXPERIMENTAL `workforce:` section. Absent/false ⇒ a document declaring it is
   * rejected with `experimental_section_disabled` — fail-closed for every entry point that has not
   * decided (the safe default a forgotten call site inherits).
   */
  readonly experimentalWorkforce?: boolean;
}

/**
 * Parse + validate a raw RaySpec YAML spec. Returns the typed spec on success, or the FULL
 * aggregated list of fail-closed violations.
 */
export function parseSpec(
  rawYamlText: string,
  options: ParseSpecOptions = {},
): Result<RaySpec, SpecError> {
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

  // An empty document (`null`) or a non-object root cannot carry a version/sections.
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
  // Exactly one backend version is supported (`version:'1.0'`); anything else fails closed with a
  // single clean `unsupported_version` SpecError before the strict-shape parse runs.
  const doc = loaded as Record<string, unknown>;
  const version = doc.version;
  if (version !== SPEC_VERSION) {
    let message: string;
    if (version === undefined) {
      message = `spec version is missing; this engine supports version '${SPEC_VERSION}'`;
    } else if (typeof version !== 'string') {
      // The natural author typo `version: 1.0` (unquoted) parses as the YAML NUMBER 1 — correctly
      // rejected (we do NOT coerce). Give a targeted hint naming the JS type instead of stringifying
      // it to a misleading "'1'" that reads close to the supported version.
      message =
        `spec version must be the quoted string '${SPEC_VERSION}' ` +
        `(got the YAML ${typeof version} ${String(version)} — wrap it in quotes)`;
    } else {
      message = `unsupported spec version '${version}'; this engine supports version '${SPEC_VERSION}'`;
    }
    return {
      ok: false,
      errors: [specError('unsupported_version', message, 'version')],
    };
  }

  // ---- 2b. EXPERIMENTAL-SECTION GATE ----------------------------------------------------
  // Before the strict shape parse (two-phase discipline: ONE clean refusal, not a wall of shape
  // errors from a section the caller never enabled). The gate keys on the RAW document — a
  // `workforce:` key of ANY shape is the author's declared intent to use the section.
  if ('workforce' in doc && options.experimentalWorkforce !== true) {
    return {
      ok: false,
      errors: [
        specError(
          'experimental_section_disabled',
          "the 'workforce' section is EXPERIMENTAL and this entry point did not opt in — set " +
            'RAYSPEC_EXPERIMENTAL_WORKFORCE=1 in the environment of doctor/plan/deploy/serve to ' +
            'enable it (its grammar and behavior may change without notice)',
          'workforce',
        ),
      ],
    };
  }

  // ---- 2c. EXACTLY ZERO OR ONE WORKFORCE (D-010) -----------------------------------------
  // AFTER the gate: a two-workforce document without the opt-in still gets the ONE clean
  // `experimental_section_disabled` refusal, preserving the two-phase discipline this module
  // commits to above. BEFORE the strict shape parse: by the time Zod has run, a list is an
  // anonymous "expected object, received array" and a plural key is an anonymous `unknown_field` —
  // neither names the rule the author broke. Operates on the RAW document for the same reason the
  // gate does.
  const multipleWorkforces = scanMultipleWorkforces(doc);
  if (multipleWorkforces !== null) {
    return { ok: false, errors: [multipleWorkforces] };
  }

  // ---- 3. RESERVED DOCUMENT KEY (raw scan; short-circuit on any hit) --------------------
  // After the gate on purpose: a document whose `workforce:` section the caller never enabled is
  // answered by the gate alone, so no error ever quotes a path drawn from inside a disabled
  // section. Once the opt-in is set, the scan reads that section like any other.
  const reservedKeyErrors = scanReservedDocumentKeys(loaded);
  if (reservedKeyErrors.length > 0) {
    return { ok: false, errors: reservedKeyErrors };
  }

  // ---- 4. STRICT ZOD PARSE (full issue list) --------------------------------------------
  const parsed = RaySpec.safeParse(loaded);
  if (!parsed.success) {
    const errors = parsed.error.issues.flatMap(issueToSpecErrors);
    return { ok: false, errors };
  }

  // ---- 5. SEMANTIC LINT -----------------------------------------------------------------
  const lintErrors = lintSpec(parsed.data);
  if (lintErrors.length > 0) {
    return { ok: false, errors: lintErrors };
  }

  return { ok: true, value: parsed.data };
}
