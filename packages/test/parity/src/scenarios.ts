/**
 * The SHARED parity scenarios — the SAME neutral AgentSpec (instructions/input/tools/outputSchema)
 * run on every backend. Only `spec.model` differs per backend (claude vs gpt model ids), which is a
 * backend-by-definition difference, not a shape difference. Each scenario exercises one exit-gate
 * surface: (1) multi-turn + tool-call, (2) no-output, (3) error, (4) structured-output — the last is
 * the canonical native-vs-emulated case (openai/anthropic NATIVE, pi EMULATED).
 */
import type { AgentSpec, NeutralTool } from '@rayspec/core';

export interface Scenario {
  name: string;
  spec: AgentSpec;
  tools?: NeutralTool[];
}

/** A deterministic neutral tool used by the tool-call scenario (idempotent lookup). */
export function weatherTool(): NeutralTool {
  return {
    spec: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false,
      },
    },
    handler: (args: unknown) => {
      const { city } = (args ?? {}) as { city?: string };
      return { city: city ?? 'unknown', tempC: 18, condition: 'cloudy' };
    },
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    timeoutMs: 5000,
    idempotent: true,
  };
}

/** Build the four parity scenarios for a given backend model id. */
export function scenariosForModel(model: string): Scenario[] {
  const base = {
    instructions:
      'You are a concise assistant. You MUST use the get_weather tool to answer any weather ' +
      'question — never answer from your own knowledge. Call the tool, then give a one-sentence answer.',
    model,
    maxTurns: 8,
  };
  return [
    {
      // (1) MULTI-TURN + TOOL CALL: the model calls get_weather, gets the result, then answers.
      name: 'multi-turn-tool',
      spec: {
        ...base,
        name: 'weather-agent',
        input: 'What is the weather in Berlin? Answer in one short sentence.',
        tools: [weatherTool().spec],
      },
      tools: [weatherTool()],
    },
    {
      // (2) NO-OUTPUT: a plain question, no tools, no structured output (output stays null).
      name: 'no-output',
      spec: {
        ...base,
        name: 'plain-agent',
        input: 'Say the single word: ok.',
        tools: [],
      },
    },
    {
      // (3) ERROR: an unsatisfiable model id forces an error-path RunResult (identical shape).
      // For a STATUS-carrying error (e.g. openai's 400/429/5xx), the recorded
      // `errorClass` is derived from the LIVE error OBJECT (its `.status`) at capture time — it is NOT
      // re-derivable from the persisted `error` STRING alone (the string has no structural status). So
      // do NOT "verify" a recorded errorClass by re-running classifyUpstreamError on the stored string;
      // re-capture against the live SDK error instead. (openai → upstream_4xx via .status:400; the
      // anthropic/pi error strings carry no rate-limit/5xx keyword → internal, by design.)
      name: 'error',
      spec: {
        ...base,
        name: 'error-agent',
        model: '__nonexistent-model__',
        input: 'This run must fail at the model layer.',
        tools: [],
      },
    },
    {
      // (4) STRUCTURED OUTPUT — the canonical native-vs-emulated case. openai (outputType) +
      // anthropic (outputFormat) produce it NATIVELY; pi has NO native structured output and EMULATES
      // it via instructions+parse (the lone documented capability exception). We DELIBERATELY do NOT
      // set requireNativeStructuredOutput, so Pi's emulated path is allowed — proving the abstraction
      // expresses the SAME `output` shape on ALL three without collapsing to a lowest-common-denominator
      // (Pi's emulation lives behind the capability descriptor, not in a weakened neutral type).
      name: 'structured-output',
      spec: {
        ...base,
        name: 'structured-agent',
        instructions:
          'You extract structured data. Return the city and a short condition for the requested place.',
        input: 'Give the weather for Berlin: a city name and a one-word condition.',
        tools: [],
        outputSchema: {
          name: 'weather_report',
          schema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              condition: { type: 'string' },
            },
            required: ['city', 'condition'],
            additionalProperties: false,
          },
        },
      },
    },
  ];
}
