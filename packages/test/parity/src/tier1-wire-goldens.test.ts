/**
 * TIER 1 — wire-mapping GOLDENS (three-tier SDK-churn defense).
 *
 * For EACH adapter, pin the EXACT neutral → SDK-wire projection with a golden so an SDK bump that
 * moves the wire contract fails LOUDLY (the neutral types must not move on SDK churn). These are NOT
 * tautologies: each drives the REAL exported projection the adapter applies in run() and asserts the
 * concrete wire shape — FLIPPING A FIELD in the projection breaks the golden. No network.
 *
 *   - OpenAI:    toOutputType (neutral outputSchema → JsonSchemaDefinition {type,name,strict,schema})
 *                + the SDK tool() factory normalization (name/type/invoke).
 *   - Anthropic: jsonSchemaToZodShape (neutral JSON-Schema parameters → the Zod RAW SHAPE the
 *                in-proc MCP tool() requires) — per-property type mapping + required/optional.
 *   - Pi:        piToolAllowlist + piJsonInstruction (the exported builders run() USES) — the neutral
 *                tool spec → the model-facing active-set tool-name allowlist + the EMULATED
 *                structured-output instruction projection (Pi has no native outputType). Flipping
 *                either projection in pi/src/index.ts breaks the golden (no longer a tautology).
 *
 * Tier 1 pins the OUTBOUND wire; Tier 2 (tier2-recorded-replay) pins the INBOUND derivation; Tier 3
 * (parity.test.ts + version-bump.test.ts) is the cross-backend gate + the re-record rule.
 */
import { jsonSchemaToZodShape, jsonSchemaToZodType } from '@rayspec/adapter-anthropic';
import {
  buildCuratedCodexEnv,
  CODEX_FORBIDDEN_ENV_KEYS,
  jsonSchemaToZodShape as codexJsonSchemaToZodShape,
  jsonSchemaToZodType as codexJsonSchemaToZodType,
  MCP_TOOLS_APPROVAL_MODE,
} from '@rayspec/adapter-codex';
import { toOutputType } from '@rayspec/adapter-openai';
import { piJsonInstruction, piToolAllowlist, piToolParameters } from '@rayspec/adapter-pi';
import type { AgentSpec } from '@rayspec/core';
import { tool as openaiTool } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { weatherTool } from './scenarios.js';

describe('Tier 1 golden — OpenAI: neutral outputSchema → SDK JsonSchemaDefinition', () => {
  it('projects to the EXACT {type:"json_schema", name, strict:true, schema} wire shape', () => {
    const neutral = {
      name: 'weather_report',
      schema: {
        type: 'object',
        properties: { city: { type: 'string' }, condition: { type: 'string' } },
        required: ['city', 'condition'],
        additionalProperties: false,
      },
    };
    // GOLDEN: the precise wire object the adapter sends as `outputType`. Flipping strict→false in the
    // adapter, or renaming `type`, breaks this exact-equality assertion.
    expect(toOutputType(neutral)).toEqual({
      type: 'json_schema',
      name: 'weather_report',
      strict: true,
      schema: {
        type: 'object',
        properties: { city: { type: 'string' }, condition: { type: 'string' } },
        required: ['city', 'condition'],
        additionalProperties: false,
      },
    });
  });

  it('drives the SDK tool() factory from a neutral ToolSpec and pins the normalized identity', () => {
    const spec = weatherTool().spec;
    const t = openaiTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as never,
      execute: async () => 'ok',
    });
    // GOLDEN: the SDK preserves the tool identity + exposes the `invoke` entry the adapter routes
    // through. An SDK that renamed `invoke` or dropped the `function` type breaks here.
    expect(t.name).toBe('get_weather');
    expect(t.type).toBe('function');
    expect(typeof (t as { invoke?: unknown }).invoke).toBe('function');
  });
});

describe('Tier 1 golden — Anthropic: neutral JSON-Schema params → SDK Zod RAW SHAPE', () => {
  it('maps each top-level property to its Zod type by JSON-Schema type + honors required/optional', () => {
    const params = {
      type: 'object',
      properties: {
        city: { type: 'string' },
        days: { type: 'integer' },
        verbose: { type: 'boolean' },
        tags: { type: 'array' },
        meta: { type: 'object' },
      },
      required: ['city', 'days'],
      additionalProperties: false,
    };
    const { shape, usedArgsFallback } = jsonSchemaToZodShape(params);
    // A real projected shape (NOT the single-args fallback): flipping the per-property type mapping or
    // the required-set logic in the adapter breaks these golden assertions.
    expect(usedArgsFallback).toBe(false);
    expect(Object.keys(shape).sort()).toEqual(['city', 'days', 'meta', 'tags', 'verbose']);
    // Required fields are NOT optional; non-required fields ARE optional (the model sees the difference).
    expect(shape.city?.isOptional?.()).toBe(false);
    expect(shape.days?.isOptional?.()).toBe(false);
    expect(shape.verbose?.isOptional?.()).toBe(true);
    expect(shape.tags?.isOptional?.()).toBe(true);
    expect(shape.meta?.isOptional?.()).toBe(true);
    // The Zod kind per property matches the JSON-Schema type (string→ZodString, integer→ZodNumber, …).
    expect(zodKind(shape.city)).toBe('string');
    expect(zodKind(shape.days)).toBe('number'); // integer → z.number()
    expect(zodKind(shape.verbose)).toBe('boolean');
    expect(zodKind(shape.tags)).toBe('array');
  });

  it('a NON-object / unschemaable spec falls back to the single {args} passthrough shape', () => {
    const { shape, usedArgsFallback } = jsonSchemaToZodShape({ type: 'string' } as never);
    expect(usedArgsFallback).toBe(true);
    expect(Object.keys(shape)).toEqual(['args']);
  });

  // The projection is a FAITHFUL RECURSIVE converter (was shallow: array→array(unknown),
  // object→record(unknown)). The SDK's in-proc MCP validate-and-repair (safeParseAsync) validates the
  // model's args against THIS schema BEFORE our handler, so the deep shape is what makes a weak model's
  // malformed NESTED arg get rejected at the model boundary (→ repair loop) instead of churning to
  // MaxTurns. These goldens FAIL if the converter reverts to shallow.
  it('RECURSES array.items into z.array(<itemSchema>) — not z.array(z.unknown())', () => {
    const arrSchema = jsonSchemaToZodType({
      type: 'array',
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, owner: { type: 'string' } },
        required: ['description'],
      },
    });
    expect(zodKind(arrSchema)).toBe('array');
    // The DEEP proof / fail-the-shallow-fix: a missing nested required field and a wholly-wrong element
    // type are REJECTED — a shallow z.array(z.unknown()) would ACCEPT both of these (the regression we
    // guard against). The valid-item assertion in the middle holds under either shape (it pins that the
    // deep schema still accepts a well-formed item — not a fail-the-fix, but a no-false-positive guard).
    expect(arrSchema.safeParse([{ owner: 'a' }]).success).toBe(false); // missing `description`
    expect(arrSchema.safeParse([{ description: 'do x', owner: 'a' }]).success).toBe(true);
    expect(arrSchema.safeParse(['not-an-object']).success).toBe(false);
  });

  it('RECURSES nested object.properties into z.object({...}) honoring nested required', () => {
    const objSchema = jsonSchemaToZodType({
      type: 'object',
      properties: {
        title: { type: 'string' },
        action_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              owner: { type: 'string' },
              due_raw: { type: 'string' },
            },
            required: ['description'],
          },
        },
      },
      required: ['title', 'action_items'],
    });
    expect(zodKind(objSchema)).toBe('object');
    // Valid deep object passes; a malformed nested action_items entry (missing `description`) FAILS;
    // an empty object (missing top-level required) FAILS. The over-rejection guard: an UNDECLARED extra
    // key is STRIPPED (z.object default), NOT rejected — so the projection is never stricter than the
    // neutral contract / dispatchTool.
    expect(
      objSchema.safeParse({ title: 'Sync', action_items: [{ description: 'x', owner: 'a' }] })
        .success,
    ).toBe(true);
    expect(objSchema.safeParse({ title: 'Sync', action_items: [{ owner: 'a' }] }).success).toBe(
      false,
    );
    expect(objSchema.safeParse({}).success).toBe(false);
    // Over-rejection guard (SUBSET, never stricter): an extra undeclared key is accepted+stripped.
    const withExtra = objSchema.safeParse({
      title: 'Sync',
      action_items: [{ description: 'x' }],
      stray: 'extra',
    });
    expect(withExtra.success).toBe(true);
    expect((withExtra as { data?: Record<string, unknown> }).data?.stray).toBeUndefined();
  });

  it('carries enum (z.enum) and integer (z.number().refine(Number.isInteger)) faithfully', () => {
    const enumSchema = jsonSchemaToZodType({ type: 'string', enum: ['low', 'med', 'high'] });
    expect(enumSchema.safeParse('high').success).toBe(true);
    expect(enumSchema.safeParse('bogus').success).toBe(false);
    const intSchema = jsonSchemaToZodType({ type: 'integer' });
    expect(zodKind(intSchema)).toBe('number'); // integer → z.number().refine(...)
    expect(intSchema.safeParse(3).success).toBe(true);
    expect(intSchema.safeParse(3.5).success).toBe(false); // rejects a non-integer
    // A large integer (2^53, above the JS safe-int range) that
    // dispatchTool's ajv accepts is ACCEPTED here too — `z.number().int()` would have OVER-rejected it
    // (the subset invariant). 2^53 = 9007199254740992 is an exact float (no precision loss).
    expect(intSchema.safeParse(9007199254740992).success).toBe(true);
  });

  it('an unschemaable nested node maps to z.unknown() (accept-anything — looser than dispatchTool)', () => {
    // No `type` and no enum/const → accept anything (dispatchTool stays the authoritative gate).
    const anySchema = jsonSchemaToZodType({ description: 'free-form' });
    expect(anySchema.safeParse('anything').success).toBe(true);
    expect(anySchema.safeParse({ nested: [1, 2] }).success).toBe(true);
  });
});

describe('Tier 1 golden — Pi: neutral tool name allowlist + emulated structured-output instruction', () => {
  // Build a REAL AgentSpec and drive the EXPORTED Pi projection builders the adapter's run() actually
  // uses (piToolAllowlist / piJsonInstruction — the single source of truth). NOT a re-implementation:
  // flipping the allowlist or the instruction wording in pi/src/index.ts breaks THESE assertions.
  const outputSchema = {
    type: 'object',
    properties: { city: { type: 'string' }, condition: { type: 'string' } },
    required: ['city', 'condition'],
    additionalProperties: false,
  };
  const specWith = (over: Partial<AgentSpec>): AgentSpec => ({
    name: 'pi-golden',
    instructions: 'i',
    model: 'gpt-4.1-mini',
    input: 'in',
    tools: [],
    maxTurns: 8,
    ...over,
  });

  it('piToolAllowlist projects EXACTLY the neutral tool names (the active-set restrictor)', () => {
    const spec = specWith({
      tools: [weatherTool().spec, { ...weatherTool().spec, name: 'lookup' }],
    });
    // GOLDEN: the EXACT active-set allowlist run() passes to createAgentSession. Reordering, renaming,
    // or injecting a built-in tool name in the real projection breaks this exact-equality assertion.
    expect(piToolAllowlist(spec)).toEqual(['get_weather', 'lookup']);
  });

  it('piToolAllowlist is empty when the spec declares no tools (run() falls back to noTools:all)', () => {
    expect(piToolAllowlist(specWith({ tools: [] }))).toEqual([]);
  });

  it('piJsonInstruction embeds the JSON-Schema verbatim (Pi has no native outputType)', () => {
    const spec = specWith({ outputSchema: { name: 'weather_report', schema: outputSchema } });
    // GOLDEN: the EXACT emulated structured-output instruction run() appends to the prompt. Dropping
    // the schema, or changing the "ONLY a single JSON object" wording in the adapter, breaks this.
    const jsonInstruction = piJsonInstruction(spec);
    expect(jsonInstruction).toContain('ONLY a single JSON object');
    expect(jsonInstruction).toContain(JSON.stringify(outputSchema));
    // The schema's required fields are carried verbatim into the instruction (the model is told them).
    expect(jsonInstruction).toContain('"required":["city","condition"]');
  });

  it('piJsonInstruction is empty when the spec demands no structured output', () => {
    expect(piJsonInstruction(specWith({}))).toBe('');
  });

  // piToolParameters passes the FAITHFUL neutral JSON-Schema through verbatim (via
  // Type.Unsafe) — was Type.Object({}, { additionalProperties: true }) (an EMPTY accept-all schema, so
  // pi-agent-core's validateToolArguments could never reject a malformed arg). The model-facing TSchema
  // run() sends to defineTool IS this — flipping it back to the empty object breaks the golden.
  it('piToolParameters carries the neutral JSON-Schema VERBATIM (nested items + required), NOT {additionalProperties:true}', () => {
    const params = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        action_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { description: { type: 'string' }, owner: { type: 'string' } },
            required: ['description'],
            additionalProperties: false,
          },
        },
        priority: { type: 'string', enum: ['low', 'high'] },
      },
      required: ['title', 'action_items'],
      additionalProperties: false,
    };
    const ts = piToolParameters({ name: 't', description: 'd', parameters: params });
    // GOLDEN: the enumerable JSON-Schema keys are the NEUTRAL schema verbatim (Type.Unsafe only stamps a
    // non-enumerable `~unsafe` marker; the JSON.stringify is byte-identical to the neutral parameters).
    expect(JSON.parse(JSON.stringify(ts))).toEqual(params);
    // It is NOT the OLD empty accept-all schema (the regression we are guarding against).
    expect((ts as { properties?: unknown }).properties).toBeDefined();
    expect((ts as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
});

describe('Tier 1 golden — Codex: the curated child env (mis-billing guard) + the MCP approval mode', () => {
  it('buildCuratedCodexEnv STRIPS api keys + base urls; carries HOME/PATH/LANG + the MCP token (the structural guard)', () => {
    const source = {
      HOME: '/home/u',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      OPENAI_API_KEY: 'sk-STRAY',
      CODEX_API_KEY: 'sk-STRAY2',
      OPENAI_BASE_URL: 'https://evil.example',
      CODEX_BASE_URL: 'https://evil2.example',
      AWS_SECRET_ACCESS_KEY: 'leakme',
    } as unknown as NodeJS.ProcessEnv;
    // GOLDEN: the EXACT curated env the adapter passes `new Codex({ env })`. The forbidden keys
    // (OPENAI_API_KEY/CODEX_API_KEY/*_BASE_URL) NEVER appear — flipping the allowlist to a denylist (or
    // adding a forbidden key) in the adapter breaks this exact-equality. An arbitrary ambient secret is
    // NOT copied (allowlist, not passthrough). The per-run MCP bearer token is injected.
    expect(buildCuratedCodexEnv(source, 'tok-xyz')).toEqual({
      HOME: '/home/u',
      PATH: '/usr/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: '/tmp',
      RAYSPEC_MCP_TOKEN: 'tok-xyz',
    });
    // Belt-and-suspenders: NONE of the forbidden keys leaked (the negative golden).
    const env = buildCuratedCodexEnv(source, 'tok-xyz');
    for (const k of CODEX_FORBIDDEN_ENV_KEYS) expect(env[k]).toBeUndefined();
  });

  it('the MCP per-server config uses default_tools_approval_mode "approve" (else codex cancels the call)', () => {
    // GOLDEN: the codex MCP auto-approval mode is `approve` — verified live: without it, codex exec
    // CANCELS the tool call. Flipping it to 'auto'/'prompt' in the adapter breaks this.
    expect(MCP_TOOLS_APPROVAL_MODE).toBe('approve');
  });

  it("codex's neutral JSON-Schema params → the Zod RAW SHAPE for registerTool() (per-property type + required)", () => {
    const params = {
      type: 'object',
      properties: {
        city: { type: 'string' },
        days: { type: 'integer' },
        verbose: { type: 'boolean' },
      },
      required: ['city'],
      additionalProperties: false,
    };
    const { shape, usedArgsFallback } = codexJsonSchemaToZodShape(params);
    expect(usedArgsFallback).toBe(false);
    expect(Object.keys(shape).sort()).toEqual(['city', 'days', 'verbose']);
    expect(shape.city?.isOptional?.()).toBe(false); // required
    expect(shape.days?.isOptional?.()).toBe(true);
    expect(zodKind(shape.city)).toBe('string');
    expect(zodKind(shape.days)).toBe('number'); // integer → z.number().refine(...)
    expect(zodKind(shape.verbose)).toBe('boolean');
  });

  // Codex's projection is a FAITHFUL RECURSIVE converter (was shallow: array→
  // array(unknown), object→record(unknown)). The in-proc MCP server validates the model's args against
  // THIS schema with safeParseAsync (doc-first @modelcontextprotocol/sdk@1.24.0, mcp.js:174) BEFORE our
  // handler, so the deep shape is what makes a weak model's malformed NESTED arg get rejected at the
  // model boundary (→ repair loop) instead of churning to MaxTurns. These goldens FAIL if the converter
  // reverts to shallow. Mirrors the anthropic deep-recursion block.
  it('RECURSES array.items into z.array(<itemSchema>) — not z.array(z.unknown())', () => {
    const arrSchema = codexJsonSchemaToZodType({
      type: 'array',
      items: {
        type: 'object',
        properties: { description: { type: 'string' }, owner: { type: 'string' } },
        required: ['description'],
      },
    });
    expect(zodKind(arrSchema)).toBe('array');
    // The DEEP proof / fail-the-shallow-fix: a missing nested required field and a wholly-wrong element
    // type are REJECTED — a shallow z.array(z.unknown()) would ACCEPT both of these (the regression).
    expect(arrSchema.safeParse([{ owner: 'a' }]).success).toBe(false); // missing `description`
    expect(arrSchema.safeParse([{ description: 'do x', owner: 'a' }]).success).toBe(true);
    expect(arrSchema.safeParse(['not-an-object']).success).toBe(false);
  });

  it('RECURSES nested object.properties into z.object({...}) honoring nested required', () => {
    const objSchema = codexJsonSchemaToZodType({
      type: 'object',
      properties: {
        title: { type: 'string' },
        action_items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              owner: { type: 'string' },
              due_raw: { type: 'string' },
            },
            required: ['description'],
          },
        },
      },
      required: ['title', 'action_items'],
    });
    expect(zodKind(objSchema)).toBe('object');
    expect(
      objSchema.safeParse({ title: 'Sync', action_items: [{ description: 'x', owner: 'a' }] })
        .success,
    ).toBe(true);
    expect(objSchema.safeParse({ title: 'Sync', action_items: [{ owner: 'a' }] }).success).toBe(
      false,
    );
    expect(objSchema.safeParse({}).success).toBe(false);
  });

  it('carries enum (z.enum) and integer (z.number().refine(Number.isInteger)) faithfully', () => {
    const enumSchema = codexJsonSchemaToZodType({ type: 'string', enum: ['low', 'med', 'high'] });
    expect(enumSchema.safeParse('high').success).toBe(true);
    expect(enumSchema.safeParse('bogus').success).toBe(false);
    const intSchema = codexJsonSchemaToZodType({ type: 'integer' });
    expect(zodKind(intSchema)).toBe('number'); // integer → z.number().refine(...)
    expect(intSchema.safeParse(3).success).toBe(true);
    expect(intSchema.safeParse(3.5).success).toBe(false); // rejects a non-integer
  });

  it('an unschemaable nested node maps to z.unknown() (accept-anything — looser than dispatchTool)', () => {
    const anySchema = codexJsonSchemaToZodType({ description: 'free-form' });
    expect(anySchema.safeParse('anything').success).toBe(true);
    expect(anySchema.safeParse({ nested: [1, 2] }).success).toBe(true);
  });

  // OVER-REJECTION GUARD: the projected schema must be a SUBSET of
  // the neutral contract — codex-accept ⊇ ajv-accept, NEVER stricter. Two cases dispatchTool's ajv
  // accepts that a careless converter would REJECT: (a) a large integer above the JS safe-int range
  // (the `z.number().int()` hazard on anthropic — refine(Number.isInteger) avoids it),
  // and (b) an UNDECLARED extra key (z.object STRIPS, never rejects — no additionalProperties:false).
  // Reintroducing `z.number().int()` or injecting additionalProperties:false turns this RED.
  it('over-rejection guard: ACCEPTS a large int (>safe-int) AND strips an undeclared extra key (codex-accept ⊇ ajv-accept)', () => {
    // (a) 2^53 = 9007199254740992 (above Number.MAX_SAFE_INTEGER): ajv's {type:'integer'} accepts it;
    // `.int()` would over-reject. An exact float, so no precision loss.
    const intSchema = codexJsonSchemaToZodType({ type: 'integer' });
    expect(intSchema.safeParse(9007199254740992).success).toBe(true);
    // (b) an undeclared extra key is ACCEPTED + STRIPPED (a SUBSET, never stricter) — dispatchTool stays
    // the authoritative gate for additionalProperties.
    const objSchema = codexJsonSchemaToZodType({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
    const r = objSchema.safeParse({ title: 'x', stray_unknown_key: 123 });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).stray_unknown_key).toBeUndefined();
  });
});

/**
 * Best-effort Zod kind tag (def.type across zod versions), UNWRAPPING an optional wrapper so an
 * optional field reports its INNER kind (zod 4 wraps z.string().optional() as `_def.type:'optional'`).
 */
function zodKind(z: unknown): string | undefined {
  let def = (z as { _def?: { typeName?: string; type?: string; innerType?: unknown } } | undefined)
    ?._def;
  // Unwrap an optional/nullable wrapper to its inner type (bounded).
  for (let i = 0; i < 5 && def && (def.type === 'optional' || def.type === 'nullable'); i++) {
    def = (def.innerType as { _def?: typeof def } | undefined)?._def;
  }
  if (!def) return undefined;
  if (typeof def.type === 'string') return def.type;
  if (typeof def.typeName === 'string') return def.typeName.replace(/^Zod/, '').toLowerCase();
  return undefined;
}
