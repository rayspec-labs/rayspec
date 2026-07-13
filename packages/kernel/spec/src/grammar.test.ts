/**
 * Grammar shape-PIN tripwires (neutral-churn honesty).
 *
 * The hybrid wrap (`agents`/`tooling` wrapping `core.AgentSpec`/`ToolSpec`) surfaces a neutral
 * REMOVAL/RENAME loudly (a `.omit()`/`.extend()` on a missing key is a COMPILE error), but a
 * neutral ADDITION is absorbed SILENTLY into the grammar. These tests pin the EXACT wrapped
 * key-sets, so a neutral field addition (or an accidental wrap-field add) FAILS this test and
 * forces a DELIBERATE spec-version-bump decision — that is what makes "neutral churn = a deliberate
 * bump" true, not just a docstring claim.
 *
 * When you intentionally evolve the wrap, update these pinned sets in the SAME commit that bumps
 * the spec version — the test failure is the prompt to make that call consciously.
 */
import { describe, expect, it } from 'vitest';
import {
  AgentSpecConfig,
  FrontendSpec,
  RaySpec,
  RouteAction,
  StoreColumn,
  StoreForeignKey,
  StoreSpec,
  ToolSpecConfig,
} from './grammar.js';

describe('grammar shape pins (neutral-churn tripwire)', () => {
  it('RaySpec has exactly the expected top-level sections (extensions added)', () => {
    // Pinning the top-level shape makes ADDING a section a DELIBERATE act: `extensions` was added
    // (the optional extension-pack section). A future top-level addition fails this and forces a
    // conscious decision (additive/optional ⇒ no spec-version bump; a breaking change ⇒ a bump).
    expect(Object.keys(RaySpec.shape).sort()).toEqual(
      [
        'agents',
        'api',
        'deployment',
        'extensions',
        'frontend',
        'handlers',
        'metadata',
        'stores',
        'tooling',
        'triggers',
        'version',
      ].sort(),
    );
  });

  it('RouteAction is a closed union over kind including the stream member', () => {
    // The discriminated union's options expose their literal `kind`. Pinning the set makes adding a
    // route kind deliberate — `stream` was added (alongside store/agent/handler).
    const kinds = RouteAction.options.map((opt) => opt.shape.kind.value).sort();
    expect(kinds).toEqual(['agent', 'handler', 'store', 'stream'].sort());
  });

  it('AgentSpecConfig has exactly the expected keys', () => {
    // core.AgentSpec minus {input, tools} (omitted) plus the wrap fields {id, backend, tools,
    // requireNativeStructuredOutput}. A neutral addition to AgentSpec would appear here.
    expect(Object.keys(AgentSpecConfig.shape).sort()).toEqual(
      [
        'backend',
        'id',
        'instructions',
        'maxTurns',
        'model',
        'name',
        'outputSchema',
        'requireNativeStructuredOutput',
        'tools',
      ].sort(),
    );
  });

  it('ToolSpecConfig has exactly the expected keys', () => {
    // core.ToolSpec {name, description, parameters} plus the wrap fields {id, handler, idempotent,
    // timeoutMs, outputSchema}. A neutral addition to ToolSpec would appear here.
    expect(Object.keys(ToolSpecConfig.shape).sort()).toEqual(
      [
        'description',
        'handler',
        'id',
        'idempotent',
        'name',
        'outputSchema',
        'parameters',
        'timeoutMs',
      ].sort(),
    );
  });
});

describe('FrontendSpec (static frontend mount)', () => {
  it('parses a valid mount', () => {
    const res = FrontendSpec.safeParse({ route: '/', dir: 'web/dist', spa: true });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data).toEqual({ route: '/', dir: 'web/dist', spa: true });
    }
  });

  it('defaults spa to false when omitted', () => {
    const res = FrontendSpec.safeParse({ route: '/app', dir: 'ui' });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.spa).toBe(false);
  });

  it('rejects a route without a leading slash', () => {
    expect(FrontendSpec.safeParse({ route: 'app', dir: 'ui' }).success).toBe(false);
  });

  it('rejects an empty dir', () => {
    expect(FrontendSpec.safeParse({ route: '/', dir: '' }).success).toBe(false);
  });

  it('rejects an unknown key (strict)', () => {
    expect(FrontendSpec.safeParse({ route: '/', dir: 'ui', extra: true }).success).toBe(false);
  });

  it('accepts a spec carrying a frontend list, and omits it when absent (optional)', () => {
    const withFrontend = RaySpec.safeParse({
      version: '1.0',
      metadata: { name: 'm' },
      frontend: [{ route: '/', dir: 'web/dist' }],
    });
    expect(withFrontend.success).toBe(true);
    if (withFrontend.success) {
      expect(withFrontend.data.frontend).toEqual([{ route: '/', dir: 'web/dist', spa: false }]);
    }
    // Absent ⇒ the key is not injected (keeps a frontend-less spec byte-identical).
    const withoutFrontend = RaySpec.safeParse({ version: '1.0', metadata: { name: 'm' } });
    expect(withoutFrontend.success).toBe(true);
    if (withoutFrontend.success) expect('frontend' in withoutFrontend.data).toBe(false);
  });
});

describe('StoreColumn.enum (optional value whitelist)', () => {
  it('parses a column carrying an enum whitelist', () => {
    const res = StoreColumn.safeParse({ name: 'status', type: 'text', enum: ['open', 'closed'] });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.enum).toEqual(['open', 'closed']);
  });

  it('omits enum when absent (not injected — keeps an enum-less column byte-identical)', () => {
    const res = StoreColumn.safeParse({ name: 'title', type: 'text' });
    expect(res.success).toBe(true);
    if (res.success) expect('enum' in res.data).toBe(false);
  });

  it('rejects an empty enum array (min 1)', () => {
    expect(StoreColumn.safeParse({ name: 'status', type: 'text', enum: [] }).success).toBe(false);
  });

  it('rejects an empty-string enum member (element min 1) — pins the whitelist to non-empty values', () => {
    expect(
      StoreColumn.safeParse({ name: 'status', type: 'text', enum: ['open', ''] }).success,
    ).toBe(false);
  });
});

describe('StoreForeignKey.referencesColumn (FK to a unique column)', () => {
  it('parses an FK targeting a named column of the referenced store', () => {
    const res = StoreForeignKey.safeParse({
      column: 'meeting_slug',
      references: 'meetings',
      referencesColumn: 'slug',
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.referencesColumn).toBe('slug');
  });

  it('omits referencesColumn when absent (not injected — keeps an id-targeted FK byte-identical)', () => {
    const res = StoreForeignKey.safeParse({ column: 'meeting_id', references: 'meetings' });
    expect(res.success).toBe(true);
    if (res.success) expect('referencesColumn' in res.data).toBe(false);
  });

  it('rejects a metacharacter identifier', () => {
    expect(
      StoreForeignKey.safeParse({ column: 'c', references: 'r', referencesColumn: 'slug!' })
        .success,
    ).toBe(false);
  });
});

describe('StoreSpec.softDelete (opt-in soft delete)', () => {
  it('parses a store opting into soft delete', () => {
    const res = StoreSpec.safeParse({
      name: 'notes',
      columns: [{ name: 'body', type: 'text' }],
      softDelete: true,
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.softDelete).toBe(true);
  });

  it('omits softDelete when absent (not injected — keeps a hard-delete store byte-identical)', () => {
    const res = StoreSpec.safeParse({ name: 'notes', columns: [{ name: 'body', type: 'text' }] });
    expect(res.success).toBe(true);
    if (res.success) expect('softDelete' in res.data).toBe(false);
  });

  it('rejects a non-boolean softDelete', () => {
    expect(
      StoreSpec.safeParse({
        name: 'notes',
        columns: [{ name: 'body', type: 'text' }],
        softDelete: 'yes',
      }).success,
    ).toBe(false);
  });
});
