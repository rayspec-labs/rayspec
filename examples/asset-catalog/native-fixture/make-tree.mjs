/**
 * Write the native-addon fixture into `--out=<dir>`: this directory's spec and handler, and a
 * `node_modules/addon-probe` package whose entry requires `build/Release/probe.node` — the first
 * bytes of a 64-bit Mach-O file, the shape a build on macOS leaves. The binary is written here
 * rather than committed. With `--os-field`, the package instead declares `"os": ["darwin"]` and
 * carries no binary, the other shape pack refuses.
 */
import { cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function machOHeader() {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64
  bytes.writeUInt32LE(0x0100000c, 4); // CPU_TYPE_ARM64
  return bytes;
}

export function makeTree(outDir, { osField = false } = {}) {
  mkdirSync(join(outDir, 'handlers'), { recursive: true });
  cpSync(join(here, 'rayspec.yaml'), join(outDir, 'rayspec.yaml'));
  cpSync(join(here, 'handlers', 'probe.js'), join(outDir, 'handlers', 'probe.js'));
  writeFileSync(
    join(outDir, 'package.json'),
    `${JSON.stringify({ name: 'native-addon-probe', private: true, type: 'module' }, null, 2)}\n`,
  );
  const pkg = join(outDir, 'node_modules', 'addon-probe');
  mkdirSync(join(pkg, 'build', 'Release'), { recursive: true });
  const manifest = { name: 'addon-probe', version: '1.0.0', main: 'index.js', license: 'MIT' };
  if (osField) manifest.os = ['darwin'];
  writeFileSync(join(pkg, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (osField) {
    writeFileSync(join(pkg, 'index.js'), 'module.exports = {};\n');
  } else {
    writeFileSync(
      join(pkg, 'index.js'),
      "module.exports = require('./build/Release/probe.node');\n",
    );
    writeFileSync(join(pkg, 'build', 'Release', 'probe.node'), machOHeader());
  }
  return outDir;
}

// Run as a script, also through a symlinked path (macOS /tmp, /var/folders): the module's own path is
// the real one, so the argument is compared as its real path too.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const out = process.argv
    .slice(2)
    .find((a) => a.startsWith('--out='))
    ?.slice('--out='.length);
  if (out === undefined) {
    console.error('usage: node make-tree.mjs --out=<dir> [--os-field]');
    process.exit(2);
  }
  const dir = makeTree(isAbsolute(out) ? out : resolve(process.cwd(), out), {
    osField: process.argv.includes('--os-field'),
  });
  console.log(`native-addon fixture -> ${dir}`);
}
