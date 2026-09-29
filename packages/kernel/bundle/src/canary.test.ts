/**
 * Passive inspection: nothing in an archive is ever imported, evaluated or executed.
 *
 * The payload of the bundle here is a module that, if it ran, would write a canary file and open
 * a TCP connection to a listener this test owns. Inspection and extraction must leave both
 * untouched. The last test imports the extracted module on purpose and sees both effects, which
 * proves the probe would have noticed an execution.
 *
 * A second guard reads the package source: it imports only Node's own modules and the contract
 * package, and holds no dynamic import, `require`, `eval`, `Function` constructor, `vm`, child
 * process or worker.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractBundle, inspectBundle, writeBundle } from './index.js';
import { loadExpectations, PACKAGE_ROOT } from './test-support/contract.js';
import { baseFiles } from './test-support/raw-zip.js';

const expectations = loadExpectations();

const CANARY_FILE_ENV = 'RAYSPEC_BUNDLE_TEST_CANARY_FILE';
const CANARY_PORT_ENV = 'RAYSPEC_BUNDLE_TEST_CANARY_PORT';

/** What the payload does when it is imported: write the canary, then connect to the listener. */
const PAYLOAD = `import { writeFileSync } from 'node:fs';
import { connect } from 'node:net';
writeFileSync(process.env.${CANARY_FILE_ENV}, 'executed');
await new Promise((done) => {
  const socket = connect(Number(process.env.${CANARY_PORT_ENV}), '127.0.0.1', () => {
    socket.end();
    done();
  });
  socket.on('error', done);
});
`;

let work: string;
let archive: string;
let canary: string;
let server: Server;
let connections = 0;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'rayspec-bundle-canary-'));
  canary = join(work, 'canary');
  server = createServer((socket) => {
    connections++;
    socket.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no listener port');
  process.env[CANARY_FILE_ENV] = canary;
  process.env[CANARY_PORT_ENV] = String(address.port);

  const files = baseFiles(expectations);
  files.set('payload/handlers/index.mjs', Buffer.from(PAYLOAD));
  // A package manifest with install hooks: a reader that ran any of them would be caught too.
  files.set(
    'payload/handlers/package.json',
    Buffer.from(
      JSON.stringify({
        type: 'module',
        main: 'index.mjs',
        scripts: { preinstall: 'node index.mjs', postinstall: 'node index.mjs' },
      }),
    ),
  );
  archive = join(work, 'app.ray');
  const written = await writeBundle(archive, {
    manifest: { ...(expectations.bases.application.manifest as never), inventory: undefined },
    files: [...files].map(([path, bytes]) => ({ path, bytes })),
  });
  if (!written.ok) throw new Error(`the canary bundle was not written: ${written.errors[0]!.code}`);
});

afterAll(async () => {
  delete process.env[CANARY_FILE_ENV];
  delete process.env[CANARY_PORT_ENV];
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(work, { recursive: true, force: true });
});

/** Give a stray asynchronous effect time to land before looking for it. */
const settle = () => new Promise((done) => setTimeout(done, 100));

describe('passive inspection', () => {
  it('inspect reads the canary bundle without running it and writes nothing', async () => {
    const before = readdirSync(work).sort();
    const r = await inspectBundle(archive);
    expect(r.ok).toBe(true);
    await settle();
    expect(existsSync(canary)).toBe(false);
    expect(connections).toBe(0);
    expect(readdirSync(work).sort()).toEqual(before);
  });

  it('extract copies the canary bundle without running it', async () => {
    const r = await extractBundle(archive, join(work, 'extracted'));
    expect(r.ok).toBe(true);
    await settle();
    expect(existsSync(canary)).toBe(false);
    expect(connections).toBe(0);
    expect(readFileSync(join(work, 'extracted', 'payload', 'handlers', 'index.mjs'), 'utf8')).toBe(
      PAYLOAD,
    );
  });

  it('the probe detects execution: importing the extracted payload trips both canaries', async () => {
    expect(existsSync(canary)).toBe(false);
    const module = join(work, 'extracted', 'payload', 'handlers', 'index.mjs');
    await import(/* @vite-ignore */ pathToFileURL(module).href);
    await settle();
    expect(readFileSync(canary, 'utf8')).toBe('executed');
    expect(connections).toBe(1);
    // Reset for any later check in this file.
    rmSync(canary);
    connections = 0;
  });
});

describe('the package source', () => {
  const sourceDir = join(PACKAGE_ROOT, 'src');
  const sources = readdirSync(sourceDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => ({ file: f, text: readFileSync(join(sourceDir, f), 'utf8') }));

  it('imports only Node built-ins, the contract package and its own modules', () => {
    expect(sources.length).toBeGreaterThan(5);
    for (const { file, text } of sources) {
      for (const [, specifier] of text.matchAll(/\bfrom\s+'([^']+)'/g)) {
        const allowed =
          specifier!.startsWith('node:') ||
          specifier === '@rayspec/bundle-contract' ||
          /^\.\/[a-z-]+\.js$/.test(specifier!);
        expect(allowed, `${file}: ${specifier}`).toBe(true);
      }
    }
  });

  it('holds no way to run code: no dynamic import, require, eval, Function, vm, process or worker', () => {
    const forbidden = [
      /\bimport\s*\(/,
      /\brequire\s*\(/,
      /\beval\s*\(/,
      /\bnew\s+Function\b/,
      /node:vm\b/,
      /node:child_process\b/,
      /node:worker_threads\b/,
    ];
    for (const { file, text } of sources) {
      for (const pattern of forbidden)
        expect(pattern.test(text), `${file}: ${pattern}`).toBe(false);
    }
  });
});
