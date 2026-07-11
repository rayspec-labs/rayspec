/**
 * `assertProductScope` — the fail-closed boot-scope gate for a product-profile document.
 *
 *
 * A `ProductSpec` can be grammar-valid (parseProductSpec-clean) yet declare a shape the composable v1
 * envelope does NOT support end-to-end — a sufficiency finding named these. This gate is the
 * boot FRONT-DOOR: `deployProductYamlSpec` runs it right after parse (before any compose/derive/DBOS
 * work) so an operator gets ONE actionable message instead of a deep, less-legible internal error (the
 * single-scope law) or a green-but-surprising boot (a non-capability POST view mounts + boots today).
 *
 * WHAT IT REJECTS (fail-closed, aggregated — the whole list in one throw):
 *
 *  A. MULTI-SCOPE PERSISTENCE — persisted artifacts (`lifecycle.persist !== false`) declaring 2+
 *     DISTINCT non-empty `scope`s. The materializer scopes every collection row by ONE `<scope>_id`
 *     column per deployment (the single-scope law, enforced 3× downstream in derive-stores/compose/
 *     nodes). A two-scope document therefore cannot be materialized; this front-doors that law with an
 *     actionable message BEFORE the deeper machinery. (A single-scope doc — e.g. support-triage is
 *     all `ticket` — passes. A `persist:false` artifact is excluded, exactly as the
 *     derivation excludes it.)
 *
 *  B. PRODUCT-DECLARED WRITE/ADMIN SURFACE — a POST view whose `source.kind` is NOT `capability`. The
 *     grammar already bans PUT/DELETE/PATCH (a mutating verb implies a handler; the product profile has none). Within
 *     GET/POST, a POST view is a COMMAND; the ONLY supported command is a capability-backed one (e.g.
 *     the playback-token mint — `source.kind: capability`). A POST view over a `store`/`artifact_query`
 *     read source (or with NO source) is a would-be write/admin surface: the views runtime is
 *     read-only, so today it silently mounts an interpreted READ served on POST — a surprising surface
 *     nothing else rejects. Product writes flow through the ingress capability + workflow ONLY, and
 *     reads are GET views. (A capability-backed POST view — e.g. a media playback-token mint — is a
 *     capability command, so it passes.)
 *
 * NOTE this gate does NOT re-validate anything parse/lint already covers; it inspects only the
 * scope/write-surface envelope. It is pure (no I/O), so it is unit-tested standalone and reused by the
 * boot verbatim.
 */
import type { ProductSpec } from './product-grammar.js';

/** A fail-closed product-scope violation set (thrown by `assertProductScope`). */
export class ProductScopeError extends Error {
  /** The individual, actionable violation messages (one per out-of-scope shape). */
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(
      `the Product-YAML document declares ${violations.length} shape(s) outside the composable v1 ` +
        `envelope — the deployment cannot serve them end-to-end (fail-closed):\n` +
        violations.map((v) => `  - ${v}`).join('\n'),
    );
    this.name = 'ProductScopeError';
    this.violations = violations;
  }
}

/**
 * Collect the out-of-scope violations of a parsed `ProductSpec` (empty ⇒ in-scope). Pure — the boot
 * throws `ProductScopeError` on a non-empty result via `assertProductScope`.
 */
export function collectProductScopeViolations(spec: ProductSpec): string[] {
  const violations: string[] = [];

  // ── A. multi-scope persistence ────────────────────────────────────────────────────────────────
  const persisting = spec.artifacts.filter((a) => a.lifecycle?.persist !== false);
  const scopes = [
    ...new Set(
      persisting
        .map((a) => a.scope)
        .filter((s): s is string => typeof s === 'string' && s.length > 0),
    ),
  ];
  if (scopes.length > 1) {
    violations.push(
      `multi-scope persistence: persisted artifacts declare ${scopes.length} distinct scopes ` +
        `(${scopes.join(', ')}), but a Product-YAML deployment materializes ONE '<scope>_id' column ` +
        `per collection (the single-scope law) — every persisted artifact kind must share ONE scope. ` +
        `Split this into separate products, or align the artifacts on a single scope.`,
    );
  }

  // ── B. product-declared write/admin surface (a non-capability POST view) ────────────────────────
  for (const view of spec.views) {
    if (view.route.method === 'POST' && view.source?.kind !== 'capability') {
      const src = view.source?.kind ?? '(none)';
      violations.push(
        `write/admin surface: view '${view.id}' is a POST over a '${src}' source. A POST view is a ` +
          `COMMAND, and the only supported command is a capability-backed one (source.kind: capability, ` +
          `e.g. a playback-token mint). The product profile has no product-declared write/admin surface — reads are GET ` +
          `views and product writes flow through the ingress capability + workflow. Use method GET for a ` +
          `read, or source.kind: capability for a command.`,
      );
    }
  }

  return violations;
}

/**
 * The boot-scope gate: throw `ProductScopeError` (aggregating EVERY violation) when a parsed
 * `ProductSpec` declares a shape outside the composable v1 envelope. A no-op for an in-scope document
 * (support-triage and the acceptance product all pass).
 */
export function assertProductScope(spec: ProductSpec): void {
  const violations = collectProductScopeViolations(spec);
  if (violations.length > 0) throw new ProductScopeError(violations);
}
