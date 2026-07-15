/**
 * The `.env` auto-loader, END-TO-END through the CLI (DB-backed, fail-the-fix) — a local-DX convenience.
 *
 * This is the load-bearing proof that the loader actually fixes the DX nit it was added for:
 *
 *  (c) FAIL-THE-FIX: with the loader pointed at a `.env` that provides SHADOW_DATABASE_URL (the REAL
 *      shadow DB) and NO ambient SHADOW_DATABASE_URL in the environment, `rayspec plan` on a valid
 *      spec now reports `shadowApplied:true` — i.e. the optional shadow-apply, which used to silently
 *      SKIP for lack of a shadow URL, now runs out of the box. REMOVE the loader call from `main()`
 *      (or break the no-`.env` load) and this goes RED (`shadowApplied:false`).
 *
 *  (d) the read-only guard STILL HOLDS over the LOADED env: when the loaded DATABASE_URL === the loaded
 *      SHADOW_DATABASE_URL (both pointing at the same real DB), the read-only same-DB guard REFUSES the
 *      shadow (ok:false, phase:'shadow') and opens NO admin connection — the loader does not weaken
 *      the read-only guarantee, it only gives the read-only guard a DATABASE_URL to compare against.
 *
 * Self-skips when SHADOW_DATABASE_URL is unset in the environment (mirrors the other *.db.test.ts —
 * we need a reachable real shadow DB to apply against). We read it from the AMBIENT env to know the
 * real shadow URL, then write it into a TEMP `.env` and delete it from the ambient env so the only way
 * `plan` can see it is via the loader (that is what makes this a true fail-the-fix).
 *
 * The loader resolves `.env` relative to its own module dir; we redirect that single resolve() to our
 * temp `.env` via a `node:path` re-mock (same technique as read-env.test.ts), and import a FRESH copy
 * of `main` so it binds the redirected loader.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ambientShadow = process.env.SHADOW_DATABASE_URL;
const hasShadow = Boolean(ambientShadow);
const requireDb = process.env.CI === 'true' || process.env.RAYSPEC_REQUIRE_DB_TESTS === 'true';
// un-skippable ran-guard: this DB-backed suite proves the .env auto-loader lets shadow-apply run out of
// the box (a real fail-the-fix) — it must never silently self-skip to a false green. When the shadow DB
// is REQUIRED but absent, hard-fail at collection rather than skip.
if (requireDb && !hasShadow) {
  throw new Error(
    'read-env.db.test: SHADOW_DATABASE_URL is required (CI / RAYSPEC_REQUIRE_DB_TESTS) but absent — ' +
      'refusing to silently skip this DB-backed suite.',
  );
}

const VALID_SPEC = `
version: '1.0'
metadata:
  name: cli-readenv-db-test
stores:
  - name: widgets
    columns:
      - { name: label, type: text }
      - { name: qty, type: integer }
`;

let dir: string;
let prevCwd: string;
let outChunks: string[];
let errChunks: string[];

/**
 * Import a FRESH `main` whose loader's `.env` path is redirected to `envPath` (via a node:path resolve
 * redirect). Returns `main`. Re-imported per test (resetModules) so the redirect is hermetic.
 */
async function mainPointedAt(envPath: string): Promise<typeof import('./index.js').main> {
  vi.resetModules();
  vi.doMock('node:path', async () => {
    const actual = await vi.importActual<typeof import('node:path')>('node:path');
    return {
      ...actual,
      resolve: (...segs: string[]) =>
        segs[segs.length - 1] === '.env' ? envPath : actual.resolve(...segs),
    };
  });
  const mod = await import('./index.js');
  return mod.main;
}

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  // Capture stdout/stderr — invoke the drain callback (writes use the (string, cb) form).
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    outChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    errChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  prevCwd = process.cwd();
});

afterEach(() => {
  process.chdir(prevCwd);
  vi.restoreAllMocks();
  vi.doUnmock('node:path');
  vi.resetModules();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasShadow)(
  'rayspec plan — .env auto-loader gives the shadow its URL (fail-the-fix)',
  () => {
    it('(c) NO ambient SHADOW_DATABASE_URL + a .env that provides it → shadowApplied:true', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cli-readenv-db-'));
      // The spec must live inside the cwd (read jail) — write it in the temp dir and chdir there.
      writeFileSync(join(dir, 'rayspec.yaml'), VALID_SPEC, 'utf8');
      // The temp `.env` provides the REAL shadow URL (so the shadow can actually apply).
      const envPath = join(dir, '.env');
      writeFileSync(envPath, `SHADOW_DATABASE_URL=${ambientShadow}\n`, 'utf8');
      process.chdir(dir);

      // Remove BOTH from the ambient env: the ONLY way plan can see the shadow URL is via the loader.
      // (DATABASE_URL stays removed so the read-only guard has no real-DB target → the sibling shadow runs unimpeded.)
      const prevShadow = process.env.SHADOW_DATABASE_URL;
      const prevDb = process.env.DATABASE_URL;
      delete process.env.SHADOW_DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const main = await mainPointedAt(envPath);
        const code = await main(['plan', 'rayspec.yaml']);
        const result = JSON.parse(outChunks.join(''));
        expect(errChunks.join('')).toBe('');
        // The fix: the shadow ran out of the box because the loader supplied SHADOW_DATABASE_URL.
        expect(result.ok).toBe(true);
        expect(result.shadowApplied).toBe(true);
        expect(code).toBe(0);
        // The loader actually populated process.env (no-override path: it was unset).
        expect(process.env.SHADOW_DATABASE_URL).toBe(ambientShadow);
        // No secret leak in the output.
        expect(JSON.stringify(result)).not.toContain('postgres://');
      } finally {
        if (prevShadow === undefined) delete process.env.SHADOW_DATABASE_URL;
        else process.env.SHADOW_DATABASE_URL = prevShadow;
        if (prevDb === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = prevDb;
      }
    }, 60_000);

    it('(d) loaded DATABASE_URL === loaded SHADOW_DATABASE_URL → the read-only guard refuses (ok:false phase:shadow)', async () => {
      dir = mkdtempSync(join(tmpdir(), 'cli-readenv-db-'));
      writeFileSync(join(dir, 'rayspec.yaml'), VALID_SPEC, 'utf8');
      // BOTH point at the SAME real DB → the guard must refuse. (We never connect: the guard returns before any
      // admin connection, so using the same real shadow URL for both is safe — nothing is mutated.)
      const envPath = join(dir, '.env');
      writeFileSync(
        envPath,
        `DATABASE_URL=${ambientShadow}\nSHADOW_DATABASE_URL=${ambientShadow}\n`,
        'utf8',
      );
      process.chdir(dir);

      const prevShadow = process.env.SHADOW_DATABASE_URL;
      const prevDb = process.env.DATABASE_URL;
      delete process.env.SHADOW_DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const main = await mainPointedAt(envPath);
        const code = await main(['plan', 'rayspec.yaml']);
        const result = JSON.parse(outChunks.join(''));
        // The guard fired: the loader gave it a DATABASE_URL to compare against, and it matched the shadow.
        expect(result.ok).toBe(false);
        expect(result.phase).toBe('shadow');
        expect(result.shadowApplied).toBe(false);
        expect(result.errors[0]?.message).toMatch(/refusing to shadow-apply/i);
        expect(code).toBe(1);
        // No secret leak in the refusal.
        expect(JSON.stringify(result)).not.toContain('postgres://');
      } finally {
        if (prevShadow === undefined) delete process.env.SHADOW_DATABASE_URL;
        else process.env.SHADOW_DATABASE_URL = prevShadow;
        if (prevDb === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = prevDb;
      }
    }, 60_000);
  },
);
