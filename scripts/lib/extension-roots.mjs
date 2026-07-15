/**
 * Shared MANIFEST-DERIVED extension-pack handler-root discovery for the two escape-hatch gates
 * (`check-handler-imports.mjs` + `check-extension-capability.mjs`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY MANIFEST-DERIVED (and what "manifest-derived" means for a static .mjs gate).
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Historically the gates hard-coded the escape-hatch roots they scan. With the extension-pack mechanism
 * a deployment's `rayspec.yaml` can REFERENCE a pack (`extensions: [{ id, module: <dir>, version }]`)
 * whose handlers live in the PACK's own directory, NOT under the deployment dir. If the gates kept a
 * fixed root list, adding a pack would silently EXEMPT the pack's handlers from the import +
 * capability tripwires (a pack handler could import `@rayspec/db` / self-construct a raw Pool and the
 * gate would never see it). So the gates DISCOVER the pack handler roots FROM THE SAME REFERENCES the
 * loader resolves: every `extensions[].module` directory in every deployment `rayspec.yaml`. Adding a
 * pack to a YAML automatically registers its handler root with BOTH gates.
 *
 * A `.mjs` CI gate cannot EXECUTE the pack's TS `defineExtension` manifest (no transform, and running
 * pack code at gate time is itself a hazard). So "manifest-derived" here = derived from the
 * `extensions[]` REFERENCES (the same `module` dirs `loadExtensions` resolves) + the pack-layout
 * convention that a pack's escape-hatch handler modules live under `<packDir>/handlers/`. This is the
 * static, no-code-exec analogue of reading the manifest; it is kept in LOCKSTEP across both gates by
 * being the ONE shared function here.
 *
 * PATH-JAILED: each discovered pack root is resolved RELATIVE TO THE DEPLOYMENT DIR and confirmed to
 * stay INSIDE the repo (a `..`/absolute/outside-repo `module` is REJECTED — never a self-declared
 * root that tunnels out). A pack root that escapes the repo is a gate FAILURE (fail-closed), surfaced
 * by `discoverExtensionHandlerRoots` returning it in `escapes` so the gate can error on it.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the REAL `yaml` parser (`yaml@2.9.0`, the same lib `parseSpec`/`loadExtensions` use) from a
 * workspace package that DECLARES it as a dependency — `@rayspec/spec` (packages/kernel/spec/package.json).
 * We anchor `createRequire` there (NOT at this repo-root `.mjs`, which has no `yaml` in its scope under
 * pnpm's non-hoisted layout) so the gate — run as `node scripts/check-*.mjs` from the repo root in CI —
 * resolves `yaml` robustly via that package's own resolution paths. A FULL YAML parse replaces the old
 * hand-rolled line parser, which was BLIND to inline-flow `extensions: [{ id, module, version }]`,
 * folded scalars, and anchors (FIX B) — any of which would silently EXEMPT a pack's handlers from both
 * escape-hatch gates.
 */
const here = dirname(fileURLToPath(import.meta.url)); // scripts/lib
const repoRootForResolve = resolve(here, '..', '..'); // repo root
const specPkgJson = join(repoRootForResolve, 'packages', 'kernel', 'spec', 'package.json');
const requireFromSpec = createRequire(specPkgJson);
// A synchronous require of the resolved `yaml` entry (it ships a CJS build at its require condition).
const YAML = requireFromSpec('yaml');

/**
 * The deployment `rayspec.yaml` files whose `extensions[]` are scanned for pack handler roots. On the
 * platform main line the only ones are the synthetic fixtures under examples/; a real deployment runs
 * the gate in its own repo against its own YAML (add it here, or pass it via env in that repo).
 */
const DEPLOYMENT_SPECS = [
  'examples/stream-backend/rayspec.yaml',
  'examples/acme-notes-backend/rayspec.yaml',
  // The synthetic agent-pack deployment — so the `agents`-fragment pack's
  // handler root (examples/agent-pack-deployment/packs/agent-pack/handlers) is gate-scanned (the
  // scan-surface must equal the loader's accept-surface; a committed pack handler is never unscanned).
  'examples/agent-pack-deployment/rayspec.yaml',
];

/**
 * Extract the `module` values of every `extensions[]` entry in a deployment YAML document, using the
 * REAL `yaml` parser (FIX B — the old hand-rolled line parser was BLIND to inline-flow
 * `extensions: [{ id, module: ./packs/p, version }]`, folded scalars, and anchors, so a pack declared
 * that way escaped BOTH gates). Parses the document, reads `doc.extensions`, and returns each entry's
 * `.module` string (skipping a non-object entry / a non-string module — those are caught by parseSpec
 * at deploy; here we only need to DISCOVER the candidate pack dirs to scan). A YAML the parser cannot
 * read (truly malformed) yields `[]` (the deploy's parseSpec is the authoritative validator).
 */
export function extractExtensionModules(yamlText) {
  let doc;
  try {
    doc = YAML.parse(yamlText);
  } catch {
    return []; // a malformed YAML → no discoverable pack dirs (parseSpec is the deploy-time validator).
  }
  const exts = doc && typeof doc === 'object' ? doc.extensions : undefined;
  if (!Array.isArray(exts)) return [];
  const modules = [];
  for (const entry of exts) {
    if (entry && typeof entry === 'object' && typeof entry.module === 'string') {
      modules.push(entry.module);
    }
  }
  return modules;
}

/**
 * Resolve a pack `module` dir relative to its deployment dir, PATH-JAILED to the repo. Returns the
 * absolute pack dir if it stays inside the repo, or `null` if it escapes (the gate treats an escape as
 * a failure). Mirrors the loader's lexical jail (reject `..`-segments / absolute / outside-repo) +
 * a realpath symlink re-check. A bare npm specifier (no `.`/`/`) is NOT a directory → returns null
 * (the npm branch is not built; such a ref is fail-closed at load anyway).
 */
function jailPackDir(repoRoot, deploymentDir, moduleSpec) {
  if (!(moduleSpec.startsWith('.') || moduleSpec.startsWith('/') || moduleSpec.startsWith('\\'))) {
    return null; // a bare specifier (npm-style) — not a directory; the npm branch is not built.
  }
  if (isAbsolute(moduleSpec)) return null; // absolute pack dirs are rejected (jail).
  if (moduleSpec.split(/[/\\]/).includes('..')) return null; // a `..` segment cannot climb out.
  const abs = resolve(deploymentDir, normalize(moduleSpec));
  const relToRepo = relative(repoRoot, abs);
  if (relToRepo === '' || relToRepo.startsWith('..') || isAbsolute(relToRepo)) return null;
  // realpath symlink re-check (best-effort; skip if the dir does not exist yet).
  try {
    const realRepo = realpathSync(repoRoot);
    const realAbs = realpathSync(abs);
    if (realAbs !== realRepo && !realAbs.startsWith(realRepo + sep)) return null;
  } catch {
    // dir missing → the gate's directory walk simply finds nothing (no escape to worry about).
  }
  return abs;
}

/**
 * Discover the PACK handler roots the gates must scan (manifest-derived). For each deployment YAML
 * that exists, read its `extensions[].module` dirs, path-jail each, and add `<packDir>/handlers` (the
 * pack-layout convention) as a scan root WHEN it exists. Returns `{ roots, escapes }`:
 *   - `roots`   absolute pack handler-root dirs to scan (deduped; only those that exist on disk).
 *   - `escapes` `{ spec, module }` for any `module` that escaped the repo jail — a gate FAILURE.
 *
 * @param repoRoot   the repo root (the gate passes `join(dirname(import.meta.url..), '..')`).
 */
export function discoverExtensionHandlerRoots(repoRoot, deploymentSpecs = DEPLOYMENT_SPECS) {
  const roots = new Set();
  const escapes = [];
  for (const specRel of deploymentSpecs) {
    const specAbs = join(repoRoot, specRel);
    let yamlText;
    try {
      yamlText = readFileSync(specAbs, 'utf8');
    } catch {
      continue; // an absent deployment spec → skip (the platform main line / another repo).
    }
    const deploymentDir = join(specAbs, '..');
    for (const moduleSpec of extractExtensionModules(yamlText)) {
      const packDir = jailPackDir(repoRoot, deploymentDir, moduleSpec);
      if (packDir === null) {
        escapes.push({ spec: specRel, module: moduleSpec });
        continue;
      }
      // The pack's escape-hatch handler modules live under `<packDir>/handlers` by convention. Add it
      // when it exists (a pack with no handlers contributes none — nothing to scan).
      const handlersDir = join(packDir, 'handlers');
      try {
        if (statSync(handlersDir).isDirectory())
          roots.add(relative(repoRoot, handlersDir).split('\\').join('/'));
      } catch {
        // No handlers/ subdir → the pack ships no escape-hatch handlers (nothing to scan).
      }
    }
  }
  return { roots: [...roots], escapes };
}
