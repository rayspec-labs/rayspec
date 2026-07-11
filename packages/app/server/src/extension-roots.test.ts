/**
 * The MANIFEST-DERIVED gate-root discovery, unit-tested (CI-enforced, not just
 * manually RED-first-proven). The two escape-hatch gates (`check-handler-imports.mjs` +
 * `check-extension-capability.mjs`) DISCOVER the extension-pack handler roots from every deployment
 * YAML's `extensions[].module` dirs via the shared `discoverExtensionHandlerRoots`. This asserts the
 * discovery mechanism so a regression (e.g. an extractor that stops finding the pack) goes RED HERE —
 * which would otherwise SILENTLY exempt a pack's handlers from BOTH gates.
 *
 * (The actual gate-BITE on a planted pack-root violation is RED-first-reproduced by the PM + lives in
 * each gate's own scan; this proves the prerequisite: the pack root is FOUND.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The gate-shared discovery lib (a plain .mjs at the repo root scripts/).
import {
  discoverExtensionHandlerRoots,
  extractExtensionModules,
} from '../../../../scripts/lib/extension-roots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// packages/server/src -> repo root.
const REPO_ROOT = resolve(here, '../../../..');

describe('manifest-derived extension handler-root discovery', () => {
  it('DISCOVERS the stream pack handler root from the deployment YAML (so the gates scan it)', () => {
    const { roots, escapes } = discoverExtensionHandlerRoots(REPO_ROOT);
    expect(escapes).toEqual([]); // no pack module escapes the repo jail.
    // The stream-backend deployment YAML references ./packs/stream-pack → its handlers/ dir is scanned.
    expect(roots).toContain('examples/stream-backend/packs/stream-pack/handlers');
  });

  it('extractExtensionModules pulls module dirs from a BLOCK-form extensions[] (and ignores other sections)', () => {
    const block = extractExtensionModules(
      [
        "version: '1.0'",
        'metadata:',
        '  name: x',
        'extensions:',
        '  - id: a',
        '    module: ./packs/a',
        '    version: 1.0.0',
        'stores:',
        '  - name: s', // a different section — its `module` (if any) must NOT be captured
        '    module: not-an-extension',
      ].join('\n'),
    );
    expect(block).toEqual(['./packs/a']);
  });

  // FIX B — the extractor uses the REAL yaml parser, so INLINE-FLOW + FOLDED-SCALAR forms (which the old
  // hand-rolled line parser was BLIND to → a pack escaping both gates) are now discovered. This is the
  // mislabeled-blind test, corrected to ACTUALLY use the inline-flow `extensions: [{...}]` form.
  it('extractExtensionModules discovers an INLINE-FLOW extensions[] (`extensions: [{ id, module, version }]`)', () => {
    // Old parser: [] (blind). New parser: the real module dir.
    const oneLine = extractExtensionModules(
      "version: '1.0'\nmetadata:\n  name: x\nextensions: [{ id: a, module: ./packs/a, version: 1.0.0 }]\n",
    );
    expect(oneLine).toEqual(['./packs/a']);
    // The inline-flow ENTRY form (`- { id, module, version }`) likewise.
    const inlineEntry = extractExtensionModules(
      "version: '1.0'\nextensions:\n  - { id: b, module: ./packs/b, version: 1.0.0 }\n",
    );
    expect(inlineEntry).toEqual(['./packs/b']);
  });

  it('extractExtensionModules discovers a FOLDED-SCALAR module (the old parser captured `>-`, not the path)', () => {
    const folded = extractExtensionModules(
      ['extensions:', '  - id: a', '    module: >-', '      ./packs/a', '    version: 1.0.0'].join(
        '\n',
      ),
    );
    expect(folded).toEqual(['./packs/a']);
  });

  // FIX B RED-first: a planted INLINE-FLOW pack whose handler carries a forbidden import is now
  // DISCOVERED (so the gate scans + bites it). BEFORE the fix the inline-flow form yielded `[]` → the
  // pack's handlers were silently exempted from both gates. This asserts the discovery prerequisite on
  // an inline-flow YAML in a throwaway repo tree (the actual scan-bite is in each gate's own walk).
  describe('FIX B — an inline-flow pack handler root IS discovered (would otherwise escape both gates)', () => {
    let fakeRepo: string;
    let specRel: string;
    beforeAll(() => {
      fakeRepo = mkdtempSync(join(tmpdir(), 'rayspec-ext-roots-inlineflow-'));
      const handlersDir = join(fakeRepo, 'deploy', 'packs', 'p', 'handlers');
      mkdirSync(handlersDir, { recursive: true });
      // A handler that imports a forbidden module — the gate must SCAN it (after discovery finds it).
      writeFileSync(
        join(handlersDir, 'x.ts'),
        "import { forTenant } from '@rayspec/db';\nexport const run = () => {};\n",
        'utf8',
      );
      writeFileSync(
        join(fakeRepo, 'deploy', 'rayspec.yaml'),
        "version: '1.0'\nmetadata:\n  name: x\nextensions: [{ id: p, module: ./packs/p, version: 1.0.0 }]\n",
        'utf8',
      );
      specRel = relative(fakeRepo, join(fakeRepo, 'deploy', 'rayspec.yaml'));
    });
    afterAll(() => {
      rmSync(fakeRepo, { recursive: true, force: true });
    });

    it('discovers the inline-flow pack handler root (so the gate scans it)', () => {
      const { roots, escapes } = discoverExtensionHandlerRoots(fakeRepo, [specRel]);
      expect(escapes).toEqual([]);
      expect(roots).toContain('deploy/packs/p/handlers');
    });
  });

  describe('a `..`-escaping pack module is surfaced as an ESCAPE (a gate failure), not skipped', () => {
    // A throwaway "repo" tree with a deployment YAML whose extensions[].module climbs OUT of the repo.
    let fakeRepo: string;
    let specRel: string;
    beforeAll(() => {
      fakeRepo = mkdtempSync(join(tmpdir(), 'rayspec-ext-roots-'));
      const deployDir = join(fakeRepo, 'deploy');
      mkdirSync(deployDir, { recursive: true });
      // `../../../../etc` climbs above the fake repo root → an escape.
      writeFileSync(
        join(deployDir, 'rayspec.yaml'),
        "version: '1.0'\nmetadata:\n  name: x\nextensions:\n  - { id: e, module: ../../../../etc, version: 1.0.0 }\n",
        'utf8',
      );
      specRel = relative(fakeRepo, join(deployDir, 'rayspec.yaml'));
    });
    afterAll(() => {
      rmSync(fakeRepo, { recursive: true, force: true });
    });

    it('returns the escape (the gate exits 1 on a non-empty escapes list)', () => {
      const { roots, escapes } = discoverExtensionHandlerRoots(fakeRepo, [specRel]);
      expect(roots).toEqual([]); // an escaping module contributes NO scan root.
      expect(escapes).toHaveLength(1);
      expect(escapes[0]?.module).toBe('../../../../etc');
    });
  });
});
