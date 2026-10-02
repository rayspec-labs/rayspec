/**
 * The three reference applications under examples/, as a consumer handles them before anything is
 * deployed: each builds with its own script, packs with the real CLI, and passes `bundle inspect`
 * and `bundle verify`; each seed rebuilds byte for byte and adds up to its recorded inventory; and
 * the native-addon fixture is refused by pack with the precise reason. No database: the deployments
 * are in reference-apps.db.test.ts.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAnySpec } from '@rayspec/spec';
import { afterAll, describe, expect, it } from 'vitest';
import {
  cli,
  EXAMPLES,
  inspectAndVerify,
  type ParsedJson,
  pack,
  removeScratch,
  runNode,
  scratch,
} from './test-support/reference-apps.js';

afterAll(removeScratch);

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const paths = (envelope: ParsedJson): string[] =>
  (envelope.data.inclusion as { path: string }[]).map((f) => f.path);

/** Code-point order, independent of the examples' own helpers. */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every file under `dir`, relative, sorted. */
function tree(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...tree(dir, rel));
    else out.push(rel);
  }
  return out.sort(byCodePoint);
}

describe('team notes', () => {
  const app = join(EXAMPLES, 'team-notes');
  const builds: Record<string, string> = {};
  for (const release of ['v1', 'v2', 'v3']) {
    builds[release] = join(scratch(`team-notes-${release}-`), 'app');
    runNode(join(app, 'build.mjs'), [`--release=${release}`, `--out=${builds[release]}`]);
  }

  it("writes each release's own version and store fields where the UI reads them", () => {
    const expected = {
      v1: { version: '1.0.0', fields: ['title', 'content'] },
      v2: { version: '1.1.0', fields: ['title', 'content', 'label'] },
      v3: { version: '2.0.0', fields: ['title', 'label'] },
    };
    for (const [release, want] of Object.entries(expected)) {
      const dir = builds[release]!;
      const parsed = parseAnySpec(readFileSync(join(dir, 'rayspec.yaml'), 'utf8'));
      expect(parsed.ok, release).toBe(true);
      if (!parsed.ok || parsed.kind !== 'rayspec') throw new Error(release);
      const spec = parsed.spec;
      const appVersion = JSON.parse(
        readFileSync(join(dir, 'web', 'dist', 'app-version.json'), 'utf8'),
      );
      expect(appVersion).toEqual({ application: 'team-notes', ...want });
      expect(spec.metadata.version).toBe(want.version);
      expect(spec.stores.find((s) => s.name === 'notes')?.columns.map((c) => c.name)).toEqual(
        want.fields,
      );
      expect(tree(join(dir, 'web', 'dist'))).toEqual([
        'app-version.json',
        'app.css',
        'app.js',
        'index.html',
      ]);
    }
  });

  it('refuses to build a release whose spec names another version', () => {
    const copy = scratch('team-notes-copy-');
    cpSync(join(app, 'build.mjs'), join(copy, 'build.mjs'));
    cpSync(join(app, 'web'), join(copy, 'web'), { recursive: true });
    cpSync(join(app, 'releases'), join(copy, 'releases'), { recursive: true });
    const spec = join(copy, 'releases', 'v2.yaml');
    const text = readFileSync(spec, 'utf8');
    expect(text).toContain("  version: '1.1.0'\n");
    writeFileSync(spec, text.split("  version: '1.1.0'\n").join("  version: '1.1.1'\n"));
    expect(() =>
      runNode(join(copy, 'build.mjs'), ['--release=v2', `--out=${join(copy, 'o')}`]),
    ).toThrow(/does not declare metadata\.version '1\.1\.0'/);
    expect(existsSync(join(copy, 'o'))).toBe(false);
  });

  it('packs, inspects and verifies; the application version is its own, not the runtime one', () => {
    const output = join(scratch('team-notes-ray-'), 'team-notes-1.0.0.ray');
    const packed = pack(join(builds.v1!, 'rayspec.yaml'), output);
    expect(paths(packed.envelope)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
      'payload/web/dist/app-version.json',
      'payload/web/dist/app.css',
      'payload/web/dist/app.js',
      'payload/web/dist/index.html',
    ]);
    const { inspected, verified } = inspectAndVerify(output);
    expect(inspected).toMatchObject({
      applicationId: 'team-notes',
      applicationVersion: '1.0.0',
      execution: 'none',
      egressHosts: [],
      bindings: [],
      requires: ['declarative-api', 'declarative-stores', 'static-frontend'],
    });
    expect(inspected.runtimeVersion).not.toBe(inspected.applicationVersion);
    expect(verified.sha256).toBe(packed.sha256);
  });

  it('carries a seed of 100 notes that rebuilds byte for byte and adds up to its inventory', () => {
    const committed = readFileSync(join(app, 'seed', 'notes.json'));
    const rebuilt = join(scratch('team-notes-seed-'), 'notes.json');
    runNode(join(app, 'seed', 'build-seed.mjs'), [`--out=${rebuilt}`]);
    expect(sha256(readFileSync(rebuilt))).toBe(sha256(committed));

    const seed = JSON.parse(committed.toString('utf8')) as {
      inventory: { notes: number; byAuthor: Record<string, number>; digest: string };
      notes: { key: string; author: string; title: string; content: string }[];
    };
    expect(seed.notes).toHaveLength(100);
    expect(new Set(seed.notes.map((n) => n.key)).size).toBe(100);
    expect(seed.inventory.byAuthor).toEqual({ first: 50, second: 50 });
    expect(seed.notes.some((n) => /[^\x20-\x7e]/.test(n.title))).toBe(true);
    // The digest, recomputed here from its definition rather than with the example's helper.
    const pairs = seed.notes
      .map((n) => [n.title, n.content])
      .sort((a, b) => byCodePoint(a[0]!, b[0]!) || byCodePoint(a[1]!, b[1]!));
    expect(sha256(JSON.stringify(pairs))).toBe(seed.inventory.digest);
  });
});

describe('document intake', () => {
  const app = join(EXAMPLES, 'document-intake');
  const manifest = JSON.parse(readFileSync(join(app, 'seed', 'manifest.json'), 'utf8')) as {
    inventory: Record<string, number>;
    documents: {
      file_id: string;
      file: string;
      content_type: string;
      size_bytes: number;
      sha256: string;
      expected: {
        quantity: number;
        lines: unknown[];
        category: string | null;
        received_on: string | null;
      };
    }[];
  };

  it('carries a seed of 50 documents whose hashes and inventory match the files', () => {
    expect(manifest.documents).toHaveLength(50);
    for (const doc of manifest.documents) {
      const bytes = readFileSync(join(app, 'seed', doc.file));
      expect(bytes.length, doc.file).toBe(doc.size_bytes);
      expect(sha256(bytes), doc.file).toBe(doc.sha256);
      const magic = bytes.subarray(0, 5).toString('latin1');
      expect(magic === '%PDF-', doc.file).toBe(doc.content_type === 'application/pdf');
    }
    const docs = manifest.documents;
    expect(manifest.inventory).toEqual({
      documents: 50,
      text: docs.filter((d) => d.content_type === 'text/plain').length,
      pdf: docs.filter((d) => d.content_type === 'application/pdf').length,
      total_quantity: docs.reduce((s, d) => s + d.expected.quantity, 0),
      total_lines: docs.reduce((s, d) => s + d.expected.lines.length, 0),
      without_category: docs.filter((d) => d.expected.category === null).length,
      without_received_on: docs.filter((d) => d.expected.received_on === null).length,
    });
    expect(manifest.inventory.pdf).toBe(10);
  });

  it('rebuilds the seed byte for byte', () => {
    const out = scratch('document-intake-seed-');
    runNode(join(app, 'seed', 'build-seed.mjs'), [`--out=${out}`]);
    const rebuilt = tree(out);
    expect(rebuilt).toEqual(tree(join(app, 'seed')).filter((f) => f !== 'build-seed.mjs'));
    for (const file of rebuilt) {
      expect(sha256(readFileSync(join(out, file))), file).toBe(
        sha256(readFileSync(join(app, 'seed', file))),
      );
    }
  });

  it('packs with the deterministic extraction config, no binding and no egress', () => {
    const output = join(scratch('document-intake-ray-'), 'document-intake-1.0.0.ray');
    const packed = pack(join(app, 'document-intake.product.yaml'), output);
    expect(paths(packed.envelope)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/document-intake.product.yaml',
      'payload/extraction/record_extractor.extractor.json',
      'payload/extraction/record_extractor.schema.json',
      'payload/sbom.cdx.json',
    ]);
    const { inspected } = inspectAndVerify(output);
    expect(inspected).toMatchObject({
      applicationId: 'document-intake',
      applicationVersion: '1.0.0',
      bindings: [],
      egressHosts: [],
      execution: 'none',
    });
    expect(inspected.requires).toContain('file_input');
  });
});

describe('asset catalog', () => {
  const app = join(EXAMPLES, 'asset-catalog');
  const built = join(scratch('asset-catalog-'), 'app');
  runNode(join(app, 'build.mjs'), [`--out=${built}`]);

  it('builds the compiled extension with its third-party dependency vendored beside it', () => {
    const pack = join(built, 'packs', 'catalog-pack');
    const manifest = JSON.parse(readFileSync(join(pack, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ type: 'module', name: 'catalog-pack' });
    expect(manifest['//']).toBeUndefined();
    for (const name of ['mime-types', 'mime-db']) {
      expect(existsSync(join(pack, 'node_modules', name, 'package.json')), name).toBe(true);
    }
    expect(existsSync(join(pack, 'node_modules', '@rayspec'))).toBe(false);
    expect(tree(join(pack, 'handlers'))).toEqual(['create-item.js', 'list-items.js']);
    expect(readFileSync(join(pack, 'handlers', 'create-item.js'), 'utf8')).toContain(
      "from 'mime-types'",
    );
  });

  it('packs, inspects and verifies: in-process code, the declared host, the vendored packages', () => {
    const output = join(scratch('asset-catalog-ray-'), 'asset-catalog-1.0.0.ray');
    const packed = pack(join(built, 'rayspec.yaml'), output);
    const files = paths(packed.envelope);
    expect(files).toContain('payload/packs/catalog-pack/index.js');
    expect(files).toContain('payload/packs/catalog-pack/handlers/create-item.js');
    expect(files).toContain('payload/packs/catalog-pack/node_modules/mime-types/package.json');
    expect(files).toContain('payload/packs/catalog-pack/node_modules/mime-db/db.json');
    expect(files).toContain('payload/public/catalog.js');
    expect(files.some((f) => f.includes('@rayspec'))).toBe(false);
    expect(files.some((f) => f.endsWith('.ts'))).toBe(false);
    const { inspected } = inspectAndVerify(output);
    expect(inspected).toMatchObject({
      applicationId: 'asset-catalog',
      applicationVersion: '1.0.0',
      execution: 'in-process',
      egressHosts: ['classifier.example.com'],
      bindings: [],
    });
    expect(inspected.requires).toEqual(['declarative-stores', 'extensions', 'static-frontend']);
  });

  it('refuses the native-addon fixture, naming the macOS binary or the platform field', () => {
    const make = join(app, 'native-fixture', 'make-tree.mjs');
    const cases = [
      {
        args: [] as string[],
        path: 'node_modules/addon-probe/build/Release/probe.node',
        message: "carries the native addon 'build/Release/probe.node', built for macOS",
      },
      {
        args: ['--os-field'],
        path: 'node_modules/addon-probe',
        message: 'is built for darwin / any cpu by its package.json os and cpu fields',
      },
    ];
    for (const c of cases) {
      const dir = join(scratch('native-fixture-'), 'app');
      runNode(make, [`--out=${dir}`, ...c.args]);
      if (c.args.length === 0) {
        // The fixture's precondition: the addon really is a 64-bit Mach-O file.
        const addon = readFileSync(join(dir, c.path));
        expect(addon.readUInt32LE(0)).toBe(0xfeedfacf);
      }
      const output = join(dir, 'native.ray');
      const run = cli(['pack', '--spec', join(dir, 'rayspec.yaml'), '--output', output]);
      expect(run.status).toBe(2);
      expect(run.envelope.errors[0]).toMatchObject({
        code: 'RAY_CLOSURE_INVALID',
        reason: 'native-module',
        path: c.path,
      });
      expect(run.envelope.errors[0].message).toContain(c.message);
      expect(existsSync(output)).toBe(false);
    }
  });
});
