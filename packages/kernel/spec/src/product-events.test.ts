/**
 * The shared trigger-event normalization — unit pins for the ONE source.
 * The cross-package single-source/behavior-parity invariant is pinned in
 * `@rayspec/product-yaml-workflow-bridge`'s `product-bridge-parity.test.ts`; these are the local
 * semantics: the audio alias maps EXACTLY (not by capability or event alone), everything else is the
 * default `${capability}.${event}` join.
 */
import { describe, expect, it } from 'vitest';
import { normalizeProductTriggerEvent, PRODUCT_TRIGGER_EVENT_ALIASES } from './product-events.js';

describe('normalizeProductTriggerEvent (the single source)', () => {
  it('normalizes the audio alias pair to its shipped canonical id (live run identity)', () => {
    expect(normalizeProductTriggerEvent('audio_input', 'session_finalized')).toBe(
      'audio_input.finalized_session',
    );
  });

  it('joins every non-aliased pair as <capability>.<event>', () => {
    expect(normalizeProductTriggerEvent('ticket_input', 'ticket_received')).toBe(
      'ticket_input.ticket_received',
    );
  });

  it('the alias matches the exact PAIR — capability alone or event alone does NOT alias', () => {
    // Same capability, different event → default join (no accidental audio blanket-aliasing).
    expect(normalizeProductTriggerEvent('audio_input', 'other_event')).toBe(
      'audio_input.other_event',
    );
    // Same event name on a different capability → default join.
    expect(normalizeProductTriggerEvent('video_input', 'session_finalized')).toBe(
      'video_input.session_finalized',
    );
  });

  it('the alias table is closed: exactly the one shipped audio entry', () => {
    // A new capability must use the default join — an alias exists only to honor an ALREADY-SHIPPED
    // canonical id. Growing this table is a deliberate act this pin forces into review.
    expect(PRODUCT_TRIGGER_EVENT_ALIASES).toEqual([
      {
        capability: 'audio_input',
        event: 'session_finalized',
        canonical: 'audio_input.finalized_session',
      },
    ]);
  });
});
