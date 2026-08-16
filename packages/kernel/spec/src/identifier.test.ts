/**
 * The identifier rule is a LEAF module — an IMPORT-GRAPH assertion, not a behaviour one.
 *
 * `identifier.ts` holds the safe-identifier rule so a grammar that is NOT the document grammar can
 * share it. Such a grammar is itself imported BY `grammar.ts`, so if the rule module reached back
 * into `grammar.ts` the two would form a cycle — and a cycle here does not fail the build: TypeScript
 * compiles it, the ESM loader resolves it, and the only symptom is a `SafeIdentifier` that is
 * `undefined` at the moment a module-level `z.object({ name: SafeIdentifier })` evaluates, in
 * whichever of the two modules happens to be entered second. That is a load-order accident, so no
 * behaviour test can pin it — the SHAPE OF THE IMPORT GRAPH is what has to be asserted.
 *
 * The assertion is therefore made on the SOURCE: `identifier.ts` may name external packages only.
 * Zero relative specifiers is a stronger and simpler statement than "not `./grammar.js`" — it closes
 * the TRANSITIVE route (a rule module importing a third module that imports the grammar) with the
 * same one line.
 *
 * The second test pins the other half of the move: `grammar.ts` re-exports the very same bindings, so
 * every module that reaches for the rule through the grammar keeps the identical object.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertSafeIdentifier as assertViaGrammar,
  MAX_IDENTIFIER_LENGTH as MAX_VIA_GRAMMAR,
  SAFE_IDENTIFIER_RE as RE_VIA_GRAMMAR,
  SafeIdentifier as SafeIdentifierViaGrammar,
} from './grammar.js';
import {
  assertSafeIdentifier,
  MAX_IDENTIFIER_LENGTH,
  SAFE_IDENTIFIER_RE,
  SafeIdentifier,
} from './identifier.js';

const identifierSource = readFileSync(
  fileURLToPath(new URL('./identifier.ts', import.meta.url)),
  'utf8',
);

/**
 * Every module specifier `source` imports or re-exports, static or dynamic. Comments are stripped
 * first so a docblock that discusses a path cannot be mistaken for an edge of the import graph.
 */
function importedSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const specifiers: string[] = [];
  for (const re of [
    /\bfrom\s*['"]([^'"]+)['"]/g, //            import … from 'x'  /  export … from 'x'
    /\bimport\s*['"]([^'"]+)['"]/g, //          import 'x'         (side-effect)
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g, //     import('x')        (dynamic)
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g, //    require('x')
  ]) {
    for (const m of code.matchAll(re)) if (m[1] !== undefined) specifiers.push(m[1]);
  }
  return specifiers;
}

describe('identifier.ts is a leaf module (the cycle a pack grammar would otherwise close)', () => {
  it('imports no sibling module — so it can never reach grammar.ts, directly or transitively', () => {
    const relative = importedSpecifiers(identifierSource).filter((s) => s.startsWith('.'));
    expect(relative).toEqual([]);
  });

  it('grammar.ts re-exports the identical bindings, so every existing import keeps working', () => {
    expect(SafeIdentifierViaGrammar).toBe(SafeIdentifier);
    expect(assertViaGrammar).toBe(assertSafeIdentifier);
    expect(RE_VIA_GRAMMAR).toBe(SAFE_IDENTIFIER_RE);
    expect(MAX_VIA_GRAMMAR).toBe(MAX_IDENTIFIER_LENGTH);
  });
});

describe('the rule itself is unchanged by the move', () => {
  it('accepts a snake_case name and refuses the shapes the rule exists to refuse', () => {
    expect(SafeIdentifier.safeParse('widget_labels').success).toBe(true);
    expect(SafeIdentifier.safeParse('_leading').success).toBe(true);
    for (const bad of ['Widgets', '1widget', 'w idget', 'm" ); DROP', '', 'a'.repeat(64)]) {
      expect(SafeIdentifier.safeParse(bad).success).toBe(false);
    }
  });

  it('assertSafeIdentifier throws with the message the generators rely on', () => {
    expect(() => assertSafeIdentifier('widget_labels', 'store name')).not.toThrow();
    expect(() => assertSafeIdentifier('Widgets', "store name 'Widgets'")).toThrow(
      /unsafe identifier for store name 'Widgets': "Widgets" — must match/,
    );
    expect(() => assertSafeIdentifier('a'.repeat(64), 'store name')).toThrow(
      /be <= 63 chars \(injection guard, TEN-1\)/,
    );
  });
});
