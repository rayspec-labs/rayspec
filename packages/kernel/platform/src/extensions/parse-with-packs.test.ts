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
 *   • the pack is here and its ENTRY DID NOT LOAD → `extension_pack_refused`, under its own
 *                                                   sentence: the artifact is incomplete, and the
 *                                                   importer's message says how. Two causes reach
 *                                                   it — an UNBUILT pack (a TypeScript entry the
 *                                                   deploy runtime refuses) and a pack shipped
 *                                                   without the dependencies its entry imports —
 *                                                   and both are pinned at the end of this file.
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

  it('GOLDEN — the pack is absent: a typed parse error naming it, and NOT the importer’s words', async () => {
    // Nothing registered AND nothing on disk ⇒ the deployment does not have this pack.
    //
    // WHAT THE MESSAGE MUST NOT BE. The entry resolution prefers a compiled sibling and otherwise
    // falls back to the declared `.ts` WITHOUT asking whether anything is at it, so for an absent
    // pack the path handed to the importer is a guess. Carrying the importer's complaint about that
    // path is how this refusal came to describe a file that was never written — and under the
    // production importer, which refuses on the EXTENSION before opening anything, the complaint was
    // "compile it to JavaScript first", inside a refusal whose own remedy is to deploy the pack.
    // The disk is asked instead, and every path that was looked for is named.
    const res = await parseSpecWithPacks(DOC, {
      packsRoot: root,
      deploymentRoot: root,
      importer: fakeImporter(new Map()),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const compiled = resolve(root, 'pack', 'index.js');
    const source = resolve(root, 'pack', 'index.ts');
    expect(res.errors).toEqual([
      {
        code: 'extension_pack_unavailable',
        path: 'extensions[0]',
        message:
          "extension pack 'acme-notes' is not available on this deployment — a pack owns the " +
          'grammar of every top-level section it claims, so a document that declares one cannot be ' +
          'validated without it. Deploy the pack, or remove it from extensions[] together with the ' +
          "sections it claims. Load failure: the pack entry ('index.ts') is not on disk. Neither " +
          `'${compiled}' nor '${source}' exists, so nothing was loaded and no ` +
          'file was inspected — this is an absent module, not a module of the wrong kind. ' +
          'Fail-closed.',
      },
    ]);
    // The ACCEPT CONTROL for this case: the sentence the old message carried must be gone. Without
    // it the assertion above would pass against a message that ALSO told the operator to compile
    // something, which is the defect.
    const [error] = res.errors;
    expect(error?.message).not.toContain('Compile it to JavaScript first');
    expect(error?.message).not.toContain("is TypeScript source ('.ts')");
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
 * The pack is ON DISK and its ENTRY DID NOT LOAD. Both cases here run with NO injected importer, so
 * the failure is the real one a deploy meets, over a real file.
 *
 * This is the class between the two the file opens with, and the one whose CODE used to be wrong: the
 * pack IS on this deployment, so `extension_pack_unavailable` sent an operator to deploy what they
 * had already deployed. What the old report did carry, in both classes, is the importer's own message
 * — so the build was named there too, and it still is. What changed is the code and the sentence that
 * prescribes an action.
 *
 * Its own remedy sentence is pinned in BOTH cases, because they are the reason it cannot borrow the
 * read-and-refused one: an unbuilt pack needs a build, a pack shipped without its dependencies needs
 * the directory deployed complete, and "deploying it again changes nothing" is false for the second.
 */
describe('parseSpecWithPacks — a pack that is present and whose entry does not load', () => {
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

  it('GOLDEN — UNBUILT: refused, naming the build; never "unavailable"', async () => {
    const res = await parseSpecWithPacks(DOC, { packsRoot: root, deploymentRoot: root });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors.map((e) => e.code)).toEqual(['extension_pack_refused']);
    const [error] = res.errors;
    expect(error?.path).toBe('extensions[0]');
    expect(error?.message).toContain(
      "extension pack 'acme-notes' is present on this deployment but its ENTRY MODULE DID NOT LOAD",
    );
    // The remedy sentence names BOTH artifact faults and prescribes neither a deploy nor nothing.
    expect(error?.message).toContain('deploying the same artifact again lands the same way');
    expect(error?.message).toContain('did not arrive with the dependencies its entry imports');
    // The cause and the concrete remedy, in the loader's own words.
    expect(error?.message).toContain("is TypeScript source ('.ts')");
    expect(error?.message).toContain('Compile it to JavaScript first and deploy the built module');
  });

  it('GOLDEN — BUILT but shipped without its dependencies: the same class, never "unavailable"', async () => {
    // `dist/` without `node_modules/`, which the bundled example README documents as a shipping
    // hazard: the entry is compiled JavaScript, resolution lands on it, and the import throws. The
    // remedy here is to deploy the pack DIRECTORY complete — so a refusal asserting that deploying it
    // again changes nothing would be as wrong as the "deploy the pack" this class was moved off.
    const shipped = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-nodeps-'));
    try {
      mkdirSync(join(shipped, 'pack'), { recursive: true });
      writeFileSync(
        join(shipped, 'pack', 'index.js'),
        "import 'no-such-dependency-the-pack-needs';\nexport default {};\n",
        'utf8',
      );
      const res = await parseSpecWithPacks(DOC, {
        packsRoot: shipped,
        deploymentRoot: shipped,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.map((e) => e.code)).toEqual(['extension_pack_refused']);
      const [error] = res.errors;
      expect(error?.message).toContain(
        "extension pack 'acme-notes' is present on this deployment but its ENTRY MODULE DID NOT LOAD",
      );
      expect(error?.message).toContain('did not arrive with the dependencies its entry imports');
      // NOT the read-and-refused sentence: re-deploying the directory, complete, IS the fix here.
      expect(error?.message).not.toContain('Deploying it again changes nothing');
      // The importer's own words say WHICH of the two faults this is.
      expect(error?.message).toContain('no-such-dependency-the-pack-needs');
    } finally {
      rmSync(shipped, { recursive: true, force: true });
    }
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

/**
 * THE MODULE A MANIFEST DECLARES AND THE PACK DOES NOT CONTAIN — the rest of the class.
 *
 * The entry is not the only module a pack names. A manifest also declares SERVICE modules and, for
 * every top-level section it claims, a SCHEMA module; all three reach their importer through the same
 * resolution, whose `.ts` fallback is a guess when nothing is on disk. Nothing had swept past the
 * entry, so both of these still answered with the production importer's complaint about the extension
 * of a path that was never written — and, because they fell through to the read-and-refused class,
 * they said "deploying it again changes nothing" over a pack that may simply have arrived incomplete.
 *
 * Run with NO injected importer, so the refusal is the one a real deploy meets over a real directory.
 */
describe('parseSpecWithPacks — a module the manifest declares is not on disk', () => {
  /** A pack whose ENTRY is real, built and loadable — only the module it names is missing. */
  function packDeclaring(root: string, manifestBody: string): void {
    mkdirSync(join(root, 'pack'), { recursive: true });
    writeFileSync(join(root, 'pack', 'index.js'), manifestBody, 'utf8');
  }

  it('a declared SERVICE module that is absent: named as absent, never as the wrong kind of file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-nosvc-'));
    try {
      packDeclaring(
        root,
        "export default { __rayspecExtension: '@rayspec/extension@1', version: '1.0.0', " +
          "fragments: {}, services: [{ module: './services/audit.ts' }] };\n",
      );
      const res = await parseSpecWithPacks(DOC, { packsRoot: root, deploymentRoot: root });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.map((e) => e.code)).toEqual(['extension_pack_refused']);
      const [error] = res.errors;
      // ACCEPT CONTROL — the two sentences the old message carried, both false here. A test that
      // asserted only the new wording would pass against a message that still said these.
      expect(error?.message).not.toContain('Compile it to JavaScript first');
      expect(error?.message).not.toContain("is TypeScript source ('.ts')");
      expect(error?.message).not.toContain('Deploying it again changes nothing');
      // What it says instead: the pack is here, the module is not, and BOTH causes are named —
      // a manifest pointing at a path the pack lacks, and a directory deployed partially.
      expect(error?.message).toContain('a MODULE ITS MANIFEST DECLARES did not load');
      expect(error?.message).toContain('either absent from this pack, or not built, or missing');
      // The evidence: the module, and every path that was looked for.
      expect(error?.message).toContain("the service module ('./services/audit.ts') is not on disk");
      expect(error?.message).toContain(resolve(root, 'pack', 'services', 'audit.js'));
      expect(error?.message).toContain(resolve(root, 'pack', 'services', 'audit.ts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a claimed section’s SCHEMA module that is absent: the same class, the same evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-noschema-'));
    try {
      packDeclaring(
        root,
        "export default { __rayspecExtension: '@rayspec/extension@1', version: '1.0.0', " +
          "fragments: {}, sections: [{ key: 'acme_notes', schemaModule: './sections/notes.ts' }] };\n",
      );
      const res = await parseSpecWithPacks(DOC, { packsRoot: root, deploymentRoot: root });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.map((e) => e.code)).toEqual(['extension_pack_refused']);
      const [error] = res.errors;
      expect(error?.message).not.toContain('Compile it to JavaScript first');
      expect(error?.message).not.toContain('Deploying it again changes nothing');
      expect(error?.message).toContain('a MODULE ITS MANIFEST DECLARES did not load');
      expect(error?.message).toContain(
        "the schema module for the claimed section 'acme_notes' ('./sections/notes.ts') is not on disk",
      );
      expect(error?.message).toContain(resolve(root, 'pack', 'sections', 'notes.js'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('CONTROL — a declared module that IS on disk and is the wrong kind still says so', async () => {
    // The other half of the accept control: the "compile it" sentence is not being suppressed
    // globally, it is being kept off the case it was false for. Here the file IS there, as
    // TypeScript source, and the production importer's complaint is exactly right.
    const root = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-svc-ts-'));
    try {
      packDeclaring(
        root,
        "export default { __rayspecExtension: '@rayspec/extension@1', version: '1.0.0', " +
          "fragments: {}, services: [{ module: './services/audit.ts' }] };\n",
      );
      mkdirSync(join(root, 'pack', 'services'), { recursive: true });
      writeFileSync(join(root, 'pack', 'services', 'audit.ts'), 'export default {};\n', 'utf8');
      const res = await parseSpecWithPacks(DOC, { packsRoot: root, deploymentRoot: root });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      const [error] = res.errors;
      expect(error?.message).toContain("is TypeScript source ('.ts')");
      expect(error?.message).toContain('Compile it to JavaScript first');
      expect(error?.message).not.toContain("('./services/audit.ts') is not on disk");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * THE ABSENT PACK, UNDER THE PRODUCTION IMPORTER — the case the suite above could not see.
 *
 * The golden absent-pack case injects a fake importer, so the message it pins is the FAKE's. That is
 * what let the production wording drift: under the real importer an absent pack was refused on the
 * EXTENSION of the `.ts` the resolution guessed, and told to compile it. This runs the same absence
 * with NO importer injected, which is what a deploy does.
 */
describe('parseSpecWithPacks — an absent pack under the production importer', () => {
  it('says nothing is on disk, and never prescribes a build', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rayspec-parse-packs-ghost-'));
    try {
      const res = await parseSpecWithPacks(DOC, { packsRoot: root, deploymentRoot: root });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errors.map((e) => e.code)).toEqual(['extension_pack_unavailable']);
      const [error] = res.errors;
      // ACCEPT CONTROL: the exact sentences the shipped message used to carry.
      expect(error?.message).not.toContain('Compile it to JavaScript first');
      expect(error?.message).not.toContain("is TypeScript source ('.ts')");
      // And what it says instead — which agrees with docs/cli-reference.md ("nothing is on disk at
      // the entry the reference resolves to, so install it").
      expect(error?.message).toContain("the pack entry ('index.ts') is not on disk");
      expect(error?.message).toContain('Deploy the pack, or remove it from extensions[]');
      expect(error?.message).toContain(resolve(root, 'pack', 'index.js'));
      expect(error?.message).toContain(resolve(root, 'pack', 'index.ts'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
