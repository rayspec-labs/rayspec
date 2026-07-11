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
import { AgentSpecConfig, RaySpec, RouteAction, ToolSpecConfig } from './grammar.js';

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
