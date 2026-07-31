/**
 * The module-path extension vocabulary — its EXPORTED SHAPE and its answers.
 *
 * This module is the single source of the TypeScript-source extension vocabulary behind three
 * decisions in two packages: the handler loader's fail-closed compiled-JavaScript guard, the
 * extension-pack resolver's compiled-sibling preference, and the `typescript_handler_module`
 * advisory. A guard that fails closed may not depend on state a consumer can rewrite, so the shape
 * of the export is itself load-bearing and gets pinned here alongside the answers.
 */
import { describe, expect, it } from 'vitest';
// The NAMESPACE import is what the surface pin walks (it sees every export, including one added
// later); the named import is for the behaviour arms below.
import * as moduleExtensions from './module-extensions.js';
import { typeScriptSourceExtensionOf } from './module-extensions.js';

describe('module-extensions — the exported surface', () => {
  it('exposes the vocabulary ONLY behind a call — no shared object crosses the package boundary', () => {
    // FAIL-THE-FIX: export the vocabulary as a collection (a `Set`, a `Map`, an array) and this
    // flips. Such an export is LIVE across the package boundary: `ReadonlySet` is a compile-time
    // type, so any consumer — or any code merely sharing the process — can `.add`/`.clear` the
    // object the fail-closed loader guard consults and silently defeat it. A function hands out an
    // ANSWER, so the vocabulary can be asked but never held.
    for (const [name, value] of Object.entries(moduleExtensions)) {
      expect({
        export: name,
        callable: typeof value === 'function',
        sharedObject: typeof value === 'object' && value !== null,
      }).toEqual({ export: name, callable: true, sharedObject: false });
    }
  });
});

describe('typeScriptSourceExtensionOf', () => {
  it.each([
    ['handlers/x.ts', '.ts'],
    ['handlers/x.tsx', '.tsx'],
    ['handlers/x.mts', '.mts'],
    ['handlers/x.cts', '.cts'],
  ])('matches the CLOSED TypeScript-source vocabulary (%s)', (modulePath, ext) => {
    expect(typeScriptSourceExtensionOf(modulePath)).toBe(ext);
  });

  it.each([
    ['handlers/x.TS', '.ts'],
    ['handlers/x.Mts', '.mts'],
    ['handlers/X.TSX', '.tsx'],
  ])('matches case-INSENSITIVELY and answers case-folded (%s)', (modulePath, ext) => {
    // A case-insensitive file system resolves `x.TS` and `x.ts` to the same file, so a match that
    // only recognised lowercase would hand a TypeScript source module straight past the loader's
    // fail-closed guard. The answer is folded so the three call sites quote one spelling.
    expect(typeScriptSourceExtensionOf(modulePath)).toBe(ext);
  });

  it.each([
    'handlers/x.js',
    'handlers/x.mjs',
    'handlers/x.cjs',
    'handlers/x.json',
    'handlers/x.tsv', // a near-miss: the vocabulary is matched whole, never as a prefix
    'handlers/x',
    'handlers/.ts', // a dotfile NAMED `.ts` carries no extension at all
    '',
  ])('answers undefined for a path carrying no TypeScript-source extension (%s)', (modulePath) => {
    expect(typeScriptSourceExtensionOf(modulePath)).toBeUndefined();
  });
});
