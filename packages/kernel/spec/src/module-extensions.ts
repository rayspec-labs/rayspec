/**
 * The module-path extension vocabulary shared by the document and the loaders that consume it.
 */

/**
 * The TypeScript-source file extensions a `module:` path may carry — ONE constant so the three sites
 * that reason about them cannot drift apart:
 *
 *  - the handler loader REFUSES a module resolved to one of these, fail-closed: production loads
 *    compiled JavaScript ONLY (`assertCompiledJavaScriptModule`);
 *  - the extension-pack resolver PREFERS the compiled `.js` sibling of one of these when it exists on
 *    disk, so a BUILT pack deploys with its authored TypeScript manifest paths untouched
 *    (`resolvePackModule`);
 *  - `lintSpecWarnings` reports, statically, that a document declaring one on `handlers[].module`
 *    needs a build step before deploy.
 *
 * The set is CLOSED and matched by a plain `extname` comparison, so every one of those decisions is
 * DETERMINISTIC and independent of the Node runtime's behavior — in particular of whether a given Node
 * version transparently type-strips `.ts` on import.
 */
export const TYPESCRIPT_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);
