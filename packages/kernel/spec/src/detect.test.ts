/**
 * Dispatch-layer tests — `detectSpecKind` / `validateAnySpec` / `parseAnySpec` route a raw spec to the
 * correct PROFILE of the `version:'1.0'` language: the `product:` section is the archetype discriminant
 * (present → product profile, absent → backend profile). The grammar knows ONLY `version:'1.0'`; a
 * document carrying a removed legacy version key (`version:'0.1'` backend, `product_yaml_version:'0.2'`
 * product) has no `version:'1.0'`, so it routes to the backend parser and is REJECTED there fail-closed
 * with a clean `unsupported_version`.
 */
import { describe, expect, it } from 'vitest';
import { detectSpecKind, parseAnySpec, validateAnySpec } from './detect.js';

/** Canonical backend profile: version:'1.0', no `product:` section. */
const RAYSPEC = "version: '1.0'\nmetadata:\n  name: m\n";
/** Canonical product profile: version:'1.0' + the `product:` discriminant. */
const PRODUCT = "version: '1.0'\nproduct:\n  id: p\n  name: P\n";
/** A removed-legacy product doc (the 0.2 key) — no `version:'1.0'`, so it routes to the backend parser and rejects. */
const LEGACY_PRODUCT = 'product_yaml_version: "0.2"\nproduct:\n  id: p\n  name: P\n';
/** A removed-legacy backend doc (the 0.1 version) — routes to the backend parser and rejects there. */
const LEGACY_BACKEND = "version: '0.1'\nmetadata:\n  name: m\n";

describe('detectSpecKind', () => {
  it("routes a version:'1.0' backend doc (no product:) to rayspec", () => {
    expect(detectSpecKind(RAYSPEC)).toBe('rayspec');
  });
  it("routes a version:'1.0' + product: doc to product", () => {
    expect(detectSpecKind(PRODUCT)).toBe('product');
  });
  it('routes a legacy product_yaml_version doc to the backend parser (no version:1.0 → rayspec, rejected at parse)', () => {
    expect(detectSpecKind(LEGACY_PRODUCT)).toBe('rayspec');
  });
  it("routes a legacy version:'0.1' backend doc to the backend parser (rejected at parse)", () => {
    expect(detectSpecKind(LEGACY_BACKEND)).toBe('rayspec');
  });
  it('routes a version-less object doc to rayspec (so it fails there with a clean unsupported_version)', () => {
    expect(detectSpecKind('metadata:\n  name: x\n')).toBe('rayspec');
  });
  it('reports a non-object / unparseable root as unknown (fail-closed, no mis-routing)', () => {
    expect(detectSpecKind('- just\n- a\n- list\n')).toBe('unknown');
    expect(detectSpecKind('{ broken')).toBe('unknown');
  });
});

describe('validateAnySpec', () => {
  it('validates a backend-profile doc (kind rayspec)', () => {
    const res = validateAnySpec(RAYSPEC);
    expect(res).toEqual({ ok: true, kind: 'rayspec', errors: [] });
  });
  it('validates a product-profile doc (kind product)', () => {
    const res = validateAnySpec(PRODUCT);
    expect(res).toEqual({ ok: true, kind: 'product', errors: [] });
  });
  it('surfaces Product-YAML validation errors (full list, kind product)', () => {
    // A DANGLING `requires` ref — a genuine doc-level defect — surfaces as `dangling_ref`.
    const res = validateAnySpec(
      "version: '1.0'\nproduct:\n  id: p\n  name: P\nrequires:\n  capabilities:\n    - ghost\n",
    );
    expect(res.ok).toBe(false);
    expect(res.kind).toBe('product');
    expect(res.errors.map((e) => e.code)).toContain('dangling_ref');
  });
  it('a product doc does NOT leak into the backend unsupported_version path', () => {
    const res = validateAnySpec(PRODUCT);
    expect(res.errors).toEqual([]);
    expect(res.kind).toBe('product');
  });
});

describe('legacy version keys are rejected fail-closed (one-version purity)', () => {
  it('a removed-legacy product_yaml_version doc → backend parser → unsupported_version', () => {
    expect(detectSpecKind(LEGACY_PRODUCT)).toBe('rayspec');
    const res = validateAnySpec(LEGACY_PRODUCT);
    expect(res.kind).toBe('rayspec');
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'unsupported_version')).toBe(true);
  });

  it("a removed-legacy version:'0.1' backend doc → unsupported_version", () => {
    const res = validateAnySpec(LEGACY_BACKEND);
    expect(res.kind).toBe('rayspec');
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'unsupported_version')).toBe(true);
  });

  it('a canonical version:1.0 product doc with a STRAY product_yaml_version key → the stray is strict-rejected', () => {
    // Routing keys on version:'1.0' + product: → product; the doc is already canonical, so the stray
    // legacy key is an unknown top-level field (fail-closed on the contradiction).
    const doc = 'version: \'1.0\'\nproduct_yaml_version: "0.2"\nproduct:\n  id: p\n  name: P\n';
    expect(detectSpecKind(doc)).toBe('product');
    const res = validateAnySpec(doc);
    expect(res.kind).toBe('product');
    expect(res.ok).toBe(false);
    expect(res.errors.map((e) => e.code)).toContain('unknown_field');
    expect(res.errors.some((e) => e.path === 'product_yaml_version')).toBe(true);
  });
});

describe('parseAnySpec (typed value)', () => {
  it('returns a typed RaySpec', () => {
    const res = parseAnySpec(RAYSPEC);
    expect(res.ok).toBe(true);
    if (res.ok && res.kind === 'rayspec') expect(res.spec.metadata.name).toBe('m');
    else throw new Error('expected rayspec');
  });
  it('returns a typed ProductSpec', () => {
    const res = parseAnySpec(PRODUCT);
    expect(res.ok).toBe(true);
    if (res.ok && res.kind === 'product') expect(res.spec.product.id).toBe('p');
    else throw new Error('expected product');
  });
});
