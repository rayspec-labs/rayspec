/**
 * `parseSpecWithPacks` — the two-phase parse wired to the pack loader.
 *
 * Phase A loads the document and reads its `extensions[]`; the loader resolves each referenced pack
 * with the SAME path jail and the SAME exact-version pin the merge already used; phase B hands each
 * claimed top-level section to the claiming pack's validator.
 *
 * The golden case is the one an operator meets: a document that declares a claimed section, taken to
 * a deployment where the pack is NOT there. Its code, path and message are product surface, so they
 * are pinned verbatim (with the throwaway root redacted — it is the only part that moves).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModuleImporter } from '../handlers/loader.js';
import { defineExtension } from './extension.js';
import { parseSpecWithPacks } from './parse-with-packs.js';

/** The pack's own grammar — structural, because a pack brings its own validation library. */
const PackSection = {
  safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown } {
    const days = (value as { retentionDays?: unknown } | null)?.retentionDays;
    if (typeof days === 'number' && Number.isInteger(days) && days > 0) {
      return { success: true, data: { retentionDays: days } };
    }
    return {
      success: false,
      error: {
        issues: [
          {
            code: 'custom',
            path: ['retentionDays'],
            message: 'retentionDays must be a positive integer',
          },
        ],
      },
    };
  },
};

/** A document that declares the pack AND the section the pack claims. */
const DOC = `
version: '1.0'
metadata:
  name: base
extensions:
  - id: acme-notes
    module: ./pack
    version: 1.0.0
acme_notes:
  retentionDays: 30
`;

function fakeImporter(byPath: Map<string, Record<string, unknown>>): ModuleImporter {
  return async (absolutePath: string) => {
    const mod = byPath.get(absolutePath);
    if (!mod) throw new Error(`fake importer: nothing registered for ${absolutePath}`);
    return mod;
  };
}

describe('parseSpecWithPacks — a document whose top-level section a pack owns', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function packPresent(): ModuleImporter {
    return fakeImporter(
      new Map<string, Record<string, unknown>>([
        [
          resolve(root, 'pack', 'index.ts'),
          {
            default: defineExtension({
              version: '1.0.0',
              fragments: {},
              sections: [{ key: 'acme_notes', schemaModule: 'sections/notes.ts' }],
            }),
          },
        ],
        [resolve(root, 'pack', 'sections', 'notes.ts'), { default: PackSection }],
      ]),
    );
  }

  it('validates the claimed section through the pack, and keeps it out of the core document', async () => {
    const res = await parseSpecWithPacks(DOC, {
      packsRoot: root,
      deploymentRoot: root,
      importer: packPresent(),
    });
    if (!res.ok) throw new Error(`expected a clean parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.sections).toEqual({ acme_notes: { retentionDays: 30 } });
    expect(Object.hasOwn(res.value.spec, 'acme_notes')).toBe(false);
    // The loaded packs come back with the parse, so a caller that also merges does not load twice.
    expect(res.value.extensions?.sections).toHaveLength(1);
  });

  it('a section body the pack refuses fails the parse, under the section key', async () => {
    const res = await parseSpecWithPacks(DOC.replace('retentionDays: 30', 'retentionDays: 0'), {
      packsRoot: root,
      deploymentRoot: root,
      importer: packPresent(),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.path)).toContain('acme_notes.retentionDays');
  });

  it('GOLDEN — the pack is absent: a typed parse error naming it', async () => {
    // Nothing registered ⇒ the pack entry cannot be loaded: the deployment does not have this pack.
    const res = await parseSpecWithPacks(DOC, {
      packsRoot: root,
      deploymentRoot: root,
      importer: fakeImporter(new Map()),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const entry = resolve(root, 'pack', 'index.ts');
    expect(res.errors).toEqual([
      {
        code: 'extension_pack_unavailable',
        path: 'extensions[0]',
        message:
          "extension pack 'acme-notes' is not available on this deployment — a pack owns the " +
          'grammar of every top-level section it claims, so a document that declares one cannot be ' +
          'validated without it. Deploy the pack, or remove it from extensions[] together with the ' +
          "sections it claims. Load failure: failed to load pack entry 'index.ts' " +
          `(${entry}): fake importer: nothing registered for ${entry} — a pack's entry module must ` +
          'default-export a defineExtension(...) manifest (fail-closed).',
      },
    ]);
  });

  it('a document that references no pack is parsed exactly as `parseSpec` does', async () => {
    let called = false;
    const res = await parseSpecWithPacks("version: '1.0'\nmetadata:\n  name: base\n", {
      packsRoot: root,
      deploymentRoot: root,
      importer: async (p: string) => {
        called = true;
        throw new Error(`must not import ${p}`);
      },
    });
    if (!res.ok) throw new Error(`expected a clean parse:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(called).toBe(false);
    expect(res.value.sections).toEqual({});
    expect(res.value.extensions).toBeUndefined();
  });

  it('a version pin that is not EXACT fails closed before any pack module is imported', async () => {
    let called = false;
    const res = await parseSpecWithPacks(DOC.replace('version: 1.0.0', "version: '^1.0.0'"), {
      packsRoot: root,
      deploymentRoot: root,
      importer: async (p: string) => {
        called = true;
        throw new Error(`must not import ${p}`);
      },
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(called).toBe(false);
    expect(res.errors.some((e) => e.path === 'extensions[0].version')).toBe(true);
  });
});
