/**
 * the boot-time document-family guard (`assertSpecFamilyMountable`) that `deployDeclaredSpec`
 * runs before it re-parses a spec as a RaySpec. A Product-YAML doc pointed at by RAYSPEC_SPEC_PATH
 * must abort boot with the SAME helpful guidance `deploy()` gives — NOT the raw RaySpec strict-shape
 * wall (a wall of `unknown_field` errors). A classic RaySpec / version-less doc must pass through
 * untouched. This is the exact guard the boot path calls, unit-tested without a DB-backed boot.
 */
import { describe, expect, it } from 'vitest';
import { assertSpecFamilyMountable, BootConfigError } from './composition-root.js';

const VALID_PRODUCT = 'version: "1.0"\nproduct:\n  id: acme\n  name: Acme\n';
// `status: available` is doc-valid now (wiredness moved to the deploy composition); the
// invalid vehicle here is a DANGLING `requires` ref — a genuine doc-level defect.
const INVALID_PRODUCT =
  'version: "1.0"\nproduct:\n  id: acme\n  name: Acme\n' +
  'requires:\n  capabilities:\n    - ghost\n';
const RAYSPEC = 'version: "1.0"\nmetadata:\n  name: m\n';

describe('assertSpecFamilyMountable (boot family dispatch)', () => {
  it('aborts a VALID Product-YAML doc with the deploy() guidance (not a strict-shape wall)', () => {
    let thrown: unknown;
    try {
      assertSpecFamilyMountable(VALID_PRODUCT, '/x/acme-notes.product.yaml');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BootConfigError);
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/valid Product-YAML document/i);
    expect(msg).toMatch(/not mountable/i);
    expect(msg).toContain('acme'); // the product id is surfaced, like deploy()
    expect(msg).not.toMatch(/unknown_field/); // NOT the RaySpec strict-shape wall
  });

  it('aborts an INVALID Product-YAML doc with its validation errors (not the mount guidance)', () => {
    let thrown: unknown;
    try {
      assertSpecFamilyMountable(INVALID_PRODUCT, '/x/bad.product.yaml');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BootConfigError);
    const msg = (thrown as Error).message;
    expect(msg).toMatch(/Product-YAML spec .* is invalid/i);
    expect(msg).toContain('dangling_ref');
  });

  it('does NOT throw for a classic RaySpec doc (boot proceeds unchanged)', () => {
    expect(() => assertSpecFamilyMountable(RAYSPEC, '/x/rayspec.yaml')).not.toThrow();
  });

  it('does NOT throw for a version-less / unknown-root doc (routes to the RaySpec path)', () => {
    expect(() => assertSpecFamilyMountable('metadata:\n  name: x\n', '/x/a.yaml')).not.toThrow();
    expect(() => assertSpecFamilyMountable('- a\n- b\n', '/x/b.yaml')).not.toThrow();
  });
});
