/**
 * The `FsSink` path jail + bounds — the fail-the-fix suite for the ONLY containment this capability has.
 *
 * WHY EVERY ARM HERE IS WRITTEN AS A FAIL-THE-FIX ARM. A negative assertion ("it cannot escape the
 * directory") is satisfied trivially by a writer that does nothing at all, and equally by one whose jail
 * was deleted but whose test fixture happened not to reach outside. Proven only by the absence that
 * makes it hold, such an assertion is indistinguishable from `expect(true).toBe(true)` — and that exact
 * defect shipped twice already in this programme.
 *
 * So each confinement arm is built so that REMOVING THE SPECIFIC GUARD IT NAMES makes it FAIL, and each
 * was run in that state before being run green. The guard each arm attacks is named in its title, and
 * the mutation that must redden it is recorded in the plan
 * (`planning/plans/2026-08-19-UI1-file-write-handler.md` §7). Two arms carry the discipline further and
 * assert the escape's GROUND TRUTH rather than only the throw: the target file outside the root is read
 * back and asserted UNCHANGED, so a "refusal" that threw *after* writing would still be caught.
 *
 * The positive control (`W1`) is what stops the whole file from passing vacuously: if `write` did
 * nothing at all, every negative arm would still pass and W1 would not.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FsSink } from '@rayspec/handler-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __assertRealDirUnderRootForTest,
  FsSinkConfigError,
  FsSinkJailError,
  FsSinkQuotaError,
  makeFsSinkFactory,
} from './fs-sink.js';

/** The sandbox holding BOTH the jailed output root and the out-of-root target an escape would reach. */
let sandbox: string;
/** The configured output root — everything the sink may touch lives strictly under here. */
let root: string;
/** OUTSIDE the root, inside the sandbox: the file every escape arm tries (and must fail) to reach. */
let outsideDir: string;

const OUTSIDE_BODY = 'the untouched contents of a file OUTSIDE the output root';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A sink with generous bounds — the confinement arms must fail on the JAIL, never on a quota. */
function sink(opts?: {
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
}): FsSink {
  return makeFsSinkFactory(root, {
    maxBytesPerFile: opts?.maxBytesPerFile ?? 1024 * 1024,
    maxTotalBytes: opts?.maxTotalBytes ?? 8 * 1024 * 1024,
    maxFiles: opts?.maxFiles ?? 64,
  })();
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'rayspec-fs-sink-'));
  root = join(sandbox, 'out');
  outsideDir = join(sandbox, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'secret.txt'), OUTSIDE_BODY, 'utf8');
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** Ground truth for an escape arm: the out-of-root file must be byte-identical to how it started. */
function assertOutsideUntouched(): void {
  expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe(OUTSIDE_BODY);
}

describe('FsSink — the path jail (each arm names the guard whose removal must redden it)', () => {
  it('W1 POSITIVE CONTROL: a legitimate write lands the EXACT bytes, and reports them', async () => {
    const s = sink();
    const first = await s.write('reports/summary.md', enc('hello sink'));
    expect(first).toEqual({ path: 'reports/summary.md', bytesWritten: 10, created: true });
    expect(readFileSync(join(root, 'reports/summary.md'), 'utf8')).toBe('hello sink');

    // Re-writing the SAME path REPLACES it (whole-file write) and is no longer a creation.
    const second = await s.write('reports/summary.md', enc('replaced'));
    expect(second).toEqual({ path: 'reports/summary.md', bytesWritten: 8, created: false });
    expect(readFileSync(join(root, 'reports/summary.md'), 'utf8')).toBe('replaced');
  });

  it('C1 refuses a `..` traversal segment (jail layer 3: the raw-segment check)', async () => {
    const s = sink();
    await expect(s.write('../outside/secret.txt', enc('pwned'))).rejects.toThrow(FsSinkJailError);
    await expect(s.write('a/../../outside/secret.txt', enc('pwned'))).rejects.toThrow(
      FsSinkJailError,
    );
    assertOutsideUntouched();
  });

  it('C2 refuses an absolute / leading-slash path (jail layer 2)', async () => {
    const s = sink();
    await expect(s.write(join(outsideDir, 'secret.txt'), enc('pwned'))).rejects.toThrow(
      FsSinkJailError,
    );
    await expect(s.write('/etc/passwd', enc('pwned'))).rejects.toThrow(FsSinkJailError);
    await expect(s.write('\\etc\\passwd', enc('pwned'))).rejects.toThrow(FsSinkJailError);
    assertOutsideUntouched();
  });

  it('C3 refuses a SYMLINK LEAF pointing out of the root (the lstat + O_NOFOLLOW layer)', async () => {
    // A symlink planted INSIDE the root whose target is outside it. Nothing lexical is wrong with the
    // caller path `link.txt` — only resolving it reveals the escape.
    symlinkSync(join(outsideDir, 'secret.txt'), join(root, 'link.txt'));
    const s = sink();
    await expect(s.write('link.txt', enc('pwned'))).rejects.toThrow(FsSinkJailError);
    // GROUND TRUTH, not merely the throw: the file the symlink pointed at is byte-unchanged.
    assertOutsideUntouched();
  });

  it('C3b refuses a symlink leaf even when its target is INSIDE the root (no write ever follows a link)', async () => {
    writeFileSync(join(root, 'real.txt'), 'original', 'utf8');
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'));
    const s = sink();
    await expect(s.write('alias.txt', enc('via the link'))).rejects.toThrow(FsSinkJailError);
    // The in-root target is untouched too: the refusal is on the LINK, not on where it points.
    expect(readFileSync(join(root, 'real.txt'), 'utf8')).toBe('original');
  });

  it('C4 refuses `.`-prefixed escapes (layers 3+4 — normalize must not launder them)', async () => {
    const s = sink();
    await expect(s.write('./../outside/secret.txt', enc('pwned'))).rejects.toThrow(FsSinkJailError);
    await expect(s.write('.hidden/../../outside/secret.txt', enc('pwned'))).rejects.toThrow(
      FsSinkJailError,
    );
    assertOutsideUntouched();
  });

  it('C5 refuses a path whose PARENT DIRECTORY is a symlink out of the root (jail layer 5: realpath)', async () => {
    // THE ONE PEOPLE MISS. `escape/secret.txt` is lexically impeccable: no `..`, not absolute, and it
    // normalizes to a path under the root. Only RESOLVING the parent reveals that it leaves.
    symlinkSync(outsideDir, join(root, 'escape'));
    const s = sink();
    await expect(s.write('escape/secret.txt', enc('pwned'))).rejects.toThrow(FsSinkJailError);
    assertOutsideUntouched();
  });

  it('C5b refuses a symlinked parent when the leaf AND an intermediate dir are ABSENT (deepestExisting)', async () => {
    // The harder shape of C5: nothing below the symlink exists, so a realpath of the TARGET returns
    // nothing and the assert must walk up to the deepest existing ancestor — the symlink itself.
    symlinkSync(outsideDir, join(root, 'escape'));
    const s = sink();
    await expect(s.write('escape/nested/deeper/new.txt', enc('pwned'))).rejects.toThrow(
      FsSinkJailError,
    );
    // And nothing was created along the way, inside or outside.
    expect(() => readFileSync(join(outsideDir, 'nested/deeper/new.txt'))).toThrow();
    assertOutsideUntouched();
  });

  it('C6 refuses a null byte in the path (jail layer 0)', async () => {
    const s = sink();
    await expect(s.write('ok\0/../../outside/secret.txt', enc('pwned'))).rejects.toThrow(
      FsSinkJailError,
    );
    assertOutsideUntouched();
  });

  it('C7 refuses URL-significant chars — %2e%2e URL-decodes to `..` (jail layer 0)', async () => {
    const s = sink();
    await expect(s.write('%2e%2e/outside/secret.txt', enc('pwned'))).rejects.toThrow(
      FsSinkJailError,
    );
    await expect(s.write('a#b.txt', enc('x'))).rejects.toThrow(FsSinkJailError);
    await expect(s.write('a?b.txt', enc('x'))).rejects.toThrow(FsSinkJailError);
    assertOutsideUntouched();
  });

  it('C8 refuses an empty path — a write needs a file, and the root is not one (jail layer 1)', async () => {
    const s = sink();
    await expect(s.write('', enc('x'))).rejects.toThrow(FsSinkJailError);
    await expect(s.write('.', enc('x'))).rejects.toThrow(FsSinkJailError);
  });

  it('C9 refuses writing OVER a directory (the leaf must be a regular file)', async () => {
    mkdirSync(join(root, 'adir'), { recursive: true });
    const s = sink();
    await expect(s.write('adir', enc('x'))).rejects.toThrow(FsSinkJailError);
  });

  it('C10 the sink exposes NO read / list / delete / move / append surface (write-only is structural)', () => {
    const s = sink();
    // The interface is the containment: a caller cannot reach the tree except by writing one whole file.
    expect(Object.keys(s).sort()).toEqual(['quota', 'write']);
    for (const forbidden of [
      'read',
      'list',
      'search',
      'delete',
      'unlink',
      'move',
      'rename',
      'append',
    ]) {
      expect((s as unknown as Record<string, unknown>)[forbidden]).toBeUndefined();
    }
  });

  it('C11 a legitimate nested write still creates its parents (the jail contains, it does not obstruct)', async () => {
    const s = sink();
    const r = await s.write('deeply/nested/dir/note.txt', enc('ok'));
    expect(r.path).toBe('deeply/nested/dir/note.txt');
    expect(readFileSync(join(root, 'deeply/nested/dir/note.txt'), 'utf8')).toBe('ok');
  });
});

describe('FsSink — the parent re-assert, pinned DIRECTLY because no staged escape reaches it', () => {
  // WHY THIS DESCRIBE EXISTS, stated plainly. In every escape the suite above can stage
  // deterministically, `jailPath`'s own layer-5 assert refuses the path BEFORE control reaches the
  // parent re-assert — its `deepestExisting` walk finds a symlinked ancestor whether or not the leaf
  // exists (that is exactly what C5 and C5b prove). So the re-assert is a TOCTOU backstop: it earns its
  // place only when a parent absent at jail time is created as, or swapped for, a symlink in the window
  // before the open, and staging that means racing the filesystem.
  //
  // The choice is therefore between a security-critical branch that NO test can redden and a direct
  // pin on its logic. This is the direct pin. What it does NOT establish — and what is not claimed
  // anywhere — is an end-to-end proof of the race itself.

  // The function's contract is that `realRoot` is ALREADY resolved — which is how the impl calls it
  // (the factory `realpathSync`s the root once at build time). The tests must honour that contract, and
  // on macOS they visibly must: `tmpdir()` is itself a symlink (`/var/…` -> `/private/var/…`), so an
  // unresolved root compares unequal to every resolved child. Caught by R1/R2 failing on the first run.
  const realRoot = (): string => realpathSync(root);

  it('R1 accepts a directory that really is under the root', async () => {
    mkdirSync(join(root, 'nested/dir'), { recursive: true });
    await expect(
      __assertRealDirUnderRootForTest(realRoot(), join(root, 'nested/dir'), 'nested/dir/x.txt'),
    ).resolves.toBeUndefined();
  });

  it('R2 accepts the root itself (the boundary case `realDir === realRoot`)', async () => {
    await expect(
      __assertRealDirUnderRootForTest(realRoot(), root, 'x.txt'),
    ).resolves.toBeUndefined();
  });

  it('R3 REFUSES a directory that resolves, via a symlink, OUTSIDE the root', async () => {
    // The shape the backstop exists for: the path is lexically inside, and only resolving it leaves.
    symlinkSync(outsideDir, join(root, 'escape'));
    await expect(
      __assertRealDirUnderRootForTest(realRoot(), join(root, 'escape'), 'escape/x.txt'),
    ).rejects.toThrow(FsSinkJailError);
  });

  it('R4 REFUSES a sibling whose path merely PREFIXES the root (the segment boundary, not a bare startsWith)', async () => {
    // `/…/out-evil` starts with `/…/out` as a STRING but is not under it as a PATH. A comparison
    // written as a bare `startsWith(realRoot)` — without the separator — would accept this one.
    const sibling = `${root}-evil`;
    mkdirSync(sibling, { recursive: true });
    await expect(__assertRealDirUnderRootForTest(realRoot(), sibling, 'x.txt')).rejects.toThrow(
      FsSinkJailError,
    );
  });

  it('R5 REFUSES a directory that cannot be resolved at all (fail-closed, never fail-open)', async () => {
    await expect(
      __assertRealDirUnderRootForTest(
        realRoot(),
        join(root, 'does/not/exist'),
        'does/not/exist/x.txt',
      ),
    ).rejects.toThrow(FsSinkJailError);
  });
});

describe('FsSink — the bounds (a model can emit gigabytes; these say how much reaches disk)', () => {
  it('B1 refuses a write over maxBytesPerFile, and writes NOTHING', async () => {
    const s = sink({ maxBytesPerFile: 16 });
    await expect(s.write('big.txt', enc('x'.repeat(17)))).rejects.toThrow(FsSinkQuotaError);
    expect(() => readFileSync(join(root, 'big.txt'))).toThrow();
    // Exactly at the bound is allowed — the refusal is `>`, not `>=`.
    await expect(s.write('edge.txt', enc('x'.repeat(16)))).resolves.toMatchObject({
      bytesWritten: 16,
    });
  });

  it('B2 refuses a write that would exceed maxTotalBytes across DIFFERENT paths', async () => {
    const s = sink({ maxTotalBytes: 20 });
    await s.write('a.txt', enc('x'.repeat(12)));
    expect(s.quota().bytesWritten).toBe(12);
    await expect(s.write('b.txt', enc('y'.repeat(9)))).rejects.toThrow(FsSinkQuotaError);
    expect(() => readFileSync(join(root, 'b.txt'))).toThrow();
    // Room for a smaller one remains — the bound is a budget, not a latch.
    await expect(s.write('b.txt', enc('y'.repeat(8)))).resolves.toMatchObject({ bytesWritten: 8 });
    expect(s.quota().bytesWritten).toBe(20);
  });

  it('B3 refuses CREATING beyond maxFiles, while still allowing a re-write of an existing path', async () => {
    const s = sink({ maxFiles: 2 });
    await s.write('one.txt', enc('1'));
    await s.write('two.txt', enc('2'));
    await expect(s.write('three.txt', enc('3'))).rejects.toThrow(FsSinkQuotaError);
    expect(() => readFileSync(join(root, 'three.txt'))).toThrow();
    // The count bounds CREATION, not writing: an already-counted path stays writable.
    await expect(s.write('one.txt', enc('1 again'))).resolves.toMatchObject({ created: false });
    expect(s.quota().filesWritten).toBe(2);
  });

  it('B4 REPLAY STABILITY: re-writing the same path does not double-charge the byte budget', async () => {
    // This is the arm that makes the accounting correct rather than merely present. A workforce turn
    // RE-EXECUTES on recovery, and the tool is `idempotent: true` precisely because replaying a
    // whole-file write is safe. Cumulative accounting would charge the replay a second time and let a
    // RECOVERY exhaust a budget the original turn already paid — crash-safety turned into a refusal.
    const s = sink({ maxTotalBytes: 30 });
    for (let i = 0; i < 10; i++) {
      await s.write('same.txt', enc('x'.repeat(25)));
    }
    expect(s.quota().bytesWritten).toBe(25);
    expect(s.quota().filesWritten).toBe(1);
    expect(readFileSync(join(root, 'same.txt'), 'utf8')).toBe('x'.repeat(25));
  });

  it('B5 FAIL-CLOSED ORDERING: a refused write never truncates the file it was refused for', async () => {
    // The ordering guarantee, made observable. The open carries O_TRUNC, so a bound checked AFTER the
    // open would destroy existing content and then report a refusal — the worst of both.
    const s = sink({ maxBytesPerFile: 8 });
    await s.write('keep.txt', enc('original'));
    await expect(s.write('keep.txt', enc('far too long to fit'))).rejects.toThrow(FsSinkQuotaError);
    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('original');
  });

  it('B6 quota() reports the declared bounds and current consumption without throwing', async () => {
    const s = sink({ maxBytesPerFile: 100, maxTotalBytes: 200, maxFiles: 3 });
    expect(s.quota()).toEqual({
      maxBytesPerFile: 100,
      maxTotalBytes: 200,
      maxFiles: 3,
      bytesWritten: 0,
      filesWritten: 0,
    });
    await s.write('a.txt', enc('abc'));
    expect(s.quota()).toMatchObject({ bytesWritten: 3, filesWritten: 1 });
  });

  it("B7 each factory() call mints a FRESH budget — one run cannot spend another run's", async () => {
    const factory = makeFsSinkFactory(root, { maxTotalBytes: 10 });
    const runA = factory();
    await runA.write('a.txt', enc('x'.repeat(10)));
    expect(runA.quota().bytesWritten).toBe(10);
    const runB = factory();
    expect(runB.quota().bytesWritten).toBe(0);
    await expect(runB.write('b.txt', enc('y'.repeat(10)))).resolves.toMatchObject({
      bytesWritten: 10,
    });
  });
});

describe('FsSink — factory configuration (fail-closed, never a helpful guess)', () => {
  it('refuses a root that does not exist — it never CREATES one', () => {
    expect(() => makeFsSinkFactory(join(sandbox, 'nope'))).toThrow(FsSinkConfigError);
    expect(() => makeFsSinkFactory(join(sandbox, 'nope'))).toThrow(
      /does not exist or is not a directory/,
    );
  });

  it('refuses a root that is a FILE, not a directory', () => {
    const asFile = join(sandbox, 'a-file');
    writeFileSync(asFile, 'x', 'utf8');
    expect(() => makeFsSinkFactory(asFile)).toThrow(FsSinkConfigError);
  });

  it('refuses a non-positive or non-integer bound — a 0 is a misconfiguration, not "unlimited"', () => {
    expect(() => makeFsSinkFactory(root, { maxFiles: 0 })).toThrow(FsSinkConfigError);
    expect(() => makeFsSinkFactory(root, { maxTotalBytes: -1 })).toThrow(FsSinkConfigError);
    expect(() => makeFsSinkFactory(root, { maxBytesPerFile: 1.5 })).toThrow(FsSinkConfigError);
  });

  it("accepts a root that is ITSELF a symlink — that is the DEPLOYER's own path, not a caller escape", async () => {
    const realTarget = join(sandbox, 'real-out');
    mkdirSync(realTarget, { recursive: true });
    const linkedRoot = join(sandbox, 'linked-out');
    symlinkSync(realTarget, linkedRoot);
    const s = makeFsSinkFactory(linkedRoot)();
    await expect(s.write('note.txt', enc('fine'))).resolves.toMatchObject({ path: 'note.txt' });
    expect(readFileSync(join(realTarget, 'note.txt'), 'utf8')).toBe('fine');
  });

  it('the error NAME is the machine-readable code a seat reads through the tool-error channel', async () => {
    const s = sink({ maxBytesPerFile: 1 });
    // `dispatchTool` renders a thrown handler error as `handler error: ${String(e)}`, and String(e) on
    // an Error is `${name}: ${message}` — so the class name IS the code the seat sees.
    await expect(s.write('x.txt', enc('too long'))).rejects.toThrow(
      expect.objectContaining({ name: 'FsSinkQuotaError' }),
    );
    await expect(s.write('../x.txt', enc('x'))).rejects.toThrow(
      expect.objectContaining({ name: 'FsSinkJailError' }),
    );
  });
});
