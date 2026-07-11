/**
 * Effective-dated pricing registry — unit tests.
 *
 * Proves the registry is PURE + deterministic, picks the entry effective AT the run timestamp,
 * carries PROVENANCE (the pricing version tag), keeps the unknown-model FALLBACK VISIBLE (never
 * silently 0), and that reconcileCost trips the drift flag on a REAL divergence (not a tautology).
 */
import { describe, expect, it } from 'vitest';
import {
  computeCost,
  costUsd,
  DEFAULT_DRIFT_THRESHOLD,
  FALLBACK_VERSION,
  PRICING,
  PricingRegistry,
  priceFor,
  reconcileCost,
} from './pricing.js';

describe('pricing registry shape', () => {
  it('the registry parses against its Zod schema (data-driven, typed)', () => {
    expect(() => PricingRegistry.parse(PRICING)).not.toThrow();
  });

  it('every model has at least one ascending-by-effectiveFrom entry', () => {
    for (const [model, entries] of Object.entries(PRICING)) {
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const dates = entries.map((e) => e.effectiveFrom);
      expect([...dates].sort()).toEqual(dates); // already ascending
      expect(model.length).toBeGreaterThan(0);
    }
  });
});

describe('priceFor — effective-dating + provenance', () => {
  it('returns the entry effective AT the timestamp + a provenance tag', () => {
    const p = priceFor('gpt-4.1-mini', '2025-06-01');
    expect(p.fallback).toBe(false);
    expect(p.entry.inputPerM).toBe(0.4);
    expect(p.entry.outputPerM).toBe(1.6);
    // Provenance: <model>@<effectiveFrom> — the tag the journal records.
    expect(p.pricingVersion).toBe('gpt-4.1-mini@2025-04-14');
  });

  describe('multi-entry date-walk — exercises the REAL priceFor (registry param, not a re-impl)', () => {
    // A synthetic multi-entry model fed to the REAL priceFor via its optional registry parameter
    // (the live registry has only single-entry models). S2 review fix: the date-walk SELECTION loop
    // inside priceFor is now exercised by the actual function — not a re-implemented copy.
    const registry = PricingRegistry.parse({
      'demo-model': [
        { effectiveFrom: '2024-01-01', inputPerM: 1, outputPerM: 2 },
        { effectiveFrom: '2025-01-01', inputPerM: 3, outputPerM: 4 },
        { effectiveFrom: '2026-01-01', inputPerM: 5, outputPerM: 6 },
      ],
    });

    it('an `at` BETWEEN two effectiveFrom dates picks the MIDDLE entry', () => {
      const p = priceFor('demo-model', '2025-06-01', registry);
      expect(p.fallback).toBe(false);
      expect(p.entry.inputPerM).toBe(3); // the 2025-01-01 entry, NOT the 2026-01-01 one
      expect(p.pricingVersion).toBe('demo-model@2025-01-01');
    });

    it('the BOUNDARY case `at === effectiveFrom` selects THAT entry (inclusive)', () => {
      const p = priceFor('demo-model', '2026-01-01', registry);
      expect(p.fallback).toBe(false);
      expect(p.entry.inputPerM).toBe(5); // exactly the 2026-01-01 entry (effectiveFrom is inclusive)
      expect(p.pricingVersion).toBe('demo-model@2026-01-01');
    });

    it('the LATEST entry is chosen for an `at` after all effectiveFrom dates', () => {
      const p = priceFor('demo-model', '2030-01-01', registry);
      expect(p.entry.inputPerM).toBe(5); // the newest entry
    });

    it('an `at` BEFORE the earliest entry falls back VISIBLY (not silently the first entry)', () => {
      const p = priceFor('demo-model', '2023-06-01', registry);
      expect(p.fallback).toBe(true);
      expect(p.pricingVersion).toBe(FALLBACK_VERSION);
    });

    it('computeCost drives the same multi-entry walk (middle entry → the middle rate)', () => {
      // (1000*3 + 1000*4)/1e6 = 7000/1e6 = 0.007 — the 2025-01-01 (middle) rate, via the real walk.
      const c = computeCost(
        'demo-model',
        { inputTokens: 1000, outputTokens: 1000 },
        '2025-06-01',
        registry,
      );
      expect(c.costUsd).toBeCloseTo(0.007, 9);
      expect(c.pricingVersion).toBe('demo-model@2025-01-01');
    });
  });

  it('tolerates a dated model suffix via longest-prefix match', () => {
    const p = priceFor('gpt-4.1-mini-2025-04-14', '2025-06-01');
    expect(p.fallback).toBe(false);
    expect(p.entry.inputPerM).toBe(0.4);
    expect(p.pricingVersion).toBe('gpt-4.1-mini@2025-04-14');
  });

  it('an UNKNOWN model falls back VISIBLY (never silently 0) with a FALLBACK provenance tag', () => {
    const p = priceFor('totally-unknown-model-xyz', '2026-01-01');
    expect(p.fallback).toBe(true);
    expect(p.pricingVersion).toBe(FALLBACK_VERSION);
    // The fallback price is NON-ZERO + visible (so an unpriced model is auditable, not invisible).
    expect(p.entry.inputPerM).toBeGreaterThan(0);
    expect(p.entry.outputPerM).toBeGreaterThan(0);
  });

  it('a timestamp BEFORE the model’s earliest price falls back VISIBLY (not silently 0)', () => {
    // gpt-4.1-mini’s first entry is 2025-04-14; a 2020 run predates it → visible fallback.
    const p = priceFor('gpt-4.1-mini', '2020-01-01');
    expect(p.fallback).toBe(true);
    expect(p.pricingVersion).toBe(FALLBACK_VERSION);
  });
});

describe('computeCost — pure, deterministic, full token breakdown', () => {
  it('is a PURE function of (model, usage, at) — same inputs, same output', () => {
    const a = computeCost('gpt-4.1-mini', { inputTokens: 1000, outputTokens: 500 }, '2025-06-01');
    const b = computeCost('gpt-4.1-mini', { inputTokens: 1000, outputTokens: 500 }, '2025-06-01');
    expect(a).toEqual(b);
    // (1000 * 0.4 + 500 * 1.6) / 1e6 = (400 + 800)/1e6 = 0.0012.
    expect(a.costUsd).toBeCloseTo(0.0012, 12);
    expect(a.pricingVersion).toBe('gpt-4.1-mini@2025-04-14');
  });

  it('prices Anthropic cache tokens at the cache rate when the entry declares one', () => {
    const c = computeCost(
      'claude-haiku-4-5',
      { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 10_000 },
      '2025-11-01',
    );
    // input 1000*1.0 + output 1000*5.0 + cacheRead 10000*0.1 = 1000 + 5000 + 1000 = 7000 ; /1e6.
    expect(c.costUsd).toBeCloseTo(0.007, 9);
  });

  it('a model with NO cache rate does NOT double-charge cache tokens', () => {
    // gpt-4.1-mini has no cacheReadPerM; cacheReadTokens are already counted in inputTokens upstream,
    // so passing them must NOT add a second charge.
    const withCache = computeCost(
      'gpt-4.1-mini',
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 999 },
      '2025-06-01',
    );
    const without = computeCost(
      'gpt-4.1-mini',
      { inputTokens: 1000, outputTokens: 0 },
      '2025-06-01',
    );
    expect(withCache.costUsd).toBe(without.costUsd);
  });

  it('costUsd (the scalar helper) equals computeCost.costUsd', () => {
    const scalar = costUsd('gpt-4o', 1234, 567, '2025-01-01');
    const full = computeCost('gpt-4o', { inputTokens: 1234, outputTokens: 567 }, '2025-01-01');
    expect(scalar).toBe(full.costUsd);
  });
});

describe('reconcileCost — drift flag trips on a REAL divergence (not a tautology)', () => {
  it('NO provider cost (OpenAI) → providerCostUsd null + costDrift false (nothing to reconcile)', () => {
    const r = reconcileCost(0.0012, null);
    expect(r.providerCostUsd).toBeNull();
    expect(r.costDrift).toBe(false);
  });

  it('computed ≈ provider (within threshold) → NO drift', () => {
    const r = reconcileCost(0.01, 0.0102); // 2% gap < 5% threshold
    expect(r.costDrift).toBe(false);
    expect(r.providerCostUsd).toBe(0.0102);
  });

  it('computed FAR from provider (beyond threshold) → drift TRIPS', () => {
    const r = reconcileCost(0.01, 0.05); // 80% gap > 5%
    expect(r.costDrift).toBe(true);
  });

  it('the threshold is the boundary (gap relative to the LARGER magnitude)', () => {
    // The denominator is max(|provider|,|computed|). A computed BELOW provider keeps the larger value
    // = provider, so the gap fraction is exactly (provider-computed)/provider — clean to reason about.
    const provider = 1.0;
    const justUnder = provider * (1 - (DEFAULT_DRIFT_THRESHOLD - 0.001)); // gap 4.9% < 5%
    const justOver = provider * (1 - (DEFAULT_DRIFT_THRESHOLD + 0.001)); // gap 5.1% > 5%
    expect(reconcileCost(justUnder, provider).costDrift).toBe(false);
    expect(reconcileCost(justOver, provider).costDrift).toBe(true);
  });

  it('both ~0 → no drift (no div-by-zero false positive)', () => {
    expect(reconcileCost(0, 0).costDrift).toBe(false);
  });

  it('computed non-zero vs provider zero → drift (the full magnitude is the gap)', () => {
    expect(reconcileCost(0.01, 0).costDrift).toBe(true);
  });
});
