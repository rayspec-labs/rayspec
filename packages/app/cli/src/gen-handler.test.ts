/**
 * `rayspec gen-handler` SUBCOMMAND tests.
 *
 * Drives `runGenHandler` (the CLI body) in-process: it renders a handler from a holes file to an out
 * dir, returns a stable JSON envelope, and is FAIL-CLOSED on a bad hole-set / a path escape / a bad
 * `--file`. The renders themselves are golden-tested in gen-handler/templates.test.ts; here we cover
 * the argv/IO plumbing + the fail-closed surface.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

  it('throws on an unknown flag', async () => {
    const holes = writeHoles('h.json', PERSIST);
    await expect(runGenHandler(['--holes', holes, '--out', 'out', '--nope', '1'])).rejects.toThrow(
      GenHandlerCliError,
    );
  });
});
