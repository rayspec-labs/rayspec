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
 *
 * The first three steps are `loadSpecDocument` — the PRE-SHAPE half, shared verbatim with the
 * section-aware parse (`sections.ts`), which differs only from the strict Zod parse onwards. One
 * implementation, so the two entry points cannot drift on a version message or on the reserved-key
 * short-circuit.
 */
import { parse as parseYaml } from 'yaml';
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

/** Prefix a rendered issue path with a base path (`acme_notes` + `a[0].b` -> `acme_notes.a[0].b`). */
function underBasePath(
  basePath: string | undefined,
  rendered: string | undefined,
): string | undefined {
  if (basePath === undefined) return rendered;
  if (rendered === undefined) return basePath;
  return rendered.startsWith('[') ? `${basePath}${rendered}` : `${basePath}.${rendered}`;
}

/**
 * The parts of a Zod issue this mapper reads. Declared STRUCTURALLY (not as `z.core.$ZodIssue`) so
 * the same mapping serves a validator an extension pack brings with its own copy of Zod — the
 * package a pack validates with is the pack's business, and it is not this repo's Zod instance.
 */
export interface ZodIssueLike {
  readonly code?: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
  readonly keys?: readonly string[];
}

/** Map a single Zod issue to one or more SpecErrors (an unrecognized-keys issue fans out per key). */
function issueToSpecErrors(issue: ZodIssueLike, basePath?: string): SpecError[] {
  const base = underBasePath(basePath, renderPath(issue.path));
  if (issue.code === 'unrecognized_keys') {
    // Fail-closed unknown-key rejection — one SpecError per offending key, pathed at the key.
    return (issue.keys ?? []).map((key) =>
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
 * Map a Zod issue LIST to the full SpecError list, optionally under a base JSON path. `basePath` is
 * how a claimed top-level section's own violations are reported at `<section>.<field>` rather than
 * at the pack grammar's own root.
 */
export function specErrorsFromZodIssues(
  issues: readonly ZodIssueLike[],
  basePath?: string,
): SpecError[] {
  return issues.flatMap((issue) => issueToSpecErrors(issue, basePath));
}

/**
 * The PRE-SHAPE half of the pipeline: YAML safe-load, the version check, and the raw
 * reserved-document-key scan, each short-circuiting exactly as documented above. Returns the loaded
 * document object for the shape parse to read.
 *
 * Split out so the section-aware parse runs the SAME stages rather than a second copy of them: the
 * two entry points can differ only from the strict shape parse onwards, which is the half the accept
 * control in `sections-accept-control.test.ts` measures.
 */
export function loadSpecDocument(rawYamlText: string): Result<Record<string, unknown>, SpecError> {
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

  // ---- 3. RESERVED DOCUMENT KEY (raw scan; short-circuit on any hit) --------------------
  const reservedKeyErrors = scanReservedDocumentKeys(loaded);
  if (reservedKeyErrors.length > 0) {
    return { ok: false, errors: reservedKeyErrors };
  }

  return { ok: true, value: doc };
}

/**
 * Parse + validate a raw RaySpec YAML spec. Returns the typed spec on success, or the FULL
 * aggregated list of fail-closed violations.
 */
export function parseSpec(rawYamlText: string): Result<RaySpec, SpecError> {
  const loaded = loadSpecDocument(rawYamlText);
  if (!loaded.ok) return loaded;

  // ---- 4. STRICT ZOD PARSE (full issue list) --------------------------------------------
  const parsed = RaySpec.safeParse(loaded.value);
  if (!parsed.success) {
    const errors = specErrorsFromZodIssues(parsed.error.issues);
    return { ok: false, errors };
  }

  // ---- 5. SEMANTIC LINT -----------------------------------------------------------------
  const lintErrors = lintSpec(parsed.data);
  if (lintErrors.length > 0) {
    return { ok: false, errors: lintErrors };
  }

  return { ok: true, value: parsed.data };
}
