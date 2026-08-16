/**
 * WHICH module graph a claimed section makes the read-only floor load.
 *
 * The pack loader lives in `@rayspec/platform`, and resolving a pack means IMPORTING one — arbitrary
 * code from the deployment tree. A document that references no pack must therefore pay for none of
 * it: not the module, not the import. That is not a performance note, it is the property that keeps a
 * pack-free `doctor` byte-identical to what it always was.
 *
 * The `@rayspec/platform` mock factory below is the probe: it runs the FIRST time that module is
 * imported, so a counter inside it turns "did this document shape reach the loader?" into an
 * assertion. Both directions are pinned — a document with no `extensions[]` never loads it, and a
 * document WITH one does — because a probe that only ever reads zero proves nothing.
 *
 * The stubbed `parseSpecWithPacks` returns a fixed verdict; what the real one does with a real pack
 * is measured against the real fixture pack in `pack-sections.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The load counter lives in a hoisted bag: vi.mock is hoisted above the imports, so nothing else is
// visible inside the factory.
const h = vi.hoisted(() => ({ platformLoads: 0 }));

/** A validated document in the shape the core grammar produces (every section defaulted). */
const STUB_SPEC = {
  version: '1.0',
  metadata: { name: 'stubbed' },
  stores: [],
  api: [],
  agents: [],
  tooling: [],
  triggers: [],
  handlers: [],
  extensions: [],
};

vi.mock('@rayspec/platform', () => {
  h.platformLoads += 1;
  return {
    parseSpecWithPacks: () =>
      Promise.resolve({
        ok: true,
        value: {
          spec: STUB_SPEC,
          sections: {},
          extensions: { sections: [{ key: 'auditing', packId: 'stub-pack' }] },
        },
      }),
  };
});

import { runDoctor } from './doctor.js';

/** A document that references NO pack — the shape the loader must never be reached for. */
const PACK_FREE = "version: '1.0'\nmetadata:\n  name: no-packs-here\n";
/** The same document with one `extensions[]` entry — the shape that must reach it. */
const WITH_PACK = `version: '1.0'
metadata:
  name: one-pack
extensions:
  - id: some-pack
    module: ./pack
    version: 1.0.0
`;

let root = '';
let prevCwd: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rayspec-pack-section-imports-'));
  writeFileSync(join(root, 'pack-free.yaml'), PACK_FREE, 'utf8');
  writeFileSync(join(root, 'with-pack.yaml'), WITH_PACK, 'utf8');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  prevCwd = process.cwd();
  process.chdir(root);
});
afterEach(() => {
  process.chdir(prevCwd);
});

describe('the pack loader stays off the path of a document that references no pack', () => {
  it('a pack-free document never imports @rayspec/platform', async () => {
    const before = h.platformLoads;
    const result = await runDoctor(['pack-free.yaml']);
    expect(result.ok).toBe(true);
    expect(h.platformLoads).toBe(before);
  });

  it('a document that DOES reference a pack reaches the loader', async () => {
    const result = await runDoctor(['with-pack.yaml']);
    expect(result.ok).toBe(true);
    expect(h.platformLoads).toBeGreaterThan(0);
  });
});
