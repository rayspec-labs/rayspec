/**
 * `rayspec doctor <spec.yaml>` — the STATIC validity check (no Postgres, no network, and no code out
 * of the deployment tree).
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
 *
 * IT LOADS NO EXTENSION PACK unless `--with-packs` asks it to. Resolving a pack means `import()`ing
 * its entry module and its section-schema module — third-party code, out of the deployment tree,
 * executing in-process — and this is the first command run against a repository somebody has just
 * cloned. The default therefore leaves a top-level section a pack claims UNRESOLVED (accepted
 * unexamined, never refused — see `parseWithoutPacks`) and states that in one neutral line, while
 * `--with-packs` restores the fuller check for a reader who wants it and is told what it costs. `plan`
 * and the deploy paths are unchanged: they resolve the deployment's packs, because naming the pack
 * that claims a section is what an operator debugging a deployment needs.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type AnySpecParse,
  applyLintSuppressions,
  lintSpecWarnings,
  parseAnySpec,
  type SpecError,
  type SpecWarning,
  type SuppressedSpecWarning,
  specError,
} from '@rayspec/spec';
import {
  parseFromDeploymentTree,
  parseWithoutPacks,
  withClaimedSections,
} from './pack-sections.js';
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
  /**
   * ONE neutral line per top-level section an extension pack on this deployment claims, naming the
   * section key and the pack that owns it. Present only under `--with-packs`, for a document that
   * references a pack and validated, so a pack-free document's envelope is byte-identical to what it
   * was before the field existed. It never affects `ok`: it states who owns a key, not whether
   * anything is wrong.
   */
  readonly claimedSections?: readonly string[];
  /**
   * ONE neutral line stating that the deployment's packs were left unresolved — present exactly when
   * this run loaded none (the default) and the document declares one, and absent under `--with-packs`.
   * It never affects `ok` either: a document whose packs were not read is not a document that is
   * wrong, and a warning on every run of the first command a reader types trains people to ignore
   * warnings.
   */
  readonly notResolved?: readonly string[];
}

/** How much of the document `doctor` is asked to resolve. */
export interface DoctorOptions {
  /**
   * Resolve the deployment's extension packs before judging the document — which RUNS CODE from the
   * deployment tree (each pack's entry module and each claimed section's schema module is imported).
   * Absent/false ⇒ no pack is loaded and a claimed section is left unresolved.
   */
  readonly withPacks?: boolean;
}

/**
 * Run `doctor` over the positional args. Reads the spec fail-closed, parses it, and returns the
 * `{ ok, errors }` result. A spec-read failure (missing/escape/oversized/not-a-file) is mapped to
 * a single SpecError-shaped entry with code `yaml_parse_error` so the envelope is uniform (the closed
 * SpecError vocabulary has no "io" code; a read failure is surfaced as the document being unreadable).
 * NEVER throws for an invalid spec — only `ok:false`.
 */
export async function runDoctor(
  positionals: readonly string[],
  options: DoctorOptions = {},
): Promise<DoctorResult> {
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

  // The parse for a document that references a pack. Under `--with-packs` it is the pack-aware one —
  // the same loader, from the same tree, the boot uses — and by DEFAULT it is the one that loads no
  // pack and leaves the sections they claim unresolved. `undefined` ⇒ nothing to resolve either way,
  // and the unchanged `parseAnySpec` answers exactly as it always did. Both validate the BACKEND
  // profile (the only one whose grammar carries `extensions[]`), so the outcome is re-expressed in
  // that profile's terms.
  const fromTree = options.withPacks
    ? await parseFromDeploymentTree(specPath, text)
    : parseWithoutPacks(text);
  const parsed: AnySpecParse =
    fromTree === undefined
      ? parseAnySpec(text)
      : fromTree.spec !== undefined
        ? { ok: true, kind: 'rayspec', spec: fromTree.spec }
        : { ok: false, kind: 'rayspec', errors: fromTree.errors };
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
  // serialized bytes) stays exactly what it was before the field existed. `claimedSections` and
  // `notResolved` are woven on under the same rule — and they are mutually exclusive by construction,
  // because a run either resolved this document's packs or it did not.
  const envelope = withClaimedSections(
    suppressed.length > 0
      ? { ok: errors.length === 0, errors, warnings, suppressed }
      : { ok: errors.length === 0, errors, warnings },
    fromTree?.claimedSections ?? [],
  );
  const notResolved = fromTree?.notResolved ?? [];
  return notResolved.length === 0 ? envelope : { ...envelope, notResolved };
}
