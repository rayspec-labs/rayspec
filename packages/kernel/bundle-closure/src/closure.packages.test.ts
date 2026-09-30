/**
 * Vendoring third-party packages: the resolver copies exactly the packages the modules import and
 * the packages those depend on, in a layout where Node resolves each import to the version it
 * resolved to on the author's machine, with the dependency lock, an SBOM and the license notices.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonDocument } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { type Closure, resolveClosure } from './closure.js';
import {
  handlerApp,
  link,
  packageFiles,
  RUNTIME,
  removeTemporaryDirectories,
  writeTree,
} from './test-support/app.js';

afterAll(removeTemporaryDirectories);

async function accepted(root: string): Promise<Closure> {
  const result = await resolveClosure({
    specPath: join(root, 'rayspec.yaml'),
    runtimeVersion: RUNTIME,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const paths = (closure: Closure) => closure.files.map((f) => f.path);
const generated = (closure: Closure, path: string) =>
  new TextDecoder().decode(closure.files.find((f) => f.path === path)!.bytes!);

/**
 * An npm-style tree: the handler imports `alpha` and `@scope/beta`; `alpha` depends on `gamma@2`,
 * which npm nested under it because the top level holds `gamma@1` for `@scope/beta`; `delta` is
 * installed but nothing imports it; `alpha` declares a missing optional dependency.
 */
function npmApp(): string {
  return handlerApp(
    "import alpha from 'alpha';\nimport beta from '@scope/beta/sub.js';\nexport const handle = [alpha, beta];\n",
    {
      'package-lock.json': '{"lockfileVersion":3}',
      ...packageFiles(
        'node_modules/alpha',
        {
          name: 'alpha',
          version: '1.0.0',
          license: 'MIT',
          dependencies: { gamma: '^2.0.0' },
          optionalDependencies: { 'not-installed': '^1.0.0' },
          devDependencies: { 'dev-only': '1.0.0' },
        },
        { LICENSE: 'MIT License\n\nCopyright alpha authors\n', 'README.md': '# alpha' },
      ),
      ...packageFiles('node_modules/alpha/node_modules/gamma', {
        name: 'gamma',
        version: '2.0.0',
        license: 'ISC',
      }),
      ...packageFiles(
        'node_modules/@scope/beta',
        {
          name: '@scope/beta',
          version: '0.1.0',
          license: 'Apache-2.0',
          dependencies: { gamma: '^1.0.0' },
        },
        { 'sub.js': 'module.exports = 1;\n', 'index.js.map': '{}' },
      ),
      ...packageFiles('node_modules/gamma', { name: 'gamma', version: '1.4.0' }),
      ...packageFiles('node_modules/delta', { name: 'delta', version: '9.9.9' }),
    },
  );
}

describe('an npm-style node_modules tree', () => {
  it('vendors exactly the imported packages and their dependencies, where Node finds them', async () => {
    // gamma@1.4.0 sits at the top level on disk, but only @scope/beta needs it, so it is placed in
    // beta's own node_modules; alpha keeps the gamma@2.0.0 it resolves to.
    const closure = await accepted(npmApp());
    expect(paths(closure)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/handlers/h.js',
      'payload/node_modules/@scope/beta/index.js',
      'payload/node_modules/@scope/beta/node_modules/gamma/index.js',
      'payload/node_modules/@scope/beta/node_modules/gamma/package.json',
      'payload/node_modules/@scope/beta/package.json',
      'payload/node_modules/@scope/beta/sub.js',
      'payload/node_modules/alpha/LICENSE',
      'payload/node_modules/alpha/README.md',
      'payload/node_modules/alpha/index.js',
      'payload/node_modules/alpha/node_modules/gamma/index.js',
      'payload/node_modules/alpha/node_modules/gamma/package.json',
      'payload/node_modules/alpha/package.json',
      'payload/package-lock.json',
      'payload/package.json',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
    ]);
    expect(closure.excluded).toEqual([
      { source: 'node_modules/@scope/beta/index.js.map', reason: 'a source map' },
    ]);
  });

  it('writes a canonical CycloneDX 1.5 SBOM listing each package once', async () => {
    const closure = await accepted(npmApp());
    const text = generated(closure, 'payload/sbom.cdx.json');
    const parsed = parseJsonDocument(new TextEncoder().encode(text), {
      maxBytes: 1024 * 1024,
      maxDepth: 64,
      canonical: true,
    });
    expect(parsed.ok).toBe(true);
    const sbom = JSON.parse(text);
    expect(sbom).toMatchObject({
      bomFormat: 'CycloneDX',
      specVersion: '1.5',
      version: 1,
      metadata: { component: { type: 'application', name: 'probe-app', version: '1.0.0' } },
    });
    expect(sbom.components).toEqual([
      {
        type: 'library',
        'bom-ref': 'pkg:npm/%40scope/beta@0.1.0',
        group: '@scope',
        name: 'beta',
        version: '0.1.0',
        purl: 'pkg:npm/%40scope/beta@0.1.0',
        licenses: [{ license: { name: 'Apache-2.0' } }],
      },
      {
        type: 'library',
        'bom-ref': 'pkg:npm/alpha@1.0.0',
        name: 'alpha',
        version: '1.0.0',
        purl: 'pkg:npm/alpha@1.0.0',
        licenses: [{ license: { name: 'MIT' } }],
      },
      {
        type: 'library',
        'bom-ref': 'pkg:npm/gamma@1.4.0',
        name: 'gamma',
        version: '1.4.0',
        purl: 'pkg:npm/gamma@1.4.0',
      },
      {
        type: 'library',
        'bom-ref': 'pkg:npm/gamma@2.0.0',
        name: 'gamma',
        version: '2.0.0',
        purl: 'pkg:npm/gamma@2.0.0',
        licenses: [{ license: { name: 'ISC' } }],
      },
    ]);
  });

  it('writes a notice for every redistributed package, with the license text it ships', async () => {
    const notices = generated(await accepted(npmApp()), 'payload/THIRD-PARTY-NOTICES.txt');
    expect(notices).toContain('alpha 1.0.0\nLicense: MIT\nPath: payload/node_modules/alpha');
    expect(notices).toContain('Copyright alpha authors');
    expect(notices).toContain('gamma 1.4.0\nLicense: not declared in its package.json');
    expect(notices).toContain('Path: payload/node_modules/alpha/node_modules/gamma');
    expect(notices).not.toContain('delta');
  });

  it('nests a dependency under its dependent when Node would otherwise find another version', async () => {
    const root = handlerApp(
      "import alpha from 'alpha';\nimport gamma from 'gamma';\nexport const handle = [alpha, gamma];\n",
      {
        ...packageFiles('node_modules/alpha', {
          name: 'alpha',
          version: '1.0.0',
          dependencies: { gamma: '^2.0.0' },
        }),
        ...packageFiles('node_modules/alpha/node_modules/gamma', {
          name: 'gamma',
          version: '2.0.0',
        }),
        ...packageFiles('node_modules/gamma', { name: 'gamma', version: '1.4.0' }),
      },
    );
    const closure = await accepted(root);
    const versionAt = (dir: string) =>
      JSON.parse(
        readFileSync(
          closure.files.find((f) => f.path === `payload/${dir}/package.json`)!.file!,
          'utf8',
        ),
      ).version;
    // The handler resolves gamma to the top level; alpha resolves it to its own copy first.
    expect(versionAt('node_modules/gamma')).toBe('1.4.0');
    expect(versionAt('node_modules/alpha/node_modules/gamma')).toBe('2.0.0');
  });

  it('gives the same closure, byte for byte, every time', async () => {
    const root = npmApp();
    const a = await accepted(root);
    const b = await accepted(root);
    expect(b.files.map((f) => [f.path, f.sha256])).toEqual(a.files.map((f) => [f.path, f.sha256]));
  });

  it('refuses a dependency that is not installed', async () => {
    const root = handlerApp("import x from 'needs-missing';\nexport const handle = x;\n", {
      ...packageFiles('node_modules/needs-missing', {
        name: 'needs-missing',
        version: '1.0.0',
        dependencies: { absent: '1.0.0' },
      }),
    });
    const result = await resolveClosure({
      specPath: join(root, 'rayspec.yaml'),
      runtimeVersion: RUNTIME,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'RAY_CLOSURE_INVALID',
        reason: 'unresolved-import',
      });
      expect(result.errors[0]!.message).toContain("'absent'");
    }
  });

  it('notes a vendored tree without a lock file', async () => {
    const root = handlerApp("import x from 'lonely';\nexport const handle = x;\n", {
      ...packageFiles('node_modules/lonely', { name: 'lonely', version: '1.0.0' }),
    });
    expect((await accepted(root)).notes.join('\n')).toContain('no dependency lock');
  });
});

describe('a pnpm-style tree of links into node_modules/.pnpm', () => {
  it('follows the links inside the root and places each package where Node resolves it', async () => {
    const root = handlerApp("import alpha from 'alpha';\nexport const handle = alpha;\n", {
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      ...packageFiles('node_modules/.pnpm/alpha@1.0.0/node_modules/alpha', {
        name: 'alpha',
        version: '1.0.0',
        dependencies: { gamma: '2.0.0' },
      }),
      ...packageFiles('node_modules/.pnpm/gamma@2.0.0/node_modules/gamma', {
        name: 'gamma',
        version: '2.0.0',
      }),
    });
    link(
      root,
      'node_modules/alpha',
      join(root, 'node_modules/.pnpm/alpha@1.0.0/node_modules/alpha'),
    );
    link(
      root,
      'node_modules/.pnpm/alpha@1.0.0/node_modules/gamma',
      join(root, 'node_modules/.pnpm/gamma@2.0.0/node_modules/gamma'),
    );
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.includes('node_modules'))).toEqual([
      'payload/node_modules/alpha/index.js',
      'payload/node_modules/alpha/node_modules/gamma/index.js',
      'payload/node_modules/alpha/node_modules/gamma/package.json',
      'payload/node_modules/alpha/package.json',
    ]);
    expect(paths(closure)).toContain('payload/pnpm-lock.yaml');
  });

  it('reuses a package Node already finds from a parent, and resolves a dependency cycle', async () => {
    const root = handlerApp("import a from 'cyc-a';\nexport const handle = a;\n", {
      ...packageFiles('node_modules/cyc-a', {
        name: 'cyc-a',
        version: '1.0.0',
        dependencies: { 'cyc-b': '1.0.0' },
      }),
      ...packageFiles('node_modules/cyc-b', {
        name: 'cyc-b',
        version: '1.0.0',
        dependencies: { 'cyc-a': '1.0.0' },
      }),
    });
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.includes('node_modules'))).toEqual([
      'payload/node_modules/cyc-a/index.js',
      'payload/node_modules/cyc-a/node_modules/cyc-b/index.js',
      'payload/node_modules/cyc-a/node_modules/cyc-b/package.json',
      'payload/node_modules/cyc-a/package.json',
    ]);
    expect(closure.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      'cyc-a@1.0.0',
      'cyc-b@1.0.0',
    ]);
  });
});

describe('packages of an extension', () => {
  it('resolves them from the node_modules of the extension, not only of the application', async () => {
    const root = handlerApp('export const handle = 1;\n');
    writeTree(root, {
      'rayspec.yaml':
        "version: '1.0'\nmetadata:\n  name: p\n  id: p\n  version: '1.0.0'\n" +
        'extensions:\n  - { id: ext, module: ./ext, version: 1.0.0 }\n',
      'ext/package.json': JSON.stringify({
        name: 'ext',
        type: 'module',
        dependencies: { tiny: '1.0.0' },
      }),
      'ext/index.js': "import tiny from 'tiny';\nexport default tiny;\n",
      'ext/handlers/a.js': 'export const a = 1;\n',
      ...packageFiles('ext/node_modules/tiny', { name: 'tiny', version: '1.0.0' }),
    });
    const closure = await accepted(root);
    expect(paths(closure)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/ext/handlers/a.js',
      'payload/ext/index.js',
      'payload/ext/node_modules/tiny/index.js',
      'payload/ext/node_modules/tiny/package.json',
      'payload/ext/package.json',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
    ]);
  });
});
