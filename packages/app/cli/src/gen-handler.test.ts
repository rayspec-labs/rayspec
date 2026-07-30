/**
 * `rayspec gen-handler` SUBCOMMAND tests.
 *
 * Drives `runGenHandler` (the CLI body) in-process: it renders a handler from a holes file to an out
 * dir, returns a stable JSON envelope, and is FAIL-CLOSED on a bad hole-set / a path escape / a bad
 * `--file`. The renders themselves are golden-tested in gen-handler/templates.test.ts; here we cover
 * the argv/IO plumbing + the fail-closed surface — plus the `--emit js` target, whose whole point is
 * that the written file is a module the PRODUCTION loader accepts (a plain dynamic `import()` of
 * compiled JavaScript), so it is imported for real here rather than only pattern-matched.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GenHandlerCliError, runGenHandler } from './gen-handler.js';

let tmp: string;
let cwd: string;

beforeEach(() => {
  cwd = process.cwd();
  // Work inside a temp dir as the CWD so the CWD-jail accepts in-tree paths + we never write the repo.
  // (Created under the current cwd — vitest runs the package from packages/cli.)
  tmp = mkdtempSync(join(cwd, '__genhandler_'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwd);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function writeHoles(name: string, holes: unknown): string {
  writeFileSync(join(tmp, name), JSON.stringify(holes), 'utf8');
  return name; // a CWD-relative path (the CWD is tmp)
}

const PERSIST = {
  template: 'persist',
  exportName: 'codeClaim',
  store: 'expense_claims',
  mode: 'update-by-id',
  idArg: 'claim_id',
  successStatus: 'coded',
  columns: [{ col: 'category_code', jsonType: 'text', required: true, nullable: false }],
};

describe('runGenHandler — happy path', () => {
  it('renders a handler to the out dir + returns a stable envelope', async () => {
    const holes = writeHoles('h.json', PERSIST);
    const result = await runGenHandler(['--holes', holes, '--out', 'out']);
    expect(result.ok).toBe(true);
    expect(result.exportName).toBe('codeClaim');
    expect(result.template).toBe('persist');
    expect(result.file).toBe('out/code-claim.gen.ts'); // default filename = kebab(exportName).gen.ts
    const written = readFileSync(join(tmp, 'out/code-claim.gen.ts'), 'utf8');
    expect(written).toContain('export const codeClaim');
    expect(written).toMatch(/import type .* from '@rayspec\/handler-sdk';/);
  });

  it('honors an explicit --file name', async () => {
    const holes = writeHoles('h.json', PERSIST);
    const result = await runGenHandler([
      '--holes',
      holes,
      '--out',
      'out',
      '--file',
      'my-handler.ts',
    ]);
    expect(result.ok).toBe(true);
    expect(result.file).toBe('out/my-handler.ts');
  });
});

describe('runGenHandler — --emit js writes a directly deployable ESM module', () => {
  /** Mark the out dir as ESM, exactly as a real deployment does (the acme-notes build step writes the
   * same `{"type":"module"}` next to its compiled handlers) so a bare `.js` resolves as ESM. */
  function markOutDirEsm(): void {
    writeFileSync(join(tmp, 'out/package.json'), '{ "type": "module" }\n', 'utf8');
  }

  it('defaults the filename to <name>.gen.js and node imports the file as plain ESM', async () => {
    const holes = writeHoles('h.json', PERSIST);
    const result = await runGenHandler(['--holes', holes, '--out', 'out', '--emit', 'js']);
    expect(result.ok).toBe(true);
    expect(result.file).toBe('out/code-claim.gen.js');
    markOutDirEsm();

    // Import the written file for real and drive it with a stubbed init — proving the emission is
    // executable JavaScript, not merely TypeScript with the annotations pattern-matched away.
    const abs = join(tmp, 'out/code-claim.gen.js');
    const href = pathToFileURL(abs).href;
    const mod = (await import(href)) as Record<string, unknown>;
    const handler = mod.codeClaim as (
      args: Record<string, unknown>,
      init: unknown,
    ) => Promise<unknown>;
    expect(typeof handler).toBe('function');
    const init = { tenantId: 't1', db: { update: async () => [{ id: 'c1' }] } };
    await expect(handler({ claim_id: 'c1', category_code: 'travel' }, init)).resolves.toEqual({
      status: 'coded',
      id: 'c1',
    });

    // …and again from a BARE node, with no test-runner transform in between: that is exactly what
    // the production handler loader does (a plain dynamic import of the resolved module path).
    const exported = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(href)});\nprocess.stdout.write(JSON.stringify(Object.keys(m)));`,
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(exported)).toEqual(['codeClaim']);
  });

  it('the emitted module carries NO TypeScript-only syntax', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await runGenHandler(['--holes', holes, '--out', 'out', '--emit', 'js']);
    const src = readFileSync(join(tmp, 'out/code-claim.gen.js'), 'utf8');
    expect(src).not.toMatch(/^\s*import\b/m); // the SDK import was type-only — nothing survives it
    expect(src).not.toMatch(/\binterface\s+\w+\s*\{/);
    expect(src).not.toMatch(/\bas\s+(const|readonly|Record<)/);
    expect(src).not.toMatch(/:\s*(StoreRow|StoreFilter|ToolHandler|Promise<|Record<)/);
    expect(src).toContain('export const codeClaim = async (args, init) => {');
  });
});

describe('runGenHandler — the envelope carries nextSteps (as `init` already does)', () => {
  it('ts (the default): names the build step, the example wrapper AND the --emit js way out', async () => {
    const holes = writeHoles('h.json', PERSIST);
    const result = await runGenHandler(['--holes', holes, '--out', 'out']);
    expect(result.ok).toBe(true);
    const steps = result.nextSteps ?? [];
    expect(steps.length).toBeGreaterThan(0);
    // The recommendation is ONE self-contained sentence — it must stand on its own when quoted.
    expect(steps[0]).toContain('TypeScript source');
    expect(steps[0]).toContain('examples/acme-notes-backend/build.mjs');
    expect(steps[0]).toContain('--emit js');
    expect(steps.join(' ')).toContain('handlers[].module');
  });

  it('js: next steps with NO build step at all', async () => {
    const holes = writeHoles('h.json', PERSIST);
    const result = await runGenHandler(['--holes', holes, '--out', 'out', '--emit', 'js']);
    expect(result.ok).toBe(true);
    const steps = (result.nextSteps ?? []).join(' ');
    expect(steps).toContain('out/code-claim.gen.js');
    expect(steps).toContain('handlers[].module');
    expect(steps).not.toMatch(/build\.mjs|compile|tsc/i);
  });
});

describe('runGenHandler — fail-closed', () => {
  it('ok:false on a malformed hole-set (NOT a throw)', async () => {
    const holes = writeHoles('h.json', { ...PERSIST, store: 'Bad Store' });
    const result = await runGenHandler(['--holes', holes, '--out', 'out']);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('invalid_holes');
    expect(result.errors[0]?.message).toMatch(/store/);
  });

  it('ok:false on non-JSON holes', async () => {
    writeFileSync(join(tmp, 'h.json'), 'not json{', 'utf8');
    const result = await runGenHandler(['--holes', 'h.json', '--out', 'out']);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('holes_parse_error');
  });

  it('throws GenHandlerCliError on a missing --holes / --out', async () => {
    await expect(runGenHandler(['--out', 'out'])).rejects.toThrow(/--holes/);
    await expect(runGenHandler(['--holes', 'x.json'])).rejects.toThrow(/--out/);
  });

  it('ok:false holes_too_large on an oversized file (fstat cap preserved through the fd read)', async () => {
    // The size cap is enforced by fstat'ing the OPEN handle before reading it (no statSync→readFile race);
    // > MAX_HOLES_BYTES (256 KiB) ⇒ holes_too_large, never a full read of an oversized file.
    writeFileSync(join(tmp, 'big.json'), 'x'.repeat(256 * 1024 + 64), 'utf8');
    const result = await runGenHandler(['--holes', 'big.json', '--out', 'out']);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.code).toBe('holes_too_large');
    expect(result.errors[0]?.message).toMatch(/exceeds the \d+-byte cap/);
  });

  it('throws on a --holes path that escapes the CWD', async () => {
    await expect(runGenHandler(['--holes', '../../../etc/passwd', '--out', 'out'])).rejects.toThrow(
      /escapes the working directory|not found/,
    );
  });

  it('throws on an --out path that escapes the CWD', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await expect(runGenHandler(['--holes', holes, '--out', '../../escape'])).rejects.toThrow(
      /escapes the working directory/,
    );
  });

  it('throws on a --file with a path separator or .. (no redirect outside --out)', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await expect(
      runGenHandler(['--holes', holes, '--out', 'out', '--file', '../x.ts']),
    ).rejects.toThrow(/bare filename/);
    await expect(
      runGenHandler(['--holes', holes, '--out', 'out', '--file', 'sub/x.ts']),
    ).rejects.toThrow(/bare filename/);
  });

  it('throws on a --file not ending in .ts', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await expect(
      runGenHandler(['--holes', holes, '--out', 'out', '--file', 'x.js']),
    ).rejects.toThrow(/end in \.ts/);
  });

  it('throws on a --file whose extension contradicts --emit js', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await expect(
      runGenHandler(['--holes', holes, '--out', 'out', '--emit', 'js', '--file', 'x.ts']),
    ).rejects.toThrow(/end in \.js/);
  });

  it('throws on an --emit value outside the closed ts|js set', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await expect(
      runGenHandler(['--holes', holes, '--out', 'out', '--emit', 'mjs']),
    ).rejects.toThrow(/--emit/);
  });

  it('throws on an unknown flag', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await expect(runGenHandler(['--holes', holes, '--out', 'out', '--nope', '1'])).rejects.toThrow(
      GenHandlerCliError,
    );
  });
});
