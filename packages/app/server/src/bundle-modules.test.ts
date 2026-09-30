/**
 * How a deployed bundle's modules resolve, in a REAL Node process: a module in a version directory
 * gets `@rayspec/*` from the installed runtime and third-party packages from the bundle, and a
 * package the bundle does not carry is not picked up from a `node_modules` above the version
 * directory. The control run without the hook shows the opposite on the same tree, so each arm
 * proves what the hook changes.
 *
 * The child imports the BUILT module (`dist/bundle-modules.js`), the one `rayspec deploy` loads.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'bundle-modules.js');

const outer = mkdtempSync(join(tmpdir(), 'bundle-modules-'));
const root = join(outer, 'state', 'versions', 'a'.repeat(64));

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

// A package that lies ABOVE the version directory, as an operator's own project would.
write(
  join(outer, 'node_modules', 'outer-only', 'package.json'),
  JSON.stringify({ name: 'outer-only', type: 'module', main: 'index.js' }),
);
write(join(outer, 'node_modules', 'outer-only', 'index.js'), "export const value = 'outer';\n");
// A package the bundle vendors.
write(
  join(root, 'payload', 'node_modules', 'vendored', 'package.json'),
  JSON.stringify({ name: 'vendored', type: 'module', main: 'index.js' }),
);
write(
  join(root, 'payload', 'node_modules', 'vendored', 'index.js'),
  "export const value = 'vendored';\n",
);
write(join(root, 'payload', 'package.json'), JSON.stringify({ type: 'module' }));
write(
  join(root, 'payload', 'handlers', 'platform.js'),
  "import { CONTRACT_VERSION } from '@rayspec/bundle-contract';\nexport const value = CONTRACT_VERSION;\n",
);
write(join(root, 'payload', 'handlers', 'vendored.js'), "export { value } from 'vendored';\n");
write(join(root, 'payload', 'handlers', 'outer.js'), "export { value } from 'outer-only';\n");
write(
  join(root, 'payload', 'handlers', 'builtin.js'),
  "export { sep as value } from 'node:path';\n",
);

afterAll(() => rmSync(outer, { recursive: true, force: true }));

/** Import each handler in a fresh Node process, with or without the hook, and report what came back. */
function importAll(withHook: boolean): Record<string, string> {
  const handlers = ['platform', 'vendored', 'outer', 'builtin'];
  const script = `
    const results = {};
    ${
      withHook
        ? `const { installBundleModuleResolution } = await import(${JSON.stringify(pathToFileURL(DIST).href)});
    installBundleModuleResolution(${JSON.stringify(root)});`
        : ''
    }
    for (const name of ${JSON.stringify(handlers)}) {
      const url = new URL('handlers/' + name + '.js', ${JSON.stringify(pathToFileURL(join(root, 'payload')).href + '/')});
      try {
        results[name] = String((await import(url.href)).value);
      } catch (err) {
        results[name] = 'error:' + (err.code ?? err.message);
      }
    }
    process.stdout.write(JSON.stringify(results));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: outer,
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Record<string, string>;
}

describe('installBundleModuleResolution', () => {
  it('without the hook, a version directory reaches the outer node_modules and misses the platform', () => {
    const results = importAll(false);
    expect(results.outer).toBe('outer');
    expect(results.platform).toBe('error:ERR_MODULE_NOT_FOUND');
    expect(results.vendored).toBe('vendored');
  });

  it('with the hook, @rayspec/* comes from the runtime and only bundled packages resolve', () => {
    const results = importAll(true);
    expect(results.platform).toBe('1.0.0-draft.2');
    expect(results.vendored).toBe('vendored');
    expect(results.outer).toBe('error:ERR_MODULE_NOT_FOUND');
    expect(results.builtin).toBe('/');
  });
});
