/**
 * `parseSpecWithPacks` — the section-aware parse wired to the pack loader.
 *
 * The load reads the document and its `extensions[]`; the loader resolves each referenced pack with
 * the SAME path jail and the SAME exact-version pin the merge already used; the lift hands each
 * claimed top-level section to the claiming pack's validator.
 *
 * THREE MESSAGES ARE PRODUCT SURFACE and are pinned verbatim here (with the throwaway root redacted —
 * it is the only part that moves), because each prescribes a DIFFERENT action and a wrong one costs
 * an operator a wasted deployment:
 *   • the pack is NOT on this deployment          → `extension_pack_unavailable` — deploy it;
 *   • the pack IS here and was refused (a skew)   → `extension_pack_refused` — deploying it again
 *                                                   changes nothing;
 *   • two present packs claim one section         → `extension_pack_refused`, naming both;
 *   • the pack is here and UNBUILT               → `extension_pack_refused` — its entry is
 *                                                   TypeScript source, which the deploy runtime
 *                                                   refuses; build it. That one sits between the
 *                                                   first two and is pinned at the end of this file.
 * A further case is pinned by its FULL error list rather than its wording: a document whose
 * `extensions[]` does not typecheck must not additionally report the section it declares as an
 * unknown field, which is the exact report this entry point exists to avoid.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as rayspecPlatform from '@rayspec/platform';
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

/** The same document referencing TWO packs, both of which claim `acme_notes`. */
const DOC_TWO_PACKS = `
version: '1.0'
metadata:
  name: base
extensions:
  - id: pack-a
    module: ./pack
    version: 1.0.0
  - id: pack-b
    module: ./pack-b
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
    // THE FULL LIST, not just "the pin error is in there". While `extensions[]` does not typecheck,
    // which top-level keys the packs own is unknowable — so the claimed section must NOT also be
    // reported as an unknown field. That second error would send an operator to delete a section the
    // referenced pack owns, over one character in the pin above it: the exact misreport this entry
    // point exists to prevent. Asserting only `.some(…)` cannot see it.
    expect(res.errors).toEqual([
      {
        code: 'schema_violation',
        path: 'extensions[0].version',
        message:
          'extension version must be an EXACT semver pin (MAJOR.MINOR.PATCH with optional ' +
          '-prerelease/+build) — ranges, wildcards (incl. uppercase X), floating dist-tags ' +
          '(latest/beta/…), and partial versions (1, 1.2) are rejected',
      },
    ]);
  });

  it('GOLDEN — the pack is PRESENT but its version skews: refused, not "unavailable"', async () => {
    const res = await parseSpecWithPacks(DOC, {
      packsRoot: root,
      deploymentRoot: root,
      importer: fakeImporter(
        new Map<string, Record<string, unknown>>([
          [
            resolve(root, 'pack', 'index.ts'),
            {
              default: defineExtension({
                version: '2.0.0',
                fragments: {},
                sections: [{ key: 'acme_notes', schemaModule: 'sections/notes.ts' }],
              }),
            },
          ],
          [resolve(root, 'pack', 'sections', 'notes.ts'), { default: PackSection }],
        ]),
      ),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      {
        code: 'extension_pack_refused',
        path: 'extensions[0]',
        message:
          "extension pack 'acme-notes' is present on this deployment but was REFUSED, so the " +
          'top-level sections it claims cannot be validated. Deploying it again changes nothing: ' +
          'fix the pack, or the extensions[] entry that references it. Load failure: version SKEW ' +
          "— the spec pins version '1.0.0' but the pack manifest declares version '2.0.0'. A " +
          'version skew is a HARD fail-closed error (never a silent skip): pin the exact version ' +
          'the pack declares, or update the pack.',
      },
    ]);
  });

  it('GOLDEN — two PRESENT packs claim one section: refused, naming both', async () => {
    const claiming = (): Record<string, unknown> => ({
      default: defineExtension({
        version: '1.0.0',
        fragments: {},
        sections: [{ key: 'acme_notes', schemaModule: 'sections/notes.ts' }],
      }),
    });
    const res = await parseSpecWithPacks(DOC_TWO_PACKS, {
      packsRoot: root,
      deploymentRoot: root,
      importer: fakeImporter(
        new Map<string, Record<string, unknown>>([
          [resolve(root, 'pack', 'index.ts'), claiming()],
          [resolve(root, 'pack', 'sections', 'notes.ts'), { default: PackSection }],
          [resolve(root, 'pack-b', 'index.ts'), claiming()],
          [resolve(root, 'pack-b', 'sections', 'notes.ts'), { default: PackSection }],
        ]),
      ),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      {
        code: 'extension_pack_refused',
        path: 'extensions[1]',
        message:
          "extension pack 'pack-b' is present on this deployment but was REFUSED, so the top-level " +
          'sections it claims cannot be validated. Deploying it again changes nothing: fix the ' +
          'pack, or the extensions[] entry that references it. Load failure: claims the top-level ' +
          "section 'acme_notes', which extension 'pack-a' already claims. Two packs cannot both own " +
          'one top-level key — nothing would decide whose grammar validates it (fail-closed ' +
          'collision).',
      },
    ]);
  });

  // The barrel gap this file cannot see: every case above imports `./parse-with-packs.js` by
  // relative path, which resolves whether or not the package EXPORTS the entry point. `.` is the
  // one declared export of @rayspec/platform, so this asserts the shipped surface through the
  // package specifier — the way the CHANGELOG says a consumer reaches it. It reads the BUILT dist
  // (as `gate:byte-identity` does), so it runs after `pnpm build`.
  it('is reachable from `@rayspec/platform` itself, not only by relative path', () => {
    expect(typeof rayspecPlatform.parseSpecWithPacks).toBe('function');
    // The two types that travel with it must be exported too, or a consumer can call it and not
    // name what it returns. Naming them through the package specifier is the assertion; the
    // expectations below just keep the bindings from being stripped as unused.
    const claim: rayspecPlatform.ExtensionSectionClaim = {
      key: 'acme_notes',
      schemaModule: 'sections/notes.ts',
    };
    const sections: rayspecPlatform.SpecWithPacks['sections'] = {};
    expect(claim.key).toBe('acme_notes');
    expect(sections).toEqual({});
  });
});

/**
 * The pack is ON DISK and UNBUILT — the entry the resolution lands on is TypeScript source, which the
 * production importer refuses because a deploy runtime loads compiled JavaScript only. This case runs
 * with NO injected importer, so the refusal is the real one a deploy meets, over a real file.
 *
 * It is the case between the two the file opens with, and the one that used to be reported as the
 * wrong one: the pack IS on this deployment, so `extension_pack_unavailable` would send an operator to
 * deploy what they already deployed, and never name the build that is the whole remedy.
 */
describe('parseSpecWithPacks — a pack that is present but not built', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-unbuilt-'));
    mkdirSync(join(root, 'pack'), { recursive: true });
    // Never imported: the production importer refuses a `.ts` path before it opens the file.
    writeFileSync(join(root, 'pack', 'index.ts'), 'export default {};\n', 'utf8');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('GOLDEN — refused, naming the build; never "unavailable"', async () => {
    const res = await parseSpecWithPacks(DOC, { packsRoot: root, deploymentRoot: root });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.code)).toEqual(['extension_pack_refused']);
    const [error] = res.errors;
    expect(error?.path).toBe('extensions[0]');
    expect(error?.message).toContain(
      "extension pack 'acme-notes' is present on this deployment but was REFUSED",
    );
    // The cause and the remedy, in the loader's own words — the reason the code had to change.
    expect(error?.message).toContain("is TypeScript source ('.ts')");
    expect(error?.message).toContain('Compile it to JavaScript first and deploy the built module');
  });

  it('the same document beside an EMPTY pack directory is unavailable — the control', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-absent-'));
    try {
      const res = await parseSpecWithPacks(DOC, { packsRoot: bare, deploymentRoot: bare });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.map((e) => e.code)).toEqual(['extension_pack_unavailable']);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
