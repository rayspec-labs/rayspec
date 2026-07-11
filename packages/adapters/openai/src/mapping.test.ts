/**
 * Wire-mapping pin for the OpenAI adapter's neutral->SDK conversions.
 *
 * Pins the SHAPES we send to @openai/agents 0.11.8 so an SDK bump that moves the wire contract
 * fails loudly (the neutral types must not move on SDK churn). It does NOT call the network — it
 * asserts the structural mapping only. The full deriveConversation + per-step-journal + replay
 * suites (derive.test.ts, adapter.integration.test.ts) run against a REAL captured fixture; the
 * comprehensive three-tier contract suite is a separate follow-on.
 *
 * De-tautologized: the tool assertion now drives the SDK `tool()` factory
 * with a neutral ToolSpec's actual fields and asserts the SDK normalized them — not a hand-built
 * literal compared to itself.
 */

import type { ToolSpec } from '@rayspec/core';
import { tool } from '@openai/agents';
import { describe, expect, it } from 'vitest';
import { toOutputType } from './index.js';

describe('OpenAI adapter wire mapping', () => {
  it('maps a neutral outputSchema -> JsonSchemaDefinition shape via the REAL projection (json_schema, strict)', () => {
    // C5 (de-tautologized): drive the REAL projection the adapter applies in run() (toOutputType),
    // NOT a hand-built literal compared to itself. Flipping strict:true->false in index.ts breaks
    // this assertion.
    const neutral = { name: 'meeting_extraction', schema: { type: 'object', properties: {} } };
    const mapped = toOutputType(neutral);
    expect(mapped).toEqual({
      type: 'json_schema',
      name: 'meeting_extraction',
      strict: true,
      schema: { type: 'object', properties: {} },
    });
    // Pin strict EXPLICITLY: the SDK enforces strict structured output only when this is true.
    expect(mapped.strict).toBe(true);
  });

  it('drives the SDK tool() factory from a neutral ToolSpec and asserts the SDK normalized it', () => {
    const neutral: ToolSpec = {
      name: 'lookup',
      description: 'Look something up',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
      },
    };
    const t = tool({
      name: neutral.name,
      description: neutral.description,
      parameters: neutral.parameters as never,
      // The adapter's execute marshals to dispatchTool; here we only pin the wire shape.
      execute: async () => 'ok',
    });
    // The SDK normalizes the tool; assert the identity fields survive the mapping AND that the
    // SDK exposes an `invoke` (the entry the SDK loop calls — the path the adapter routes through).
    expect(t.name).toBe('lookup');
    expect(t.type).toBe('function');
    expect(typeof (t as { invoke?: unknown }).invoke).toBe('function');
  });
});
