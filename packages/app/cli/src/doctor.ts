/**
 * `rayspec doctor <spec.yaml>` — the STATIC validity check (no Postgres, no network).
 *
 * Wraps the already-shipped parser (`parseAnySpec`, which itself runs the strict Zod parse + `lintSpec`
 * as its lint stage — see packages/kernel/spec/src/parse.ts) and emits its result as a stable JSON
 * envelope:
 *
 *     { "ok": true,  "errors": [] }                                  // exit 0
 *     { "ok": false, "errors": [{ code, message, path? }, ...] }     // exit 1
 *
 * This is the `terraform validate` floor an authoring skill iterates against: a fast, deterministic,
 * machine-parseable "is this spec well-formed?" with the FULL fail-closed violation list (the parser
 * aggregates every problem, never just the first). NO secret can appear in the output: the only inputs
 * are the operator-supplied path (echoed in a read error + a frontend dir) and the spec's own contents.
 *
 * `doctor` validates BOTH profiles of the `version:'1.0'` language via `parseAnySpec`, which dispatches
 * on the `product:` discriminant (a `product:` section → the product profile; absent → the backend
 * profile). So `doctor <product>.yaml` fully validates a product doc's sections (product/requires/
 * capabilities/artifacts/contracts/extractors/workflows/grounding/views), not just a backend doc.
 *
 * ONE static filesystem check beyond parse/lint: a valid backend-profile doc that declares a static
 * `frontend[]` mount has each mount's `dir` checked to resolve to a readable directory of built assets
 * (parse/lint see only the YAML; the filesystem is doctor's to check) → `frontend_dir_missing` on a miss.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  applyLintSuppressions,
  lintSpecWarnings,
  parseAnySpec,
  type SpecError,
  type SpecWarning,
  type SuppressedSpecWarning,
  specError,
} from '@rayspec/spec';
import { ReadSpecError, readSpecFile, resolveSpecPath } from './read-spec.js';

/**
 * The `doctor` JSON result. `{ ok, errors }` is the fail-closed contract (mirrors `parseSpec`); the
 * additive `warnings` array carries NON-FATAL advisories (`lintSpecWarnings`) — present but never
 * affecting `ok` (a spec with only warnings is still valid, exit 0). `suppressed` carries the
 * advisories a node's `lintSuppress` acknowledged (finding code + recorded justification — visible
 * in review, quiet in the loop); it never affects `ok` either, and it is ABSENT (not `[]`) when
 * nothing is suppressed, so a suppression-free document's envelope is byte-identical to before the
 * field existed.
 */
export interface DoctorResult {
  readonly ok: boolean;
  readonly errors: SpecError[];
  readonly warnings: SpecWarning[];
  readonly suppressed?: SuppressedSpecWarning[];
}

/**
 * Run `doctor` over the positional args. Reads the spec fail-closed, parses it, and returns the
 * `{ ok, errors }` result. A spec-read failure (missing/escape/oversized/not-a-file) is mapped to
 * a single SpecError-shaped entry with code `yaml_parse_error` so the envelope is uniform (the closed
 * SpecError vocabulary has no "io" code; a read failure is surfaced as the document being unreadable).
 * NEVER throws for an invalid spec — only `ok:false`.
 */
export async function runDoctor(positionals: readonly string[]): Promise<DoctorResult> {
  let text: string;
  let specPath: string;
  try {
    specPath = resolveSpecPath(positionals);
    text = await readSpecFile(specPath);
  } catch (e) {
    if (e instanceof ReadSpecError) {
      return {
        ok: false,
        errors: [{ code: 'yaml_parse_error', message: e.message }],
        warnings: [],
      };
    }
    throw e;
  }

  const parsed = parseAnySpec(text);
  const errors: SpecError[] = parsed.ok ? [] : [...parsed.errors];
  // NON-FATAL advisories: only a valid backend-profile (rayspec) doc has stores/FKs to inspect (the
  // product profile has its own store handling). Warnings never affect `ok`. The nodes'
  // `lintSuppress` acknowledgements are applied over the raw advisory list: an acknowledged finding
  // moves to `suppressed` (code + justification), an acknowledgement whose code fires nothing on
  // its node comes BACK as a `stale_suppression` warning — a suppression-free document passes
  // through untouched.
  let warnings: SpecWarning[] = [];
  let suppressed: SuppressedSpecWarning[] = [];
  if (parsed.ok && parsed.kind === 'rayspec') {
    ({ warnings, suppressed } = applyLintSuppressions(parsed.spec, lintSpecWarnings(parsed.spec)));
  }

  // A valid backend-profile (rayspec) doc: additionally check each declared frontend `dir` resolves to
  // a readable directory of built assets (relative to the spec file). Route COLLISIONS already arrive
  // via the parse errors (lintSpec's frontend rule); this is the filesystem-existence half only. Only
  // the operator-supplied path + the spec's own route/dir strings are echoed (no secret can appear).
  if (parsed.ok && parsed.kind === 'rayspec') {
    (parsed.spec.frontend ?? []).forEach((mount, fi) => {
      const resolvedDir = resolve(dirname(specPath), mount.dir);
      let isDir = false;
      try {
        isDir = statSync(resolvedDir).isDirectory();
        // isDirectory() alone does NOT test read/traverse permission — a mode-0000 dir passes stat but
        // then every asset EACCES-misses. Require R_OK|X_OK too so an unreadable/untraversable dir is
        // treated the same as missing (fails closed as frontend_dir_missing, mirroring the boot guard).
        if (isDir) accessSync(resolvedDir, constants.R_OK | constants.X_OK);
      } catch {
        isDir = false;
      }
      if (!isDir) {
        errors.push(
          specError(
            'frontend_dir_missing',
            `frontend route '${mount.route}' points at '${mount.dir}' (resolved to ${resolvedDir}), ` +
              'which is not a readable directory of built assets',
            `frontend[${fi}].dir`,
          ),
        );
      }
    });
  }

  // `suppressed` is emitted only when non-empty: a suppression-free document's envelope (and its
  // serialized bytes) stays exactly what it was before the field existed.
  return suppressed.length > 0
    ? { ok: errors.length === 0, errors, warnings, suppressed }
    : { ok: errors.length === 0, errors, warnings };
}
