/**
 * The resolver on the repository's own example applications: the inclusion list is exactly what
 * each application needs at run time and nothing else, the derived fields are the spec's, and a
 * closure writes a bundle that the reader accepts and whose spec re-derives the same fields.
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectBundle, writeBundle } from '@rayspec/bundle';
import { NOTICES_PATH, SBOM_PATH } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { type Closure, resolveClosure } from './closure.js';
import { closureFiles, closureManifest, closurePreview } from './preview.js';
import { checkDerivedFields, deriveManifestFields, parseBundleSpec } from './spec-fields.js';
import {
  buildAcmeNotesBackend,
  buildStreamBackend,
  EXAMPLES,
  RUNTIME,
  removeTemporaryDirectories,
  temporaryDirectory,
} from './test-support/app.js';

afterAll(removeTemporaryDirectories);

async function resolved(
  specPath: string,
  extra: Partial<Parameters<typeof resolveClosure>[0]> = {},
) {
  const result = await resolveClosure({ specPath, runtimeVersion: RUNTIME, ...extra });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const paths = (closure: Closure) => closure.files.map((f) => f.path);

/** Write the closure through the real writer and read it back through the real reader. */
async function roundTrip(closure: Closure): Promise<string> {
  const destination = join(temporaryDirectory('bundle-'), 'app.ray');
  const written = await writeBundle(destination, {
    manifest: closureManifest(closure),
    files: closureFiles(closure),
  });
  if (!written.ok) throw new Error(JSON.stringify(written.errors));
  expect(written.value.manifest.kind === 'application' && written.value.manifest.inventory).toEqual(
    closure.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  );
  const inspected = await inspectBundle(destination, { captureSpec: true });
  expect(inspected.ok).toBe(true);
  if (!inspected.ok) return '';
  expect(inspected.value.secretFindings).toEqual([]);
  const parsed = parseBundleSpec(inspected.value.specBytes!);
  expect(parsed.ok).toBe(true);
  const manifest = inspected.value.manifest;
  if (parsed.ok && manifest.kind === 'application') {
    expect(checkDerivedFields(manifest, deriveManifestFields(parsed.value))).toEqual([]);
  }
  return written.value.archiveSha256;
}

describe('notes-ui: a declarative backend with a static frontend', () => {
  const spec = join(EXAMPLES, 'notes-ui', 'rayspec.yaml');

  it('carries the spec and the built frontend, and nothing else of the example directory', async () => {
    const closure = await resolved(spec, { id: 'notes-ui', version: '1.0.0' });
    expect(paths(closure)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
      'payload/web/dist/app.js',
      'payload/web/dist/index.html',
    ]);
    expect(closure.requires).toEqual(['declarative-api', 'declarative-stores', 'static-frontend']);
    expect(closure.permissions).toEqual({ execution: 'none', egressHosts: [] });
    expect(closure.bindings).toEqual([]);
    expect(closure.packages).toEqual([]);
    expect(closure.warnings).toEqual([]);
    expect(closure.target).toEqual({ os: 'linux', arch: 'x64', nodeMajor: 22 });
  });

  it('refuses without an identity, because the example declares none', async () => {
    const result = await resolveClosure({ specPath: spec, runtimeVersion: RUNTIME });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'RAY_APPLICATION_IDENTITY_MISSING',
        reason: 'id',
      });
    }
  });

  it('writes a bundle the reader accepts, with the same bytes each time', async () => {
    const first = await roundTrip(await resolved(spec, { id: 'notes-ui', version: '1.0.0' }));
    const second = await roundTrip(await resolved(spec, { id: 'notes-ui', version: '1.0.0' }));
    expect(second).toBe(first);
  });
});

describe('acme-notes-backend: compiled handlers, stores, an agent and a cron trigger', () => {
  const built = buildAcmeNotesBackend();

  it('carries the two handlers the spec names and their module scope, not the unused one', async () => {
    const closure = await resolved(join(built, 'rayspec.yaml'), {
      id: 'acme-notes',
      version: '0.3.0',
    });
    // The build also emits handlers/list-completed-route.js, generated/ and drizzle/; the spec
    // names none of them and the runtime generates the product DDL itself.
    expect(paths(closure)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/handlers/lookup-notebook.js',
      'payload/handlers/nightly-digest.js',
      'payload/package.json',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
    ]);
    expect(closure.requires).toEqual([
      'agent-backend-openai',
      'custom-handlers',
      'declarative-api',
      'declarative-stores',
      'durable-workflow',
      'trigger-cron',
    ]);
    expect(closure.permissions.execution).toBe('in-process');
    expect(closure.bindings).toEqual([
      {
        name: 'OPENAI_API_KEY',
        kind: 'secret',
        required: true,
        description: expect.any(String),
      },
    ]);
    expect(closure.warnings.map((w) => w.code)).toEqual(['RAY_W_EGRESS_UNDECLARED']);
    await roundTrip(closure);
  });

  it('carries the egress hosts the spec declares, which the reader re-derives, and drops the warning', async () => {
    const declared = join(built, 'rayspec.egress.yaml');
    writeFileSync(
      declared,
      readFileSync(join(built, 'rayspec.yaml'), 'utf8').replace(
        'deployment:\n  durableWorker: true\n',
        'deployment:\n  durableWorker: true\n  egressHosts: [api.openai.com]\n',
      ),
    );
    const closure = await resolved(declared, { id: 'acme-notes', version: '0.3.0' });
    expect(closure.permissions.egressHosts).toEqual(['api.openai.com']);
    expect(closure.warnings).toEqual([]);
    const archive = await roundTrip(closure);
    expect(archive).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses the authored spec, whose handlers are TypeScript source', async () => {
    const result = await resolveClosure({
      specPath: join(EXAMPLES, 'acme-notes-backend', 'rayspec.yaml'),
      runtimeVersion: RUNTIME,
      id: 'acme-notes',
      version: '0.3.0',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'RAY_CLOSURE_INVALID',
        reason: 'unresolved-import',
      });
      expect(result.errors[0]!.message).toContain('handlers/lookup-notebook.ts');
      expect(result.errors[0]!.message).toContain('build.mjs');
    }
  });
});

describe('stream-backend: an extension shipped with its own manifest', () => {
  const root = buildStreamBackend();

  it('carries the built extension and never a copy of the platform', async () => {
    const closure = await resolved(join(root, 'rayspec.yaml'));
    expect(paths(closure)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/packs/stream-pack/dist/handlers/chunk-ingest.js',
      'payload/packs/stream-pack/dist/handlers/chunk-playback.js',
      'payload/packs/stream-pack/dist/handlers/play-token-mint.js',
      'payload/packs/stream-pack/dist/index.js',
      'payload/packs/stream-pack/dist/package.json',
      'payload/packs/stream-pack/package.json',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
    ]);
    expect(closure.platformImports).toEqual([
      {
        name: '@rayspec/platform',
        range: RUNTIME,
        declaredIn: 'packs/stream-pack/package.json',
      },
    ]);
    expect(closure.requires).toEqual(['extensions']);
    expect(closure.permissions.execution).toBe('in-process');
    expect(closure.packages).toEqual([]);
    await roundTrip(closure);
  });

  it('refuses a runtime the extension declared range excludes', async () => {
    const result = await resolveClosure({
      specPath: join(root, 'rayspec.yaml'),
      runtimeVersion: '1.9.0',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.code).toBe('RAY_RUNTIME_UNSUPPORTED');
      expect(result.errors[0]!.message).toContain('@rayspec/platform');
      expect(result.errors[0]!.message).toContain('1.9.0');
    }
  });

  it('refuses the authored spec, which points at the extension source', async () => {
    const result = await resolveClosure({
      specPath: join(EXAMPLES, 'stream-backend', 'rayspec.yaml'),
      runtimeVersion: RUNTIME,
      id: 'stream-backend',
      version: '1.0.0',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'RAY_CLOSURE_INVALID',
        reason: 'unresolved-import',
      });
      expect(result.errors[0]!.message).toContain('index.js');
    }
  });
});

describe('contract-intake: a product spec with an extraction configuration', () => {
  it('carries the extraction config, prompt and schema the runtime reads, and not the fixtures', async () => {
    const root = temporaryDirectory('intake-');
    const source = join(EXAMPLES, 'contract-intake');
    for (const file of [
      'contract-intake.product.yaml',
      'extraction/contract_extractor.extractor.json',
      'extraction/contract_extractor.prompt.md',
      'extraction/contract_extractor.schema.json',
      'README.md',
    ]) {
      const target = join(root, ...file.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      copyFileSync(join(source, ...file.split('/')), target);
    }
    const closure = await resolved(join(root, 'contract-intake.product.yaml'), {
      id: 'contract-intake',
      version: '1.0.0',
    });
    expect(paths(closure)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/contract-intake.product.yaml',
      'payload/extraction/contract_extractor.extractor.json',
      'payload/extraction/contract_extractor.prompt.md',
      'payload/extraction/contract_extractor.schema.json',
      'payload/sbom.cdx.json',
    ]);
    expect(closure.profile).toBe('product');
    expect(closure.bindings.map((b) => b.name)).toEqual(['OPENAI_API_KEY']);
    await roundTrip(closure);
  });
});

describe('the preview', () => {
  it('lists the identity, target, runtime, capabilities, bindings, warnings, bytes and every file', async () => {
    const closure = await resolved(join(buildAcmeNotesBackend(), 'rayspec.yaml'), {
      id: 'acme-notes',
      version: '0.3.0',
    });
    const preview = closurePreview(closure);
    expect(preview).toMatchObject({
      applicationId: 'acme-notes',
      applicationVersion: '0.3.0',
      spec: 'payload/rayspec.yaml',
      runtimeVersion: RUNTIME,
      target: { os: 'linux', arch: 'x64', nodeMajor: 22 },
      requires: closure.requires,
      bindings: [{ name: 'OPENAI_API_KEY', kind: 'secret', required: true }],
      execution: 'in-process',
      egressHosts: [],
    });
    expect(preview.warnings.map((w) => w.code)).toEqual(['RAY_W_EGRESS_UNDECLARED']);
    expect(preview.totalBytes).toBe(closure.files.reduce((sum, f) => sum + f.size, 0));
    expect(preview.inclusion.map((e) => e.path)).toEqual(paths(closure));
    expect(preview.inclusion.every((e) => /^[a-f0-9]{64}$/.test(e.sha256) && e.size >= 0)).toBe(
      true,
    );
    expect(preview.inclusion.find((e) => e.path === SBOM_PATH)?.source).toBe('generated');
    expect(preview.inclusion.find((e) => e.path === NOTICES_PATH)?.source).toBe('generated');
    // Pure: the same closure gives the same preview, and the preview shares no state with it.
    expect(closurePreview(closure)).toEqual(preview);
    preview.requires.push('mutated');
    expect(closure.requires).not.toContain('mutated');
  });

  it('never reads the disk: a preview of a closure whose files are gone is unchanged', async () => {
    const root = temporaryDirectory('gone-');
    const spec = join(root, 'rayspec.yaml');
    copyFileSync(join(EXAMPLES, 'notes-ui', 'rayspec.yaml'), spec);
    writeFileSync(join(root, 'README.md'), 'x');
    cpSync(join(EXAMPLES, 'notes-ui', 'web'), join(root, 'web'), { recursive: true });
    const closure = await resolved(spec, { id: 'notes-ui', version: '1.0.0' });
    const before = closurePreview(closure);
    rmSync(root, { recursive: true, force: true });
    expect(closurePreview(closure)).toEqual(before);
  });
});
