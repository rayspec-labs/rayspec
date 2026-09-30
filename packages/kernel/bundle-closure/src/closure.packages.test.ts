/**
 * Vendoring third-party packages: the resolver copies exactly the packages the modules import and
 * the packages those depend on, in a layout where Node resolves each import to the version it
 * resolved to on the author's machine, with the dependency lock, an SBOM and the license notices.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseJsonDocument } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { type Closure, resolveClosure } from './closure.js';
import {
  elfAddon,
  handlerApp,
  link,
  machOAddon,
  packageFiles,
  privateKeyHeader,
  RUNTIME,
  removeTemporaryDirectories,
  temporaryDirectory,
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

async function refusedWith(root: string) {
  const result = await resolveClosure({
    specPath: join(root, 'rayspec.yaml'),
    runtimeVersion: RUNTIME,
  });
  if (result.ok) throw new Error('the closure was accepted');
  return result.errors;
}

const paths = (closure: Closure) => closure.files.map((f) => f.path);

/** Write the closure's payload as an extracted bundle would hold it, and return its directory. */
function extract(closure: Closure): string {
  const out = temporaryDirectory('extracted-');
  for (const file of closure.files) {
    const target = join(out, ...file.path.slice('payload/'.length).split('/'));
    mkdirSync(dirname(target), { recursive: true });
    if (file.file !== undefined) copyFileSync(file.file, target);
    else writeFileSync(target, file.bytes!);
  }
  return out;
}

/** Import the handler module of an extracted payload in a fresh Node process, printing `handle`. */
function runHandler(payload: string): string {
  const script =
    'const m = await import(process.argv[1]); console.log(JSON.stringify(await m.handle()));';
  const url = pathToFileURL(join(payload, 'handlers', 'h.js')).href;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script, url], {
    encoding: 'utf8',
  }).trim();
}

/** An ES module package whose entry is `source`. */
function esmPackage(
  dir: string,
  manifest: Record<string, unknown>,
  source: string,
): Record<string, string> {
  return {
    [`${dir}/package.json`]: JSON.stringify({ main: 'index.js', type: 'module', ...manifest }),
    [`${dir}/index.js`]: source,
  };
}

/**
 * Two packages the application imports, `dom` and `shim`, that both name `core` as a peer and
 * both depend on `util`; the application imports neither `core` nor `util`. The handler reports
 * whether the two packages see the same instance of `core`.
 */
const SHARED_HANDLER =
  "import dom from 'dom';\nimport shim from 'shim';\n" +
  'export const handle = () => ({ sameCore: dom.core === shim.core, sameUtil: dom.util === shim.util });\n';
const SHARED_PACKAGE =
  "import core from 'core';\nimport util from 'util-lib';\nexport default { core, util };\n";
const SHARED_MANIFEST = {
  version: '1.0.0',
  peerDependencies: { core: '^1.0.0' },
  dependencies: { 'util-lib': '^1.0.0' },
};
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
    // Each package keeps the path it has on disk: gamma@1.4.0 at the top level for @scope/beta,
    // and the gamma@2.0.0 alpha resolves to in alpha's own node_modules.
    const closure = await accepted(npmApp());
    expect(paths(closure)).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/handlers/h.js',
      'payload/node_modules/@scope/beta/index.js',
      'payload/node_modules/@scope/beta/package.json',
      'payload/node_modules/@scope/beta/sub.js',
      'payload/node_modules/alpha/LICENSE',
      'payload/node_modules/alpha/README.md',
      'payload/node_modules/alpha/index.js',
      'payload/node_modules/alpha/node_modules/gamma/index.js',
      'payload/node_modules/alpha/node_modules/gamma/package.json',
      'payload/node_modules/alpha/package.json',
      'payload/node_modules/gamma/index.js',
      'payload/node_modules/gamma/package.json',
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
    expect(notices).toContain(
      'gamma 1.4.0\nLicense: not declared in its package.json\nPath: payload/node_modules/gamma\n',
    );
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
    // gamma is not on alpha's lookup chain on disk (it sits under .pnpm), so it is hoisted to the
    // highest node_modules where alpha finds it.
    expect(paths(closure).filter((p) => p.includes('node_modules'))).toEqual([
      'payload/node_modules/alpha/index.js',
      'payload/node_modules/alpha/package.json',
      'payload/node_modules/gamma/index.js',
      'payload/node_modules/gamma/package.json',
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
      'payload/node_modules/cyc-a/package.json',
      'payload/node_modules/cyc-b/index.js',
      'payload/node_modules/cyc-b/package.json',
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

describe('a package several packages share', () => {
  it('places a peer the application does not import once, where every dependent finds it', async () => {
    const root = handlerApp(SHARED_HANDLER, {
      ...esmPackage('node_modules/dom', { name: 'dom', ...SHARED_MANIFEST }, SHARED_PACKAGE),
      ...esmPackage('node_modules/shim', { name: 'shim', ...SHARED_MANIFEST }, SHARED_PACKAGE),
      ...esmPackage(
        'node_modules/core',
        { name: 'core', version: '1.0.0' },
        'export default {};\n',
      ),
      ...esmPackage(
        'node_modules/util-lib',
        { name: 'util-lib', version: '1.0.0' },
        'export default {};\n',
      ),
    });
    // The source tree gives one instance of each; the extracted bundle must too.
    expect(runHandler(root)).toBe('{"sameCore":true,"sameUtil":true}');
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.includes('node_modules'))).toEqual([
      'payload/node_modules/core/index.js',
      'payload/node_modules/core/package.json',
      'payload/node_modules/dom/index.js',
      'payload/node_modules/dom/package.json',
      'payload/node_modules/shim/index.js',
      'payload/node_modules/shim/package.json',
      'payload/node_modules/util-lib/index.js',
      'payload/node_modules/util-lib/package.json',
    ]);
    expect(runHandler(extract(closure))).toBe('{"sameCore":true,"sameUtil":true}');
  });

  it('hoists a peer a pnpm layout links under each dependent into one shared copy', async () => {
    const store = (id: string) => `node_modules/.pnpm/${id}/node_modules`;
    const root = handlerApp(SHARED_HANDLER, {
      ...esmPackage(
        `${store('dom@1.0.0')}/dom`,
        { name: 'dom', ...SHARED_MANIFEST },
        SHARED_PACKAGE,
      ),
      ...esmPackage(
        `${store('shim@1.0.0')}/shim`,
        { name: 'shim', ...SHARED_MANIFEST },
        SHARED_PACKAGE,
      ),
      ...esmPackage(
        `${store('core@1.0.0')}/core`,
        { name: 'core', version: '1.0.0' },
        'export default {};\n',
      ),
      ...esmPackage(
        `${store('util-lib@1.0.0')}/util-lib`,
        { name: 'util-lib', version: '1.0.0' },
        'export default {};\n',
      ),
    });
    for (const dependent of ['dom', 'shim']) {
      link(root, `node_modules/${dependent}`, join(root, store(`${dependent}@1.0.0`), dependent));
      for (const dependency of ['core', 'util-lib']) {
        link(
          root,
          `${store(`${dependent}@1.0.0`)}/${dependency}`,
          join(root, store(`${dependency}@1.0.0`), dependency),
        );
      }
    }
    expect(runHandler(root)).toBe('{"sameCore":true,"sameUtil":true}');
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.endsWith('package.json'))).toEqual([
      'payload/node_modules/core/package.json',
      'payload/node_modules/dom/package.json',
      'payload/node_modules/shim/package.json',
      'payload/node_modules/util-lib/package.json',
      'payload/package.json',
    ]);
    expect(runHandler(extract(closure))).toBe('{"sameCore":true,"sameUtil":true}');
  });

  it('refuses a shared peer that would have to be copied under each dependent', async () => {
    // The application imports core@1 itself; dom and shim share one core@2 through pnpm's links,
    // which no tree of plain directories can give them without two copies.
    const store = (id: string) => `node_modules/.pnpm/${id}/node_modules`;
    const manifest = { version: '1.0.0', peerDependencies: { core: '^2.0.0' } };
    const root = handlerApp(
      "import core from 'core';\nimport dom from 'dom';\nimport shim from 'shim';\nexport const handle = [core, dom, shim];\n",
      {
        ...packageFiles(`${store('dom@1.0.0')}/dom`, { name: 'dom', ...manifest }),
        ...packageFiles(`${store('shim@1.0.0')}/shim`, { name: 'shim', ...manifest }),
        ...packageFiles(`${store('core@1.0.0')}/core`, { name: 'core', version: '1.0.0' }),
        ...packageFiles(`${store('core@2.0.0')}/core`, { name: 'core', version: '2.0.0' }),
      },
    );
    link(root, 'node_modules/core', join(root, store('core@1.0.0'), 'core'));
    for (const dependent of ['dom', 'shim']) {
      link(root, `node_modules/${dependent}`, join(root, store(`${dependent}@1.0.0`), dependent));
      link(root, `${store(`${dependent}@1.0.0`)}/core`, join(root, store('core@2.0.0'), 'core'));
    }
    const errors = await refusedWith(root);
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'unresolved-import' });
    expect(errors[0]!.message).toContain('core@2.0.0 is a peer dependency of dom@1.0.0');
    expect(errors[0]!.message).toContain(
      'node_modules/dom/node_modules/core, node_modules/shim/node_modules/core',
    );
  });

  it('never hoists a package over one the application itself resolves', async () => {
    // ext/index.js resolves tiny@1 from the root; bar needs tiny@2, which sits beside it in a
    // pnpm store. Hoisting tiny@2 to ext/node_modules would hand the extension the wrong version.
    const root = handlerApp('export const handle = 1;\n');
    const store = 'ext/node_modules/.pnpm/bar@1.0.0/node_modules';
    writeTree(root, {
      'rayspec.yaml':
        "version: '1.0'\nmetadata:\n  name: p\n  id: p\n  version: '1.0.0'\n" +
        'extensions:\n  - { id: ext, module: ./ext, version: 1.0.0 }\n',
      'ext/package.json': JSON.stringify({ name: 'ext', type: 'module' }),
      'ext/index.js':
        "import tiny from 'tiny';\nimport bar from 'bar';\nexport default [tiny, bar];\n",
      ...packageFiles('node_modules/tiny', { name: 'tiny', version: '1.0.0' }),
      ...packageFiles(`${store}/bar`, {
        name: 'bar',
        version: '1.0.0',
        dependencies: { tiny: '^2.0.0' },
      }),
      ...packageFiles(`${store}/tiny`, { name: 'tiny', version: '2.0.0' }),
    });
    link(root, 'ext/node_modules/bar', join(root, store, 'bar'));
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.endsWith('/package.json'))).toEqual([
      'payload/ext/node_modules/bar/node_modules/tiny/package.json',
      'payload/ext/node_modules/bar/package.json',
      'payload/ext/package.json',
      'payload/node_modules/tiny/package.json',
      'payload/package.json',
    ]);
  });
});

describe('packages built for another platform', () => {
  it('refuses a package whose os and cpu fields exclude linux/x64, even an optional one', async () => {
    const root = handlerApp("import tool from 'tool';\nexport const handle = tool;\n", {
      ...packageFiles('node_modules/tool', {
        name: 'tool',
        version: '1.0.0',
        optionalDependencies: { '@tool/darwin-arm64': '1.0.0', '@tool/linux-x64': '1.0.0' },
      }),
      ...packageFiles('node_modules/@tool/darwin-arm64', {
        name: '@tool/darwin-arm64',
        version: '1.0.0',
        os: ['darwin'],
        cpu: ['arm64'],
      }),
    });
    const errors = await refusedWith(root);
    expect(errors[0]).toMatchObject({
      code: 'RAY_CLOSURE_INVALID',
      reason: 'native-module',
      path: 'node_modules/@tool/darwin-arm64',
    });
    expect(errors[0]!.message).toContain('darwin / arm64');
    expect(errors[0]!.message).toContain('--os=linux --cpu=x64');
  });

  it('carries a package whose os and cpu fields allow linux/x64', async () => {
    const root = handlerApp("import tool from 'tool';\nexport const handle = tool;\n", {
      ...packageFiles(
        'node_modules/tool',
        { name: 'tool', version: '1.0.0', os: ['linux', 'darwin'], cpu: ['x64'] },
        { 'bin/tool': elfAddon() },
      ),
    });
    expect(paths(await accepted(root))).toContain('payload/node_modules/tool/bin/tool');
  });

  it.each([
    ['a macOS executable', machOAddon(), 'macOS'],
    ['a linux/arm64 executable', elfAddon({ machine: 183 }), 'linux/arm64'],
  ])('refuses %s in a package, whatever the file is called', async (_label, bytes, platform) => {
    const root = handlerApp("import tool from 'tool';\nexport const handle = tool;\n", {
      ...packageFiles(
        'node_modules/tool',
        { name: 'tool', version: '1.0.0' },
        { 'bin/tool': bytes },
      ),
    });
    const errors = await refusedWith(root);
    expect(errors[0]).toMatchObject({
      code: 'RAY_CLOSURE_INVALID',
      reason: 'native-module',
      path: 'node_modules/tool/bin/tool',
    });
    expect(errors[0]!.message).toContain(`built for ${platform}`);
  });
});

describe('imports a package does not declare', () => {
  it('carries a package an ES module of a vendored package imports without declaring it', async () => {
    const root = handlerApp("import { a } from 'alpha';\nexport const handle = () => a;\n", {
      ...esmPackage(
        'node_modules/alpha',
        { name: 'alpha', version: '1.0.0' },
        "import { b } from 'beta';\nimport 'not-installed-anywhere';\nexport const a = 'alpha+' + b;\n",
      ),
      ...esmPackage(
        'node_modules/beta',
        { name: 'beta', version: '1.0.0' },
        "export const b = 'beta';\n",
      ),
      ...esmPackage('node_modules/not-installed-anywhere', { name: 'x', version: '1.0.0' }, ''),
    });
    const closure = await accepted(root);
    expect(paths(closure)).toContain('payload/node_modules/beta/index.js');
    expect(closure.notes.join('\n')).toContain("alpha@1.0.0 imports 'beta' without declaring it");
    expect(runHandler(extract(closure))).toBe('"alpha+beta"');
  });

  it('carries a package a CommonJS module of a vendored package requires without declaring it', async () => {
    const root = handlerApp("import alpha from 'alpha';\nexport const handle = () => alpha;\n", {
      ...packageFiles(
        'node_modules/alpha',
        { name: 'alpha', version: '1.0.0' },
        {
          'index.js':
            "const { b } = require('beta');\nconst os = require('node:os');\nmodule.exports = 'alpha+' + b;\n",
        },
      ),
      ...packageFiles(
        'node_modules/beta',
        { name: 'beta', version: '1.0.0' },
        { 'index.js': "exports.b = 'beta';\n" },
      ),
    });
    const closure = await accepted(root);
    expect(paths(closure)).toContain('payload/node_modules/beta/index.js');
    expect(runHandler(extract(closure))).toBe('"alpha+beta"');
  });

  it('leaves an import of a package installed nowhere alone, as it fails on disk too', async () => {
    const root = handlerApp("import alpha from 'alpha';\nexport const handle = alpha;\n", {
      ...packageFiles(
        'node_modules/alpha',
        { name: 'alpha', version: '1.0.0' },
        { 'index.js': "try { require('optional-extra'); } catch {}\nmodule.exports = 1;\n" },
      ),
    });
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.includes('optional-extra'))).toEqual([]);
    expect(closure.notes.join('\n')).not.toContain('optional-extra');
  });
});

describe('files a vendored package reads at run time', () => {
  it('keeps certificates, data files and logs/ directories, and leaves out env files', async () => {
    const certificate = ['-----BEGIN', 'CERTIFICATE-----'].join(' ');
    const root = handlerApp("import ca from 'ca-bundle';\nexport const handle = ca;\n", {
      ...packageFiles(
        'node_modules/ca-bundle',
        { name: 'ca-bundle', version: '1.0.0' },
        {
          'certs/root-ca.pem': `${certificate}\nAAAA\n`,
          'data/zones.db': 'zones',
          'data/backup.bak': 'old',
          'logs/index.js': 'module.exports = 1;\n',
          '.env': 'TOKEN=x',
          '.envrc': 'export TOKEN=x',
          'Production.ENV': 'TOKEN=x',
        },
      ),
    });
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.includes('ca-bundle'))).toEqual([
      'payload/node_modules/ca-bundle/certs/root-ca.pem',
      'payload/node_modules/ca-bundle/data/backup.bak',
      'payload/node_modules/ca-bundle/data/zones.db',
      'payload/node_modules/ca-bundle/index.js',
      'payload/node_modules/ca-bundle/logs/index.js',
      'payload/node_modules/ca-bundle/package.json',
    ]);
    expect(closure.excluded).toEqual([
      { source: 'node_modules/ca-bundle/.env', reason: 'an environment file' },
      { source: 'node_modules/ca-bundle/.envrc', reason: 'an environment file' },
      { source: 'node_modules/ca-bundle/Production.ENV', reason: 'an environment file' },
    ]);
  });

  it("refuses a private key among a package's files by its content", async () => {
    const root = handlerApp("import k from 'keyed';\nexport const handle = k;\n", {
      ...packageFiles(
        'node_modules/keyed',
        { name: 'keyed', version: '1.0.0' },
        { 'test/key.pem': `${privateKeyHeader()}\nAAAA\n` },
      ),
    });
    const errors = await refusedWith(root);
    expect(errors[0]).toMatchObject({
      code: 'RAY_SECRET_DETECTED',
      path: 'payload/node_modules/keyed/test/key.pem',
    });
  });

  it('carries a hard-linked package file, as pnpm links files from its store', async () => {
    const root = handlerApp("import alpha from 'alpha';\nexport const handle = alpha;\n", {
      ...packageFiles('node_modules/alpha', { name: 'alpha', version: '1.0.0' }),
    });
    const store = temporaryDirectory('store-');
    writeFileSync(join(store, 'extra.js'), 'module.exports = 2;\n');
    linkSync(join(store, 'extra.js'), join(root, 'node_modules/alpha/extra.js'));
    expect(paths(await accepted(root))).toContain('payload/node_modules/alpha/extra.js');
  });
});
