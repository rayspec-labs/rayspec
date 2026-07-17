#!/usr/bin/env node
/**
 * Deploy-entrypoint import-resolvability gate.
 *
 * WHY THIS EXISTS (a REAL crash-loop class caught in production)
 *   The single-repo VPS image boots via `CMD ["pnpm","exec","tsx","deployments/acme-notes/serve.mts"]`.
 *   `deployments/acme-notes/serve.mts` lives OUTSIDE any workspace package (the `deployments/` tree has NO
 *   package.json + is not a pnpm-workspace member), so Node resolves its BARE (non-relative) imports from
 *   the REPO-ROOT `node_modules`. pnpm's isolated node_modules does NOT hoist a package to the repo root
 *   just because some workspace member depends on it — so an import that is only declared deep in a
 *   package (e.g. `@hono/node-server`, declared in packages/compose/api-auth + packages/app/server) is UNRESOLVABLE
 *   from the entrypoint and the container CRASH-LOOPS at boot:
 *       Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@hono/node-server' imported from
 *       /app/deployments/acme-notes/serve.mts
 *   `docker compose build` is COMPILE-ONLY (it never BOOTS the app), so this runtime-resolution failure
 *   slips through a green build + a green typecheck. The fix is to declare every such import in the ROOT
 *   package.json `dependencies` (an external at its EXACT pinned version; a `@rayspec/*` workspace package
 *   as `workspace:*`), so pnpm links it into the repo-root node_modules. This gate is the forcing function
 *   that keeps the class closed.
 *
 *   THE CLASS ALSO APPLIES to a SIBLING entrypoint: a data-migration boot script (e.g. an
 *   `import postgres from 'postgres'`) fails identically (`Cannot find package 'postgres'`) when
 *   `postgres` is declared only deep in packages and not hoisted to the repo root. So the gate scans
 *   EVERY `.mts` under the deployment dir (below), not just serve.mts — a new boot script can never
 *   reopen the class un-gated.
 *
 * WHAT IT ASSERTS
 *   For EVERY entrypoint listed in ENTRYPOINTS below, statically extract every NON-type-only, non-relative,
 *   non-builtin bare import specifier and require BOTH:
 *     (A) its TOP-LEVEL package is a key in the ROOT package.json `dependencies` (the declarative
 *         invariant that makes pnpm link it into repo-root node_modules — build-INDEPENDENT), AND
 *     (B) `import.meta.resolve(specifier)` succeeds from the repo root (the ESM-faithful check that
 *         mirrors the real boot exactly — also catches a missing subpath export / an un-built dist).
 *   `import type …` / `export type …` statements are TYPE-ONLY (elided at runtime by tsx/tsc) and are
 *   skipped — e.g. serve.mts's `import type { PgTable } from 'drizzle-orm/pg-core'` legitimately does NOT
 *   need `drizzle-orm` at the repo root.
 *
 *   node scripts/check-deploy-entrypoint-imports.mjs   # CHECK (exit 1 on any unresolvable runtime import)
 *
 * Fast, DB-free, secret-free. Runs UNCONDITIONALLY in CI. Check (B) needs the workspace BUILT (dist
 * present) + installed for the `@rayspec/*` subpaths — run it AFTER `pnpm install` + `pnpm build` (CI
 * places it after the Build step); check (A) alone still fires build-free.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from THIS file via fileURLToPath — a checkout path with a space (or any
// other percent-encodable character) survives, where `new URL(import.meta.url).pathname` would leave
// a literal `%20` in the path and break every join below.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The deployment dir(s) whose `.mts` files are booted via `pnpm exec tsx <file>`. Everything under here
// lives OUTSIDE a workspace package, so Node resolves its bare imports from the repo root. Every `.mts`
// is auto-covered — a NEW boot script dropped in (a second serve, a data-migration, …) is scanned
// without touching this gate. Add a new deployment DIRECTORY here if one is ever introduced.
const ENTRYPOINT_DIRS = ['deployments/acme-notes'];

/**
 * Every `*.mts` under the entrypoint dirs, repo-relative + sorted (stable output). A missing dir
 * degrades cleanly (a repo that ships no deployment entrypoint has nothing to scan) rather than
 * throwing — the gate still asserts on whatever dirs DO exist.
 */
const ENTRYPOINTS = ENTRYPOINT_DIRS.flatMap((dir) => {
  let names;
  try {
    names = readdirSync(join(repoRoot, dir));
  } catch {
    return []; // dir absent → nothing to scan (fail-open on absence, not on an unresolvable import).
  }
  return names
    .filter((name) => name.endsWith('.mts'))
    .sort()
    .map((name) => `${dir}/${name}`);
});

/** Root package.json `dependencies` — the set that pnpm links into repo-root node_modules. */
const rootDeps = (() => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  return new Set(Object.keys(pkg.dependencies ?? {}));
})();

/** The top-level package name of a bare specifier (`@scope/name/sub` → `@scope/name`; `pkg/sub` → `pkg`). */
function topLevelPackage(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Extract runtime (non-type-only) bare import specifiers from ONE module's source. Robust to
 * prettier-WRAPPED multi-line imports: the clause between the keyword and `from` may span newlines but can
 * never contain a quote / paren / semicolon, so `[^'"();]*?` cannot bleed across statement boundaries.
 * Comments are stripped first (a `//` inside a `://` URL is preserved) so a commented import never counts.
 */
function extractRuntimeSpecifiers(src) {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // line comments (but not the `//` in `http://`)
  const specs = [];
  // (1) static `import … from '…'` / `export … from '…'` — `type` right after the keyword ⇒ type-only.
  const staticRe = /\b(?:import|export)\b(\s+type\b)?[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g;
  for (const m of code.matchAll(staticRe)) {
    if (m[1]) continue; // `import type …` / `export type …` — elided at runtime
    specs.push(m[2]);
  }
  // (2) side-effect `import '…'` (a bare quote right after `import`, not `import {` / `import name`).
  for (const m of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.push(m[1]);
  // (3) dynamic `import('…')` with a static string literal.
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

const violations = [];
let checkedImports = 0;

for (const rel of ENTRYPOINTS) {
  const abs = join(repoRoot, rel);
  let src;
  try {
    src = readFileSync(abs, 'utf8');
  } catch {
    violations.push(`  [missing-entrypoint] ${rel} — listed in ENTRYPOINTS but not found on disk`);
    continue;
  }
  for (const spec of extractRuntimeSpecifiers(src)) {
    // Relative / absolute imports resolve against the file itself — not a repo-root concern.
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    // Node builtins (`fs`, `node:module`, …) always resolve and are never package.json deps.
    if (isBuiltin(spec)) continue;
    checkedImports += 1;
    const top = topLevelPackage(spec);
    // (A) declarative: the top-level package must be a ROOT dependency (⇒ linked at repo-root node_modules).
    if (!rootDeps.has(top)) {
      violations.push(
        `  [${rel}] import '${spec}': top-level package '${top}' is NOT in the ROOT package.json ` +
          `"dependencies" — Node cannot resolve it from the repo root at boot (ERR_MODULE_NOT_FOUND). ` +
          `Add it to the ROOT deps (external ⇒ its EXACT pinned version, zero caret/tilde; a @rayspec/* ` +
          `workspace package ⇒ "workspace:*") and regenerate the lockfile.`,
      );
      continue;
    }
    // (B) ESM-faithful: the exact specifier must resolve from the repo root (catches a missing subpath
    //     export / an un-built dist that (A) alone would miss).
    try {
      import.meta.resolve(spec);
    } catch (err) {
      violations.push(
        `  [${rel}] import '${spec}': declared in root deps but UNRESOLVABLE from the repo root ` +
          `(${err?.code ?? err?.message ?? 'resolve failed'}) — is the workspace BUILT (pnpm build) and ` +
          `installed, and does '${top}' export this subpath?`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(
    `deploy-entrypoint gate FAILED: ${violations.length} unresolvable runtime import(s) — the VPS boot ` +
      `(pnpm exec tsx <entrypoint>) would CRASH-LOOP with ERR_MODULE_NOT_FOUND:\n${violations.join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `deploy-entrypoint gate PASSED: ${checkedImports} runtime import(s) across ${ENTRYPOINTS.length} ` +
    `entrypoint(s) all resolve from the repo root (declared in root deps + import.meta.resolve OK).`,
);
