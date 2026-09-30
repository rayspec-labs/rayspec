/**
 * Every way the resolver refuses a closure, each before any output exists, with the contract code
 * and reason and a message that names the file and the fix. Each case also has its passing twin,
 * so a refusal that fires for the wrong reason, or never, turns a test red.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BundleError } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { type ClosureOptions, resolveClosure } from './closure.js';
import {
  backendSpec,
  elfAddon,
  handlerApp,
  handlerSpec,
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

async function refused(
  root: string,
  options: Partial<ClosureOptions> = {},
): Promise<BundleError[]> {
  const result = await resolveClosure({
    specPath: join(root, 'rayspec.yaml'),
    runtimeVersion: RUNTIME,
    ...options,
  });
  if (result.ok) throw new Error('the closure was accepted');
  return result.errors;
}

async function accepted(root: string, options: Partial<ClosureOptions> = {}) {
  const result = await resolveClosure({
    specPath: join(root, 'rayspec.yaml'),
    runtimeVersion: RUNTIME,
    ...options,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

const paths = (closure: Awaited<ReturnType<typeof accepted>>) => closure.files.map((f) => f.path);

describe('imports that cannot be resolved', () => {
  it('refuses a handler importing a package that is not installed, naming it and the fix', async () => {
    const errors = await refused(
      handlerApp("import pad from 'left-pad';\nexport const handle = pad;\n"),
    );
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'unresolved-import' });
    expect(errors[0]!.message).toContain("'left-pad'");
    expect(errors[0]!.message).toContain('handlers/h.js');
    expect(errors[0]!.message).toContain('npm install');
  });

  it('refuses a relative import of a file that does not exist', async () => {
    const errors = await refused(handlerApp("import './missing.js';\nexport const handle = 1;\n"));
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'unresolved-import' });
    expect(errors[0]!.message).toContain("'./missing.js'");
  });

  it('follows a relative import, and an import of that module, and nothing beside them', async () => {
    const root = handlerApp("import { a } from '../lib/a.js';\nexport const handle = a;\n", {
      'lib/a.js': "import data from './data.json' with { type: 'json' };\nexport const a = data;\n",
      'lib/data.json': '{}',
      'lib/unused.js': 'export const u = 1;\n',
    });
    expect(paths(await accepted(root))).toEqual([
      'payload/THIRD-PARTY-NOTICES.txt',
      'payload/handlers/h.js',
      'payload/lib/a.js',
      'payload/lib/data.json',
      'payload/package.json',
      'payload/rayspec.yaml',
      'payload/sbom.cdx.json',
    ]);
  });

  it('refuses a dynamic import whose module name is computed', async () => {
    const errors = await refused(
      handlerApp("export const handle = async (name) => import('./plugins/' + name);\n"),
    );
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'unresolved-import' });
    expect(errors[0]!.message).toContain('line 1');
    expect(errors[0]!.message).toContain('computed');
  });

  it('refuses a template-literal dynamic import, and follows a string-literal one', async () => {
    const template = await refused(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the module source holds a template literal
      handlerApp('const n = 1;\nexport const handle = () => import(`./p${n}.js`);\n'),
    );
    expect(template[0]!.message).toContain('line 2');
    const literal = handlerApp("export const handle = () => import('./lazy.js');\n", {
      'handlers/lazy.js': 'export const x = 1;\n',
    });
    expect(paths(await accepted(literal))).toContain('payload/handlers/lazy.js');
  });

  it('ignores imports inside strings and comments', async () => {
    const root = handlerApp(
      "// import 'nope-one';\nconst s = \"import('nope-two')\";\nexport const handle = s;\n",
    );
    expect(paths(await accepted(root))).toContain('payload/handlers/h.js');
  });

  it('refuses node:module, whose createRequire loads modules the closure cannot see', async () => {
    const errors = await refused(
      handlerApp(
        "import { createRequire } from 'node:module';\nexport const handle = createRequire;\n",
      ),
    );
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'unresolved-import' });
    expect(errors[0]!.message).toContain('node:module');
  });

  it('accepts Node built-ins, with and without the node: prefix', async () => {
    const root = handlerApp(
      "import { join } from 'node:path';\nimport { readFile } from 'fs/promises';\nexport const handle = [join, readFile];\n",
    );
    expect(paths(await accepted(root))).toContain('payload/handlers/h.js');
  });

  it('refuses a CommonJS handler, whose require() calls cannot be read statically', async () => {
    const root = handlerApp("const x = require('x');\nexports.handle = x;\n", {
      'package.json': JSON.stringify({ name: 'probe', private: true }),
    });
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'unresolved-import' });
    expect(errors[0]!.message).toContain('CommonJS');
  });

  it('refuses a TypeScript handler module and says to build it', async () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': handlerSpec('handlers/h.ts'),
      'handlers/h.ts': 'export const handle = (): number => 1;\n',
    });
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'unresolved-import' });
    expect(errors[0]!.message).toContain('TypeScript');
  });

  it('refuses a handler module path with a .. segment, as the loader does', async () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': handlerSpec('handlers/../h.js'),
      'h.js': 'export const handle = 1;\n',
      'package.json': '{"type":"module"}',
    });
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'escaping-link' });
  });
});

describe('native modules', () => {
  const nativeApp = (addon: Uint8Array, extra: Record<string, string | Uint8Array> = {}) =>
    handlerApp("import addon from 'fast-thing';\nexport const handle = addon;\n", {
      ...packageFiles(
        'node_modules/fast-thing',
        { name: 'fast-thing', version: '2.0.0' },
        {
          'build/Release/fast.node': addon,
        },
      ),
      ...extra,
    });

  it('refuses an addon built for macOS, naming the package, the file and the platform', async () => {
    const errors = await refused(nativeApp(machOAddon()));
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'native-module' });
    expect(errors[0]!.message).toContain('fast-thing@2.0.0');
    expect(errors[0]!.message).toContain('build/Release/fast.node');
    expect(errors[0]!.message).toContain('macOS');
    expect(errors[0]!.message).toContain('linux/x64');
  });

  it('refuses an addon built for linux/arm64', async () => {
    const errors = await refused(nativeApp(elfAddon({ machine: 183 })));
    expect(errors[0]!.message).toContain('linux/arm64');
  });

  it('refuses a linux/x64 addon built for another Node release', async () => {
    const errors = await refused(nativeApp(elfAddon({ symbol: 'node_register_module_v115' })));
    expect(errors[0]).toMatchObject({ reason: 'native-module' });
    expect(errors[0]!.message).toContain('ABI 115');
  });

  it('carries a linux/x64 addon built on Node-API or for Node 22', async () => {
    for (const symbol of ['napi_register_module_v1', 'node_register_module_v127']) {
      const closure = await accepted(nativeApp(elfAddon({ symbol })));
      expect(paths(closure)).toContain('payload/node_modules/fast-thing/build/Release/fast.node');
      expect(closure.notes.join('\n')).toContain('native addon');
    }
  });

  it('refuses a native package with a binding.gyp and no compiled addon', async () => {
    const root = handlerApp("import addon from 'gyp-thing';\nexport const handle = addon;\n", {
      ...packageFiles(
        'node_modules/gyp-thing',
        { name: 'gyp-thing', version: '1.0.0' },
        {
          'binding.gyp': '{}',
        },
      ),
    });
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'native-module' });
    expect(errors[0]!.message).toContain('gyp-thing@1.0.0');
  });

  it('refuses a package that depends on a native loader without a compiled addon', async () => {
    const root = handlerApp("import addon from 'loads-native';\nexport const handle = addon;\n", {
      ...packageFiles('node_modules/loads-native', {
        name: 'loads-native',
        version: '1.0.0',
        dependencies: { 'node-gyp-build': '^4.0.0' },
      }),
      ...packageFiles('node_modules/node-gyp-build', { name: 'node-gyp-build', version: '4.8.0' }),
    });
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ reason: 'native-module' });
  });

  it('refuses a handler that imports a native loader itself', async () => {
    const root = handlerApp("import bindings from 'bindings';\nexport const handle = bindings;\n", {
      ...packageFiles('node_modules/bindings', { name: 'bindings', version: '1.5.0' }),
    });
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ reason: 'native-module' });
  });

  it('refuses a handler importing a .node file of the application built for macOS', async () => {
    const direct = handlerApp("import addon from './addon.node';\nexport const handle = addon;\n", {
      'handlers/addon.node': machOAddon(),
    });
    const errors = await refused(direct);
    expect(errors[0]).toMatchObject({ reason: 'native-module' });
  });
});

describe('secrets', () => {
  it('refuses a private key in an included file, naming the path and never the content', async () => {
    const canary = 'CANARY-7f3a91c2e8d4';
    const root = handlerApp(
      `export const handle = 1;\nconst key = \`${privateKeyHeader()}\n${canary}\n\`;\n`,
    );
    const result = await resolveClosure({
      specPath: join(root, 'rayspec.yaml'),
      runtimeVersion: RUNTIME,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'RAY_SECRET_DETECTED', path: 'payload/handlers/h.js' }),
    ]);
    const text = JSON.stringify(result.errors);
    expect(text).not.toContain(canary);
    expect(text).not.toContain('PRIVATE');
  });

  it('refuses a private key in a frontend asset, and lists every finding', async () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/index.html': '<p>hi</p>',
      'web/a.txt': `${privateKeyHeader()}\nAAAA\n`,
      'web/b.txt': `${privateKeyHeader()}\nBBBB\n`,
    });
    const errors = await refused(root);
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['RAY_SECRET_DETECTED', 'payload/web/a.txt'],
      ['RAY_SECRET_DETECTED', 'payload/web/b.txt'],
    ]);
  });

  it('leaves an .env file next to the spec out of the bundle', async () => {
    const root = handlerApp('export const handle = 1;\n', {
      '.env': 'PROBE_SETTING=1\n',
      '.env.local': 'X=1\n',
    });
    const closure = await accepted(root);
    expect(paths(closure).some((p) => p.includes('.env'))).toBe(false);
  });

  it('leaves environment files, logs and caches inside a frontend directory out, and says so', async () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/index.html': '<p>hi</p>',
      'web/.env': 'X=1\n',
      'web/.env.production': 'X=1\n',
      'web/debug.log': 'x',
      'web/.cache/blob': 'x',
      'web/.git/HEAD': 'ref: x',
      'web/app.js.map': '{}',
      'web/dump.sqlite': 'x',
    });
    const closure = await accepted(root);
    expect(paths(closure).filter((p) => p.startsWith('payload/web/'))).toEqual([
      'payload/web/index.html',
    ]);
    expect(closure.excluded).toEqual([
      { source: 'web/.cache', reason: 'a cache' },
      { source: 'web/.env', reason: 'an environment file' },
      { source: 'web/.env.production', reason: 'an environment file' },
      { source: 'web/.git', reason: 'version control metadata' },
      { source: 'web/app.js.map', reason: 'a source map' },
      { source: 'web/debug.log', reason: 'a log' },
      { source: 'web/dump.sqlite', reason: 'a database dump' },
    ]);
  });

  it('carries source maps only when asked', async () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/app.js': 'x',
      'web/app.js.map': '{}',
    });
    expect(paths(await accepted(root, { sourceMaps: true }))).toContain('payload/web/app.js.map');
    const errors = await refused(root, { include: ['web/app.js.map'] });
    expect(errors[0]).toMatchObject({
      code: 'RAY_CLOSURE_INVALID',
      reason: 'source-map-not-opted-in',
    });
  });

  it('refuses an explicitly included file of an excluded class', async () => {
    const root = handlerApp('export const handle = 1;\n', { '.env': 'X=1\n' });
    const errors = await refused(root, { include: ['.env'] });
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'excluded-file' });
  });
});

describe('links and paths outside the application root', () => {
  it('refuses a symbolic link in a frontend directory that leads outside the root', async () => {
    const outside = temporaryDirectory('outside-');
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/index.html': 'x',
    });
    link(root, 'web/leak.txt', join(outside, 'secret.txt'));
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'escaping-link' });
    expect(errors[0]!.message).toContain('web/leak.txt');
    expect(errors[0]!.message).toContain('outside');
  });

  it('refuses a symbolic link inside the root too: a bundle holds regular files only', async () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/index.html': 'x',
    });
    link(root, 'web/again.html', join(root, 'web', 'index.html'));
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ reason: 'escaping-link' });
    expect(errors[0]!.message).toContain('regular files only');
  });

  it('refuses a handler reached through a linked directory', async () => {
    const outside = temporaryDirectory('outside-');
    writeTree(outside, {
      'h.js': 'export const handle = 1;\n',
      'package.json': '{"type":"module"}',
    });
    const root = temporaryDirectory();
    writeTree(root, { 'rayspec.yaml': handlerSpec('handlers/h.js') });
    link(root, 'handlers', outside);
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ reason: 'escaping-link' });
  });

  it('refuses a frontend directory outside the root', async () => {
    const root = temporaryDirectory();
    mkdirSync(join(root, 'app'));
    writeTree(root, { 'web/index.html': 'x' });
    writeTree(root, {
      'app/rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: ../web }\n'),
    });
    const result = await resolveClosure({
      specPath: join(root, 'app', 'rayspec.yaml'),
      runtimeVersion: RUNTIME,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatchObject({ reason: 'escaping-link' });
  });

  it('refuses an installed package that is a link to a directory outside the root', async () => {
    const outside = temporaryDirectory('outside-');
    writeTree(outside, packageFiles('pkg', { name: 'linked', version: '1.0.0' }));
    const root = handlerApp("import x from 'linked';\nexport const handle = x;\n");
    link(root, 'node_modules/linked', join(outside, 'pkg'));
    const errors = await refused(root);
    expect(errors[0]).toMatchObject({ code: 'RAY_CLOSURE_INVALID', reason: 'escaping-link' });
    expect(errors[0]!.message).toContain("'linked'");
  });

  it('refuses the spec itself when it is a link', async () => {
    const root = temporaryDirectory();
    writeTree(root, { 'real.yaml': backendSpec() });
    link(root, 'rayspec.yaml', join(root, 'real.yaml'));
    const errors = await refused(root);
    expect(errors[0]!.code).toBe('RAY_CLOSURE_INVALID');
  });
});

describe('platform packages', () => {
  const platformApp = (range: string | undefined) =>
    handlerApp(
      "import { defineExtension } from '@rayspec/platform';\nexport const handle = defineExtension;\n",
      {
        'package.json': JSON.stringify({
          name: 'probe',
          private: true,
          type: 'module',
          ...(range === undefined ? {} : { dependencies: { '@rayspec/platform': range } }),
        }),
        ...packageFiles('node_modules/@rayspec/platform', {
          name: '@rayspec/platform',
          version: RUNTIME,
        }),
      },
    );

  it('refuses a declared range that excludes the pinned runtime', async () => {
    const errors = await refused(platformApp('^2.0.0'));
    expect(errors[0]!.code).toBe('RAY_RUNTIME_UNSUPPORTED');
    expect(errors[0]!.message).toContain("'^2.0.0'");
    expect(errors[0]!.message).toContain(RUNTIME);
  });

  it('refuses a declaration that is not a version range', async () => {
    const errors = await refused(platformApp('workspace:*'));
    expect(errors[0]!.code).toBe('RAY_RUNTIME_UNSUPPORTED');
    expect(errors[0]!.message).toContain('not a version range');
  });

  it('accepts a range that includes the runtime, and never copies the platform package', async () => {
    for (const range of [RUNTIME, `^${RUNTIME}`, '>=1.0.0 <2.0.0', undefined]) {
      const closure = await accepted(platformApp(range));
      expect(paths(closure).some((p) => p.includes('@rayspec'))).toBe(false);
      expect(closure.packages).toEqual([]);
      expect(closure.platformImports.map((i) => i.name)).toEqual(['@rayspec/platform']);
    }
  });

  it('checks the range a vendored package declares for a platform package, and strips it', async () => {
    const app = (range: string) =>
      handlerApp("import x from 'helper';\nexport const handle = x;\n", {
        ...packageFiles('node_modules/helper', {
          name: 'helper',
          version: '1.0.0',
          peerDependencies: { '@rayspec/handler-sdk': range },
        }),
      });
    const closure = await accepted(app('^1.0.0'));
    expect(closure.packages.map((p) => p.name)).toEqual(['helper']);
    const errors = await refused(app('~1.7.0'));
    expect(errors[0]!.code).toBe('RAY_RUNTIME_UNSUPPORTED');
    expect(errors[0]!.message).toContain('helper@1.0.0');
  });
});

describe('identity and usage', () => {
  it('takes the identity from the spec, and the flags override it', async () => {
    const root = handlerApp('export const handle = 1;\n');
    expect((await accepted(root)).application).toEqual({ id: 'probe-app', version: '1.0.0' });
    expect((await accepted(root, { id: 'other', version: '2.0.0-rc.1' })).application).toEqual({
      id: 'other',
      version: '2.0.0-rc.1',
    });
  });

  it('refuses a bad override with the reason naming the field', async () => {
    const root = handlerApp('export const handle = 1;\n');
    expect((await refused(root, { id: 'Bad' }))[0]).toMatchObject({
      code: 'RAY_APPLICATION_IDENTITY_MISSING',
      reason: 'id',
    });
    expect((await refused(root, { version: '1.0' }))[0]).toMatchObject({
      code: 'RAY_APPLICATION_IDENTITY_MISSING',
      reason: 'version',
    });
  });

  it('never takes the version from the runtime', async () => {
    const root = temporaryDirectory();
    writeTree(root, { 'rayspec.yaml': "version: '1.0'\nmetadata:\n  name: n\n  id: n\n" });
    expect((await refused(root))[0]).toMatchObject({ reason: 'version' });
  });

  it('refuses a spec that does not parse, before anything else', async () => {
    const root = temporaryDirectory();
    writeTree(root, { 'rayspec.yaml': "version: '1.0'\nmetadata:\n  name: n\n  bogus: 1\n" });
    const errors = await refused(root);
    expect(errors[0]!.code).toBe('RAY_SPEC_INVALID');
    expect(errors[1]!.code).toBe('SPEC_UNKNOWN_FIELD');
  });

  it('refuses a runtime version that is not exact', async () => {
    const root = handlerApp('export const handle = 1;\n');
    expect((await refused(root, { runtimeVersion: '^1.8.0' }))[0]!.code).toBe('RAY_USAGE');
  });

  it('refuses a file name a bundle path cannot carry', async () => {
    const root = temporaryDirectory();
    writeTree(root, {
      'rayspec.yaml': backendSpec('frontend:\n  - { route: /, dir: web }\n'),
      'web/my file.html': 'x',
    });
    expect((await refused(root))[0]).toMatchObject({ reason: 'excluded-file' });
  });

  it('refuses an application file at a path the bundle reserves', async () => {
    const root = handlerApp('export const handle = 1;\n', { 'sbom.cdx.json': '{}' });
    expect((await refused(root, { include: ['sbom.cdx.json'] }))[0]).toMatchObject({
      reason: 'excluded-file',
    });
  });
});
