/**
 * @rayspec/spec — the RaySpec config grammar, parser, linter, and JSON-Schema exporter.
 *
 * A deployed RaySpec backend is ONE validated `RaySpec` (stores · api · agents ·
 * tooling · triggers · handlers). This package owns the GRAMMAR + the fail-closed validation
 * pipeline; the interpreters that turn a validated spec into running infrastructure are built in
 * the interpreter packages (and depend on this package).
 */

// Product-YAML family: the Product-YAML program document grammar/parser/linter + the
// dispatch layer that routes a raw spec to the right family. Additive — the RaySpec surface above
// is unchanged.
export * from './detect.js';
export * from './errors.js';
export * from './export.js';
export * from './grammar.js';
export * from './lint.js';
export * from './parse.js';
export * from './product-events.js';
export * from './product-grammar.js';
export * from './product-lint.js';
export * from './product-parse.js';
export * from './product-scope.js';
export * from './product-views.js';
export * from './product-views-lint.js';
