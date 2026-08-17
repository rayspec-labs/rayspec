/**
 * THE REGRESSION FOR THE AMBIENT REDIRECT, WITH ITS OWN CONTROL.
 *
 * `parseFromDeploymentTree` defaults its `env` to `process.env`, and the root it resolves packs within
 * is `RAYSPEC_HANDLER_ROOT` when the deployment declares one, otherwise the spec's own directory. That
 * default is correct — it mirrors what the boot hands the loader, so a command previews the boot's tree
 * rather than a second guess at it — and it is exactly why an AMBIENT value is a redirect for any suite
 * that resolves packs: the suite measures a tree it did not build, and the failure surfaces as
 * assertion mismatches with no indication of the cause. Measured before this change, an empty decoy
 * turned 14 of 30 arms red across the three pack-resolving suites, which now clear the variable in
 * their own `beforeEach`.
 *
 * This file exists so that clearing cannot be removed silently. The first arm is the property; the
 * SECOND ARM IS THE CONTROL, and it is what makes the first one mean something — an implementation
 * that simply ignored the variable would satisfy arm one and fail arm two.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFromDeploymentTree } from './pack-sections.js';

/** A document that references a pack — the only kind that pays for the loader and so resolves a root. */
const DOC = `version: '1.0'

metadata:
  name: root-redirect-probe
  description: A document that references a pack, so the loader resolves a deployment tree.

extensions:
  - id: absent_pack
    module: ./absent-pack
    version: 1.0.0
`;

function treeWithSpec(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-root-redirect-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'rayspec.yaml'), DOC, 'utf8');
  return dir;
}

describe('the tree a command resolves packs within', () => {
  it('is the declared handler root when the deployment sets one — the boot resolves the same tree', async () => {
    const specTree = treeWithSpec();
    const declared = mkdtempSync(join(tmpdir(), 'rayspec-declared-root-'));
    const parsed = await parseFromDeploymentTree(join(specTree, 'sub', 'rayspec.yaml'), DOC, {
      RAYSPEC_HANDLER_ROOT: declared,
    });
    // The pack is absent from BOTH trees, so the refusal names the root that was searched.
    expect(JSON.stringify(parsed?.errors ?? [])).toContain(declared);
  });

  it("is the spec's own directory when none is declared — the control the first arm needs", async () => {
    const specTree = treeWithSpec();
    const parsed = await parseFromDeploymentTree(join(specTree, 'sub', 'rayspec.yaml'), DOC, {});
    expect(JSON.stringify(parsed?.errors ?? [])).toContain(join(specTree, 'sub'));
  });
});
