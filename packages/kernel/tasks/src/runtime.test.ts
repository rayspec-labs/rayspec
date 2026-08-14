/**
 * The reserved-segment re-export lock. The literal moved to @rayspec/core (spec validation reads it
 * there; spec cannot import this package), and this package re-exports it for its own consumers —
 * this test pins that the two names are the SAME value, so the sets can never drift apart.
 */
import {
  RESERVED_WORKFORCE_SEGMENTS as CORE_SEGMENTS,
  isReservedWorkforceSegment as coreIsReserved,
} from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { isReservedWorkforceSegment, RESERVED_WORKFORCE_SEGMENTS } from './runtime.js';

describe('reserved workforce segments', () => {
  it('re-exports the core set unchanged (identity, not a copy)', () => {
    expect(RESERVED_WORKFORCE_SEGMENTS).toBe(CORE_SEGMENTS);
    expect(isReservedWorkforceSegment).toBe(coreIsReserved);
  });

  it('covers exactly the HTTP collection segments', () => {
    expect([...RESERVED_WORKFORCE_SEGMENTS]).toEqual(['tasks', 'approvals', 'reviews', 'cost']);
    for (const segment of RESERVED_WORKFORCE_SEGMENTS) {
      expect(isReservedWorkforceSegment(segment)).toBe(true);
    }
    expect(isReservedWorkforceSegment('assembly')).toBe(false);
  });
});
