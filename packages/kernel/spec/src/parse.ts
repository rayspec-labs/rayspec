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
 *   3. STRICT ZOD PARSE      — `RaySpec.safeParse`. EVERY Zod issue maps to a SpecError with
 *                             a JSON path; an `unrecognized_keys` issue -> `unknown_field` (one per
 *                             offending key), everything else -> `schema_violation`. Returns the
 *                             FULL issue list.
 *   4. SEMANTIC LINT         — `lintSpec` (cross-refs, dups, capability, embedded schemas). Only
 *                             run when the shape parse SUCCEEDS (lint needs a typed spec).
 *
 * Any non-empty error list -> `{ ok:false, errors }` (the value is NEVER returned partially).
 */
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
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
 * Parse + validate a raw RaySpec YAML spec. Returns the typed spec on success, or the FULL
 * aggregated list of fail-closed violations.
 */
export function parseSpec(rawYamlText: string): Result<RaySpec, SpecError> {
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

  // ---- 3. STRICT ZOD PARSE (full issue list) --------------------------------------------
  const parsed = RaySpec.safeParse(loaded);
  if (!parsed.success) {
    const errors = parsed.error.issues.flatMap(issueToSpecErrors);
    return { ok: false, errors };
  }

  // ---- 4. SEMANTIC LINT -----------------------------------------------------------------
  const lintErrors = lintSpec(parsed.data);
  if (lintErrors.length > 0) {
    return { ok: false, errors: lintErrors };
  }

  return { ok: true, value: parsed.data };
}
