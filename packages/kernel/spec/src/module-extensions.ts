/**
 * The module-path extension vocabulary shared by the document and the loaders that consume it.
 */
import { extname } from 'node:path';

/**
 * The TypeScript-source file extensions a `module:` path may carry — the ONE place the vocabulary is
 * written down, module-PRIVATE so it can be asked but never reached.
 */
const TYPESCRIPT_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.tsx', '.mts', '.cts']);

/**
 * The TypeScript-source extension `modulePath` carries, case-folded — or `undefined` when it carries
 * none. ONE function so the three sites that reason about the vocabulary cannot drift apart:
 *
 *  - the handler loader REFUSES a module resolved to one of these, fail-closed: production loads
 *    compiled JavaScript ONLY (`assertCompiledJavaScriptModule`);
 *  - the extension-pack resolver PREFERS the compiled `.js` sibling of one of these when it exists on
 *    disk, so a BUILT pack deploys with its authored TypeScript manifest paths untouched
 *    (`resolvePackModule`);
 *  - `lintSpecWarnings` reports, statically, that a document declaring one on `handlers[].module`
 *    needs a build step before deploy.
 *
 * A FUNCTION rather than an exported collection, because a fail-closed guard must not consult state
 * its own callers can rewrite: `ReadonlySet` is a compile-time type, so an exported `Set` is a LIVE
 * object across the package boundary that any consumer — or any code merely sharing the process — can
 * `.add('.js')` or `.clear()`, disarming the loader's compiled-JavaScript guard silently and at a
 * distance. Handing back an ANSWER leaves nothing to reach for. It returns the matched extension
 * rather than a boolean because every site needs the extension itself: two quote it in their message,
 * the pack resolver swaps it for `.js`.
 *
 * The set is CLOSED and matched by a plain `extname` comparison against a CASE-FOLDED extension (a
 * case-insensitive file system resolves `handlers/x.TS` and `handlers/x.ts` to the same file), so
 * every one of those decisions is DETERMINISTIC and independent of the Node runtime's behavior — in
 * particular of whether a given Node version transparently type-strips `.ts` on import.
 */
export function typeScriptSourceExtensionOf(modulePath: string): string | undefined {
  const ext = extname(modulePath).toLowerCase();
  return TYPESCRIPT_SOURCE_EXTENSIONS.has(ext) ? ext : undefined;
}
