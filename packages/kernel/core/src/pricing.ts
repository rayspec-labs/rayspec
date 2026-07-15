/**
 * Effective-dated pricing registry — cost as a pure, data-driven, provenanced lookup.
 *
 * Replaces an earlier hard-coded table. Prices are USD per 1M tokens, keyed by model, each model
 * carrying an ORDERED list of effective-dated entries (`effectiveFrom`). `priceFor(model, at)` picks
 * the entry effective at the run timestamp (the latest entry whose `effectiveFrom <= at`), so a
 * historical run is always costed with the price that was in force WHEN IT RAN — a re-cost of an old
 * journal step never silently picks up a newer price. Every lookup returns the EXACT entry it used
 * plus a `pricingVersion` PROVENANCE tag (`<model>@<effectiveFrom>` or the fallback sentinel) so the
 * journal can record WHICH pricing computed a step (deliverable A1/A6).
 *
 * Purity + determinism: no I/O, no clock read inside the math (the caller supplies `at`); the same
 * (model, at, tokens) always yields the same cost. Zod-typed so the registry shape is validated.
 *
 * The unknown-model FALLBACK is kept NON-SILENT: an unknown model is costed with a
 * visible, non-zero fallback price AND a `pricingVersion: 'FALLBACK'` tag, never silently 0 — so an
 * unpriced model is auditable in the ledger rather than disappearing.
 */
import { z } from 'zod';

/**
 * One effective-dated price entry for a model. Per-1M-token rates. The optional cache/reasoning rates
 * carry the asymmetry the extended neutral Usage expresses (Anthropic cache tokens, OpenAI reasoning)
 * WITHOUT forcing every model to declare them — absent ⇒ that token class is not separately priced.
 */
export const PriceEntry = z.object({
  /** ISO-8601 date this price became effective (inclusive). Entries are sorted ascending per model. */
  effectiveFrom: z.string().min(1),
  inputPerM: z.number().nonnegative(),
  outputPerM: z.number().nonnegative(),
  /** Anthropic cache-read tokens (cheaper than fresh input); absent ⇒ priced as input. */
  cacheReadPerM: z.number().nonnegative().optional(),
  /** Anthropic cache-creation tokens (a write surcharge); absent ⇒ not separately priced. */
  cacheCreationPerM: z.number().nonnegative().optional(),
  /** Reasoning tokens (o-series); absent ⇒ priced as output (reasoning IS output tokens upstream). */
  reasoningPerM: z.number().nonnegative().optional(),
});
export type PriceEntry = z.infer<typeof PriceEntry>;

/** The full registry: model → ascending-by-effectiveFrom list of price entries. */
export const PricingRegistry = z.record(z.string(), z.array(PriceEntry).min(1));
export type PricingRegistry = z.infer<typeof PricingRegistry>;

/**
 * The provenance-carrying result of a price lookup. `entry` is the EXACT effective-dated entry used;
 * `pricingVersion` is the audit tag the journal records (`<model>@<effectiveFrom>`, or `'FALLBACK'`);
 * `fallback` is true iff no registry entry matched (unknown model OR `at` predates the first entry).
 */
export interface PricedEntry {
  entry: PriceEntry;
  pricingVersion: string;
  fallback: boolean;
}

/** Backwards-compatible alias (the earlier shape was `{ inputPerM, outputPerM }`). */
export interface ModelPrice {
  inputPerM: number;
  outputPerM: number;
}

/**
 * The effective-dated registry. Effective dates are the documented launch/repricing dates; values
 * are USD per 1M tokens (public list pricing as of the latest entry). The registry is the single
 * source of truth — adding a new price is a data change here, not a code change in the math.
 *
 * NOTE: prices are approximate public list rates kept for cost ATTRIBUTION (a value metric), not an
 * authoritative invoice — the provider-reported cost (Anthropic `total_cost_usd`, Pi `usage.cost.total`)
 * is reconciled against this in the journal (deliverable A3), and a drift beyond the documented
 * threshold is flagged rather than hidden.
 */
export const PRICING: PricingRegistry = {
  // OpenAI (also used by Pi, which runs on the OpenAI API).
  'gpt-4.1': [{ effectiveFrom: '2025-04-14', inputPerM: 2.0, outputPerM: 8.0 }],
  'gpt-4.1-mini': [{ effectiveFrom: '2025-04-14', inputPerM: 0.4, outputPerM: 1.6 }],
  'gpt-4.1-nano': [{ effectiveFrom: '2025-04-14', inputPerM: 0.1, outputPerM: 0.4 }],
  'gpt-4o': [{ effectiveFrom: '2024-05-13', inputPerM: 2.5, outputPerM: 10.0 }],
  'gpt-4o-mini': [{ effectiveFrom: '2024-07-18', inputPerM: 0.15, outputPerM: 0.6 }],
  // gpt-5 (launched 2025-08-07). Public OpenAI list rate: input $1.25 / output $10.00 per 1M (cached
  // input $0.125). Same inputPerM/outputPerM-only shape as the sibling OpenAI entries — the cached-input
  // rate is INTENTIONALLY not a separate cacheReadPerM: OpenAI inputTokens already INCLUDE cache reads,
  // so declaring one here would double-count (see computeCost's cache note).
  'gpt-5': [{ effectiveFrom: '2025-08-07', inputPerM: 1.25, outputPerM: 10.0 }],
  // gpt-5.5 IS the REAL Codex subscription model — the `~/.codex/config.toml`
  // `model = "gpt-5.5"` default (PM-verified), NOT a fabricated placeholder. Only the RATES below are
  // public-list-style ESTIMATES (the public per-token rate is not the load-bearing number here): a
  // Codex run on the ChatGPT subscription is billed=$0 regardless (isSubscriptionBilling — the
  // computed cost is a VALUE metric only). The real model entry just keeps the cost-attribution ledger
  // off the FALLBACK provenance tag.
  'gpt-5.5': [{ effectiveFrom: '2025-12-01', inputPerM: 1.25, outputPerM: 10.0 }],
  // Anthropic. cacheReadPerM is the 0.1x cache-read rate; cacheCreationPerM the 1.25x write rate.
  'claude-sonnet-4-5': [
    {
      effectiveFrom: '2025-09-29',
      inputPerM: 3.0,
      outputPerM: 15.0,
      cacheReadPerM: 0.3,
      cacheCreationPerM: 3.75,
    },
  ],
  'claude-haiku-4-5': [
    {
      effectiveFrom: '2025-10-15',
      inputPerM: 1.0,
      outputPerM: 5.0,
      cacheReadPerM: 0.1,
      cacheCreationPerM: 1.25,
    },
  ],
};

/** The visible, non-silent fallback used when no registry entry matches (unknown model / old date). */
export const FALLBACK_ENTRY: PriceEntry = {
  effectiveFrom: '1970-01-01',
  inputPerM: 1.0,
  outputPerM: 3.0,
};

/** The provenance tag recorded for a step costed by the fallback (auditable, never silent). */
export const FALLBACK_VERSION = 'FALLBACK';

/**
 * Resolve the price entry effective for `model` at instant `at` (an ISO timestamp; defaults to now),
 * WITH provenance. Tolerates dated model suffixes (gpt-4.1-mini-2025-04-14) by longest-prefix match.
 * Picks the LATEST entry whose `effectiveFrom <= at`; if none matches (unknown model, or `at` predates
 * the earliest entry) returns the visible FALLBACK (never silently 0).
 *
 * `registry` defaults to the module `PRICING` (production always uses the default). It is threaded as
 * an OPTIONAL parameter so a test can drive the REAL date-walk against a multi-entry model (the live
 * registry has only single-entry models); the selection loop is thus exercised by the
 * real function, not a re-implemented copy.
 */
export function priceFor(
  model: string,
  at: string = new Date().toISOString(),
  registry: PricingRegistry = PRICING,
): PricedEntry {
  const entries = resolveEntries(model, registry);
  if (!entries) {
    return { entry: FALLBACK_ENTRY, pricingVersion: FALLBACK_VERSION, fallback: true };
  }
  const key = matchedKey(model, registry) ?? model;
  // entries are ascending by effectiveFrom; pick the last one effective at-or-before `at`.
  let chosen: PriceEntry | undefined;
  for (const e of entries) {
    if (e.effectiveFrom <= at) chosen = e;
    else break;
  }
  if (!chosen) {
    // `at` predates the model's earliest known price — fail VISIBLE, not silently 0.
    return { entry: FALLBACK_ENTRY, pricingVersion: FALLBACK_VERSION, fallback: true };
  }
  return {
    entry: chosen,
    pricingVersion: `${key}@${chosen.effectiveFrom}`,
    fallback: false,
  };
}

/** Resolve a model's ascending entry list (exact, else longest-prefix on a dated suffix). */
function resolveEntries(model: string, registry: PricingRegistry): PriceEntry[] | undefined {
  if (registry[model]) return registry[model];
  const key = matchedKey(model, registry);
  return key ? registry[key] : undefined;
}

/** The registry key matched for `model` (exact, else the longest registered prefix). */
function matchedKey(model: string, registry: PricingRegistry): string | undefined {
  if (registry[model]) return model;
  return Object.keys(registry)
    .filter((k) => model.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
}

/** Token usage shape the cost math reads (a subset of the neutral Usage). */
export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

/** The provenanced result of computing a step's cost. */
export interface ComputedCost {
  costUsd: number;
  pricingVersion: string;
  fallback: boolean;
}

/**
 * Compute the COMPUTED cost (USD) for a usage at a point in time, WITH provenance. The full token
 * breakdown is priced: input + output always; cache-read/cache-creation/reasoning at their own rate
 * when the entry declares one (else cache-read folds into input, reasoning into output — i.e. they
 * are NOT double-counted, since the provider's `inputTokens`/`outputTokens` already include them on
 * the SDKs that don't split them). The returned `pricingVersion` is the journal provenance tag.
 *
 * Determinism: pure function of (model, usage, at). No clock read here — `at` is supplied. `registry`
 * defaults to the module `PRICING` (production always uses the default); it is threaded only so a test
 * can exercise the real cost math against a multi-entry model.
 */
export function computeCost(
  model: string,
  usage: CostUsage,
  at: string = new Date().toISOString(),
  registry: PricingRegistry = PRICING,
): ComputedCost {
  const { entry, pricingVersion, fallback } = priceFor(model, at, registry);
  const input = Math.max(0, usage.inputTokens) * entry.inputPerM;
  const output = Math.max(0, usage.outputTokens) * entry.outputPerM;
  // Cache tokens, when the entry prices them separately, are billed ADDITIVELY at the cache rate. This
  // is correct ONLY because the additive model assumes the neutral `inputTokens` EXCLUDES cache tokens
  // — TRUE for Anthropic (the only models that declare a cache rate today): Anthropic's input_tokens do
  // NOT include cache reads/writes, so input*inputPerM + cacheRead*cacheReadPerM never double-counts.
  // (Pi/OpenAI input INCLUDES cache, but no gpt-*/Pi entry declares a cache rate, so the `extra` block
  // never fires for them — no double-count today. If a cache rate is EVER added to an OpenAI/Pi entry,
  // inputTokens must first be normalized to exclude cache, or it WOULD double-count.) When the entry
  // has no cache rate, cache tokens were already priced as input above — do NOT add them again.
  let extra = 0;
  if (entry.cacheReadPerM !== undefined && usage.cacheReadTokens) {
    extra += usage.cacheReadTokens * entry.cacheReadPerM;
  }
  if (entry.cacheCreationPerM !== undefined && usage.cacheCreationTokens) {
    extra += usage.cacheCreationTokens * entry.cacheCreationPerM;
  }
  // Reasoning tokens are already counted in outputTokens on the OpenAI Responses surface; only add a
  // SEPARATE reasoning charge if the entry declares a distinct reasoning rate (none do today).
  if (entry.reasoningPerM !== undefined && usage.reasoningTokens) {
    extra += usage.reasoningTokens * entry.reasoningPerM;
  }
  return { costUsd: (input + output + extra) / 1_000_000, pricingVersion, fallback };
}

/**
 * Backwards-compatible scalar cost helper (the adapters call this). Computes the registry cost for a
 * simple input/output usage at `at` (default now). Returns the bare number; use `computeCost` when
 * you need the provenance tag (run-core does, to journal it).
 */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  at: string = new Date().toISOString(),
): number {
  return computeCost(model, { inputTokens, outputTokens }, at).costUsd;
}

/** The default drift threshold (fraction): |computed - provider| / max(provider, ε) above this trips. */
export const DEFAULT_DRIFT_THRESHOLD = 0.05;

/** The result of reconciling a computed cost against a provider-reported cost. */
export interface CostReconciliation {
  computedCostUsd: number;
  /** The SDK-reported cost (Anthropic total_cost_usd, Pi usage.cost.total); null when none reported. */
  providerCostUsd: number | null;
  /** True iff a provider cost is present AND the relative gap exceeds the threshold. */
  costDrift: boolean;
}

/**
 * Reconcile a COMPUTED cost against the PROVIDER-reported cost (deliverable A3). Sets the drift flag
 * when the relative difference exceeds `threshold` (default 5%). When the provider reports NO cost
 * (OpenAI — has no provider cost field), there is nothing to reconcile: `providerCostUsd` stays null
 * and `costDrift` is false (we never fabricate a provider cost). A non-zero computed vs a zero
 * provider (or vice-versa) is treated as drift (the gap is the full magnitude).
 */
export function reconcileCost(
  computedCostUsd: number,
  providerCostUsd: number | null | undefined,
  threshold: number = DEFAULT_DRIFT_THRESHOLD,
): CostReconciliation {
  if (providerCostUsd === null || providerCostUsd === undefined) {
    return { computedCostUsd, providerCostUsd: null, costDrift: false };
  }
  const diff = Math.abs(computedCostUsd - providerCostUsd);
  // Relative gap against the larger magnitude (avoids div-by-zero + a tiny absolute gap on tiny costs
  // tripping a false drift). If BOTH are ~0 there is no drift.
  const denom = Math.max(Math.abs(providerCostUsd), Math.abs(computedCostUsd));
  const costDrift = denom > 0 ? diff / denom > threshold : false;
  return { computedCostUsd, providerCostUsd, costDrift };
}
