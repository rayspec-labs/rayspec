/**
 * SDK version source-of-truth for the version-bump-re-record RULE.
 *
 * The three agent SDKs churn (Anthropic ~weekly, Pi pre-1.0). A recorded fixture is only trustworthy
 * if it was captured against the SAME SDK version that is currently INSTALLED — otherwise a real wire
 * change passes a stale fixture green (the "recorded-fixture false-green" risk). This module is how
 * the rule is ENFORCED: it reads the INSTALLED pinned version of each SDK at test time (from the
 * package's own package.json, via createRequire — never a hard-coded duplicate) so the version-bump
 * test can assert each recorded fixture's pinned version == the installed version. A bump WITHOUT a
 * re-record then fails CI.
 *
 * The adapters export the version they were RECORDED against (OPENAI_SDK_VERSION etc.); the fixtures
 * stamp it too (`sdkVersions`). The single chain asserted by version-bump.test.ts:
 *   installed package.json version  ==  adapter constant  ==  fixture stamp.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/** The npm package whose version is the pinned SDK version for each backend. (+ codex.) */
export const SDK_PACKAGE: Record<'openai' | 'anthropic' | 'pi' | 'codex', string> = {
  openai: '@openai/agents',
  anthropic: '@anthropic-ai/claude-agent-sdk',
  pi: '@earendil-works/pi-coding-agent',
  codex: '@openai/codex-sdk',
};

/** Walk UP from `startDir` to the nearest package.json whose `name === pkg`; return its version. */
function versionFromDirWalk(startDir: string, pkg: string): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 50; i++) {
    try {
      const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pj.name === pkg && typeof pj.version === 'string') return pj.version;
    } catch {
      /* not here; keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Read the INSTALLED version of a package from its own package.json (never a hard-coded copy).
 *
 * The SDKs ship an `exports` map that does NOT expose `./package.json` (and pi has no `exports` MAIN
 * at all), so neither `require('<pkg>/package.json')` nor `require.resolve('<pkg>')` reliably works.
 * Strategy, in order: (1) resolve the package MAIN entry and walk UP to its own package.json; (2) if
 * the package has no exported main, locate `node_modules/<pkg>` next to THIS module's resolution roots
 * (require.resolve.paths) and read its package.json directly. Both are exports-proof.
 */
export function installedVersion(pkg: string): string {
  // (1) Try the main-entry walk (works for openai + anthropic).
  try {
    const entry = require.resolve(pkg);
    const v = versionFromDirWalk(dirname(entry), pkg);
    if (v) return v;
  } catch {
    /* package has no exported main (pi) — fall through to the node_modules lookup */
  }
  // (2) Find node_modules/<pkg>/package.json across the resolution roots (pnpm symlink farm included).
  const roots = require.resolve.paths(pkg) ?? [];
  for (const root of roots) {
    const v = versionFromDirWalk(join(root, pkg), pkg);
    if (v) return v;
  }
  throw new Error(`installedVersion: could not resolve package.json for '${pkg}'`);
}

/** The installed pinned SDK version for a backend (the value the fixture must have been recorded at). */
export function installedSdkVersion(backend: 'openai' | 'anthropic' | 'pi' | 'codex'): string {
  return installedVersion(SDK_PACKAGE[backend]);
}

/**
 * The version-bump rule's CORE comparison, as a PURE function. The fixture is
 * trustworthy iff all three agree: the INSTALLED pinned version == the adapter-exported constant ==
 * the fixture's recorded stamp. A bump of any one without the others FAILS this. Both version-bump
 * describe blocks (the real rule + the "tripwire is real" simulation) call THIS function, so the
 * tripwire is proven by exercising the SAME rule the real assertions use — not a tautology.
 */
export function versionMatches(
  installed: string,
  constant: string,
  fixtureStamp: string | undefined,
): boolean {
  return typeof fixtureStamp === 'string' && installed === constant && constant === fixtureStamp;
}

/** Build the `sdkVersions` stamp written into a fixture: backend → its installed SDK version. */
export function captureSdkVersions(): Record<'openai' | 'anthropic' | 'pi' | 'codex', string> {
  return {
    openai: installedSdkVersion('openai'),
    anthropic: installedSdkVersion('anthropic'),
    pi: installedSdkVersion('pi'),
    codex: installedSdkVersion('codex'),
  };
}
