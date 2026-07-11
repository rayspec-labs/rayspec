/**
 * Product-YAML grammar shape-PIN tripwires — mirror grammar.test.ts for the RaySpec family.
 * These pin the EXACT closed sets (top-level sections, step types, absent states, capability statuses),
 * so ADDING a section/kind is a DELIBERATE act that fails this test and forces a conscious spec-version
 * decision, and a BANNED value staying out of an enum (e.g. `processing_200`) is a proven invariant.
 */
import { describe, expect, it } from 'vitest';
import {
  CapabilityStatus,
  ProductSpec,
  ViewAbsentState,
  ViewMethod,
  WorkflowStep,
  WorkflowStepType,
} from './product-grammar.js';

describe('product grammar shape pins', () => {
  it('ProductSpec has exactly the expected top-level sections', () => {
    expect(Object.keys(ProductSpec.shape).sort()).toEqual(
      [
        'artifacts',
        'capabilities',
        'contracts',
        'deployment_overrides',
        'extractors',
        'grounding',
        'product',
        'requires',
        // The additive declared-product-stores section. DELIBERATE
        // pin evolution — the absent-section default ([]) keeps every prior product doc byte-identical.
        'stores',
        'version',
        'views',
        'workflows',
      ].sort(),
    );
  });

  it('WorkflowStep carries exactly the expected fields (the S2 store fields are a DELIBERATE addition)', () => {
    expect(Object.keys(WorkflowStep.shape).sort()).toEqual(
      [
        'depends_on',
        'id',
        'inputs',
        'on_error',
        'outputs',
        'retry',
        'type',
        'use',
        // The additive store-step vocabulary (all optional; lint enforces the
        // per-type discipline — store/filter/limit on store_read, store/values on store_write).
        'filter',
        'limit',
        'store',
        'values',
      ].sort(),
    );
  });

  it('WorkflowStepType is a closed set (unknown/typo types fail closed)', () => {
    expect(WorkflowStepType.options.sort()).toEqual(
      [
        'agent',
        'artifact_persist',
        'artifact_read',
        'capability',
        'store_read',
        'store_write',
        'validation',
      ].sort(),
    );
  });

  it('ViewAbsentState omits the draft-banned processing_200 (fail-closed by construction)', () => {
    expect(ViewAbsentState.options.sort()).toEqual(['empty_200', 'not_ready_409'].sort());
    expect(ViewAbsentState.options).not.toContain('processing_200');
  });

  it('ViewMethod is GET/POST only (a mutating verb would imply a route handler)', () => {
    expect(ViewMethod.options.sort()).toEqual(['GET', 'POST'].sort());
  });

  it('CapabilityStatus admits available at the shape level (the lint rejects it with a specific error)', () => {
    expect(CapabilityStatus.options.sort()).toEqual(
      ['available', 'not_yet_runtime', 'reserved'].sort(),
    );
  });
});
