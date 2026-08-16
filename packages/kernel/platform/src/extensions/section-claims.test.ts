/**
 * `loadExtensions` — the `sections` contribution kind: the top-level spec keys a pack CLAIMS.
 *
 * Each case asserts a fail-closed property of the claim, so weakening one breaks a test:
 *   - the claim resolves through the SAME jailed, `.js`-preferred module resolution the pack entry
 *     and every pack handler use — a `schemaModule` outside the pack directory is refused;
 *   - the key is a SafeIdentifier;
 *   - a key the CORE grammar owns cannot be claimed, and the denylist is the grammar's own key set
 *     (never a second list that can drift) — the refusal names the pack;
 *   - two packs claiming ONE key is a load failure naming BOTH pack ids;
 *   - a schema module whose default export cannot validate anything is refused, naming the pack.
 *
 * No DB, no on-disk pack: the pack entry and its schema modules are provided through the injected
 * importer, exactly as the sibling `load-extensions.test.ts` does.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModuleImporter } from '../handlers/loader.js';
import { defineExtension, type ExtensionManifest } from './extension.js';
import { ExtensionLoadError, type ExtensionRefLike, loadExtensions } from './load-extensions.js';

/** A fake importer: maps an absolute module path → a module namespace. */
function fakeImporter(byPath: Map<string, Record<string, unknown>>): ModuleImporter {
  return async (absolutePath: string) => {
    const mod = byPath.get(absolutePath);
    if (!mod) throw new Error(`fake importer: nothing registered for ${absolutePath}`);
    return mod;
  };
}

/**
 * The pack-side grammar a claimed section is validated by. Written by hand rather than with this
 * repo's zod on purpose: a pack ships in its own repository with its own validation library, so the
 * contract the loader accepts is STRUCTURAL — a default export that can `safeParse` a node.
 */
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

/** A manifest that claims one top-level section. */
function manifestClaiming(
  key: string,
  schemaModule = 'sections/notes.ts',
  version = '1.0.0',
): ExtensionManifest {
  return { version, fragments: {}, sections: [{ key, schemaModule }] };
}

describe('loadExtensions — the sections contribution kind', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-sections-test-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ref = (over: Partial<ExtensionRefLike> = {}): ExtensionRefLike => ({
    id: 'acme-notes',
    module: './pack',
    version: '1.0.0',
    ...over,
  });

  /** Register a pack at `<root>/<dir>` whose entry claims `key` and whose schema module is `schema`. */
  function packModules(
    dir: string,
    manifest: ExtensionManifest,
    schema: unknown = PackSection,
    schemaModule = 'sections/notes.ts',
  ): Array<[string, Record<string, unknown>]> {
    return [
      [resolve(root, dir, 'index.ts'), { default: defineExtension(manifest) }],
      [resolve(root, dir, schemaModule), { default: schema }],
    ];
  }

  it('a manifest without `sections` claims nothing (a strict no-op)', async () => {
    const importer = fakeImporter(
      new Map([
        [
          resolve(root, 'pack', 'index.ts'),
          { default: defineExtension({ version: '1.0.0', fragments: {} }) },
        ],
      ]),
    );
    const out = await loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer });
    expect(out.sections).toEqual([]);
  });

  it('resolves the claim: key, owning pack id, and a validator built from the schema module', async () => {
    const importer = fakeImporter(new Map(packModules('pack', manifestClaiming('acme_notes'))));
    const out = await loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer });
    expect(out.sections).toHaveLength(1);
    expect(out.sections[0]?.key).toBe('acme_notes');
    expect(out.sections[0]?.packId).toBe('acme-notes');
    const good = out.sections[0]?.validate({ retentionDays: 30 });
    expect(good?.ok).toBe(true);
    const bad = out.sections[0]?.validate({ retentionDays: -1 });
    expect(bad?.ok).toBe(false);
  });

  it('PATH-JAIL FAIL-CLOSED: a `schemaModule` outside the pack directory is refused', async () => {
    const importer = fakeImporter(
      new Map(packModules('pack', manifestClaiming('acme_notes', '../outside.ts'))),
    );
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(ExtensionLoadError);
  });

  it('an unloadable `schemaModule` is refused, naming the pack', async () => {
    // Only the entry is registered — the schema module import fails.
    const importer = fakeImporter(
      new Map([
        [
          resolve(root, 'pack', 'index.ts'),
          { default: defineExtension(manifestClaiming('acme_notes')) },
        ],
      ]),
    );
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/acme-notes/);
  });

  it('a schema module that cannot validate anything is refused, naming the pack', async () => {
    const importer = fakeImporter(
      new Map(packModules('pack', manifestClaiming('acme_notes'), { notASchema: true })),
    );
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/acme-notes/);
  });

  it('the key must be a safe identifier', async () => {
    const importer = fakeImporter(new Map(packModules('pack', manifestClaiming('Acme-Notes'))));
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/acme-notes/);
  });

  it.each([
    'stores',
    'api',
    'agents',
    'extensions',
    'version',
    'metadata',
    'managed',
  ])('a key the core grammar owns cannot be claimed: %s', async (key) => {
    const importer = fakeImporter(new Map(packModules('pack', manifestClaiming(key))));
    const err = await loadExtensions([ref()], {
      packsRoot: root,
      deploymentRoot: root,
      importer,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionLoadError);
    expect((err as Error).message).toContain('acme-notes');
    expect((err as Error).message).toContain(key);
  });

  it('two packs claiming ONE key is a load failure naming BOTH pack ids', async () => {
    const importer = fakeImporter(
      new Map([
        ...packModules('pack-a', manifestClaiming('acme_notes')),
        ...packModules('pack-b', manifestClaiming('acme_notes')),
      ]),
    );
    const err = await loadExtensions(
      [ref({ id: 'pack-a', module: './pack-a' }), ref({ id: 'pack-b', module: './pack-b' })],
      { packsRoot: root, deploymentRoot: root, importer },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionLoadError);
    expect((err as Error).message).toContain('pack-a');
    expect((err as Error).message).toContain('pack-b');
    expect((err as Error).message).toContain('acme_notes');
  });

  it('two packs claiming DIFFERENT keys both resolve', async () => {
    const importer = fakeImporter(
      new Map([
        ...packModules('pack-a', manifestClaiming('acme_notes')),
        ...packModules('pack-b', manifestClaiming('acme_audit')),
      ]),
    );
    const out = await loadExtensions(
      [ref({ id: 'pack-a', module: './pack-a' }), ref({ id: 'pack-b', module: './pack-b' })],
      { packsRoot: root, deploymentRoot: root, importer },
    );
    expect(out.sections.map((s) => `${s.packId}:${s.key}`)).toEqual([
      'pack-a:acme_notes',
      'pack-b:acme_audit',
    ]);
  });
});
