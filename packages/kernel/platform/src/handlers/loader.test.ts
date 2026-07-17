/**
 * Loader path-jail + fail-closed-resolution tests.
 *
 * These are FAIL-THE-FIX: each asserts the loader REJECTS a real escape vector (so weakening the
 * jail breaks a test) AND accepts a legitimate in-root module. No real on-disk handler is needed —
 * `jailModulePath` is pure, and `loadHandlers` takes an injected importer.
 */
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HandlerSpec } from '@rayspec/spec';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HandlerLoadError, jailModulePath, loadHandlers, type ModuleImporter } from './loader.js';

const ROOT = '/srv/app/escape-hatch';

describe('jailModulePath — path jail (fail-closed)', () => {
  it('ACCEPTS a `./`-relative module inside the root and returns its absolute path', () => {
    expect(jailModulePath(ROOT, './handlers/lookup.ts', 'h')).toBe(
      '/srv/app/escape-hatch/handlers/lookup.ts',
    );
    expect(jailModulePath(ROOT, './a/b/c.ts', 'h')).toBe('/srv/app/escape-hatch/a/b/c.ts');
  });

  it('ACCEPTS a ROOT-RELATIVE module without a `./` prefix (a config path, not a Node specifier)', () => {
    // A `handlers[].module` is a FILESYSTEM PATH relative to the root — `handlers/x.ts` means
    // <root>/handlers/x.ts (the throwaway authors paths this way), NOT a Node bare specifier.
    expect(jailModulePath(ROOT, 'handlers/lookup.ts', 'h')).toBe(
      '/srv/app/escape-hatch/handlers/lookup.ts',
    );
  });

  it('a bare NAME resolves IN-ROOT (so it can NEVER reach an npm package), not to node_modules', () => {
    // The security property: every module is resolved RELATIVE TO THE ROOT, so `lodash` → <root>/lodash
    // (which does not exist → the import fail-closes), never the node_modules package.
    expect(jailModulePath(ROOT, 'lodash', 'h')).toBe('/srv/app/escape-hatch/lodash');
    expect(jailModulePath(ROOT, '@scope/pkg', 'h')).toBe('/srv/app/escape-hatch/@scope/pkg');
  });

  it('REJECTS an absolute module path', () => {
    expect(() => jailModulePath(ROOT, '/etc/passwd', 'h')).toThrow(HandlerLoadError);
    expect(() => jailModulePath(ROOT, '/etc/passwd', 'h')).toThrow(/ABSOLUTE path/);
  });

  it('REJECTS a `..` traversal that climbs out of the root', () => {
    expect(() => jailModulePath(ROOT, '../secrets.ts', 'h')).toThrow(/traversal|OUTSIDE|UNDER/);
    expect(() => jailModulePath(ROOT, './a/../../b.ts', 'h')).toThrow(HandlerLoadError);
  });

  it('REJECTS a `..` traversal even when it would resolve back inside (no `..` segments allowed)', () => {
    // `./a/../b.ts` normalizes to `./b.ts` (still inside) but contains a `..` segment → rejected
    // fail-closed (we forbid `..` outright rather than reason about where it lands).
    expect(() => jailModulePath(ROOT, './a/../b.ts', 'h')).toThrow(/traversal/);
    expect(() => jailModulePath(ROOT, 'a/../b.ts', 'h')).toThrow(/traversal/);
  });

  it('REJECTS the root itself (a module must be a file under the root, not the root dir)', () => {
    expect(() => jailModulePath(ROOT, '.', 'h')).toThrow(HandlerLoadError);
  });

  it('REJECTS URL-significant chars (% # ?) — JAIL-URLDECODE-ESCAPE (e.g. %2e%2e → ..)', () => {
    // `%2e%2e` has no RAW `..` (so it would pass the `..` check) but URL-DECODES to `..` once the
    // path becomes a file URL — escaping the root. Reject `%`/`#`/`?` at the source, fail-closed.
    expect(() => jailModulePath(ROOT, '%2e%2e/outside/evil.mjs', 'h')).toThrow(/URL-significant/);
    expect(() => jailModulePath(ROOT, 'x%2e%2e.ts', 'h')).toThrow(/URL-significant/);
    expect(() => jailModulePath(ROOT, 'a#b.ts', 'h')).toThrow(/URL-significant/);
    expect(() => jailModulePath(ROOT, 'a?b.ts', 'h')).toThrow(/URL-significant/);
    // A normal module (no URL-significant chars) still resolves.
    expect(jailModulePath(ROOT, 'handlers/ok.ts', 'h')).toBe(
      '/srv/app/escape-hatch/handlers/ok.ts',
    );
  });
});

describe('jailModulePath — SYMLINK re-check (defense-in-depth)', () => {
  let dir: string; // a real temp tree: <dir>/root/ (the jail) + <dir>/outside/secret.ts
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'rayspec-jail-'));
    const root = join(dir, 'root');
    const outside = join(dir, 'outside');
    // Create root/ + outside/ + an outside secret, then a symlink INSIDE root pointing OUT.
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.ts'), 'export const x = 1;\n');
    // A lexically-in-root path (root/link.ts) that, via symlink, points OUT to outside/secret.ts.
    try {
      symlinkSync(join(outside, 'secret.ts'), join(root, 'link.ts'));
    } catch {
      // symlink may be unavailable (e.g. restricted CI fs); the test self-skips below in that case.
    }
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('REJECTS a lexically-in-root symlink that RESOLVES outside the root', () => {
    const root = join(dir, 'root');
    // The path is lexically inside root (passes checks 1-3); the realpath re-check (#4) must catch it.
    let symlinkWorks = true;
    try {
      lstatSync(join(root, 'link.ts'));
    } catch {
      symlinkWorks = false;
    }
    if (!symlinkWorks) return; // environment without symlink support → skip (not a regression).
    expect(() => jailModulePath(root, 'link.ts', 'h')).toThrow(
      /symlink re-check|following symlinks/,
    );
  });

  it('ACCEPTS a real (non-symlink) file inside the root (the symlink check is not over-broad)', () => {
    const root = join(dir, 'root');
    writeFileSync(join(root, 'real.ts'), 'export const y = 2;\n');
    expect(() => jailModulePath(root, 'real.ts', 'h')).not.toThrow();
  });
});

function spec(overrides: Partial<HandlerSpec> = {}): HandlerSpec {
  return { id: 'h', module: './h.ts', export: 'run', kind: 'tool', ...overrides };
}

describe('loadHandlers — fail-closed resolution at boot', () => {
  it('resolves a present function export into a typed ResolvedHandler', async () => {
    const fn = () => 'ok';
    const importer: ModuleImporter = vi.fn(async () => ({ run: fn }));
    const map = await loadHandlers(ROOT, [spec()], importer);
    const resolved = map.get('h');
    expect(resolved?.kind).toBe('tool');
    expect(resolved?.fn).toBe(fn);
    // The importer was called with the JAILED absolute path (jail runs BEFORE the importer).
    expect(importer).toHaveBeenCalledWith('/srv/app/escape-hatch/h.ts');
  });

  it('FAILS CLOSED when the named export is MISSING (aborts boot, not a runtime 500)', async () => {
    const importer: ModuleImporter = async () => ({ somethingElse: () => 0 });
    await expect(loadHandlers(ROOT, [spec({ export: 'run' })], importer)).rejects.toThrow(
      /no export 'run'/,
    );
  });

  it('FAILS CLOSED when the export is not a function', async () => {
    const importer: ModuleImporter = async () => ({ run: 42 });
    await expect(loadHandlers(ROOT, [spec()], importer)).rejects.toThrow(/is not a function/);
  });

  it('FAILS CLOSED when the import THROWS (missing module)', async () => {
    const importer: ModuleImporter = async () => {
      throw new Error('ENOENT');
    };
    await expect(loadHandlers(ROOT, [spec()], importer)).rejects.toThrow(/failed to import/);
  });

  it('FAILS CLOSED on a jail violation BEFORE importing (the importer is never called)', async () => {
    const importer: ModuleImporter = vi.fn(async () => ({ run: () => 0 }));
    await expect(loadHandlers(ROOT, [spec({ module: '../escape.ts' })], importer)).rejects.toThrow(
      HandlerLoadError,
    );
    expect(importer).not.toHaveBeenCalled();
  });

  it('preserves the declared kind on the ResolvedHandler (tool/route/trigger)', async () => {
    const importer: ModuleImporter = async () => ({ run: () => 0 });
    const map = await loadHandlers(
      ROOT,
      [
        spec({ id: 't', kind: 'tool' }),
        spec({ id: 'r', kind: 'route' }),
        spec({ id: 'g', kind: 'trigger' }),
      ],
      importer,
    );
    expect(map.get('t')?.kind).toBe('tool');
    expect(map.get('r')?.kind).toBe('route');
    expect(map.get('g')?.kind).toBe('trigger');
  });
});
