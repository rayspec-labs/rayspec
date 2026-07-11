/**
 * THROWAWAY fixture-capture script.
 *
 * Does ONE real @openai/agents run that exercises a TOOL CALL + multi-turn, and dumps the REAL
 * `result.history`, `result.rawResponses` (per-response usage), and `result.state.usage` into a
 * JSON fixture. The deterministic deriveConversation + per-step-journal tests run against THIS
 * captured shape so they encode the true SDK contract (not an imagined one).
 *
 * Run locally with a key:  OPENAI_API_KEY=... pnpm tsx packages/adapters/openai/scripts/capture-fixture.mts
 * NOT part of CI (CI does not pass OPENAI_API_KEY). The committed fixture is the test source.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, run, setDefaultOpenAIKey, tool } from '@openai/agents';

const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error('OPENAI_API_KEY required to capture a real fixture');
  process.exit(1);
}
setDefaultOpenAIKey(key);

const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  } as never,
  // Capture-only handler (the REAL adapter holds NO handler — this is the throwaway capture).
  execute: async (args: unknown) => {
    const { city } = args as { city: string };
    return JSON.stringify({ city, tempC: 18, condition: 'cloudy' });
  },
});

const agent = new Agent({
  name: 'weather-agent',
  instructions: 'You are a concise assistant. Use the get_weather tool when asked about weather.',
  model: 'gpt-4.1-mini',
  tools: [weatherTool],
});

const result = await run(agent, 'What is the weather in Berlin? Answer in one short sentence.', {
  stream: false,
  maxTurns: 8,
});

// rawResponses carries per-response usage; serialize the fields the adapter reads.
const rawResponses = (result.rawResponses ?? []).map((r) => ({
  responseId: r.responseId ?? null,
  requestId: r.requestId ?? null,
  usage: {
    requests: r.usage?.requests,
    inputTokens: r.usage?.inputTokens,
    outputTokens: r.usage?.outputTokens,
    totalTokens: r.usage?.totalTokens,
    inputTokensDetails: r.usage?.inputTokensDetails,
    outputTokensDetails: r.usage?.outputTokensDetails,
  },
}));

const fixture = {
  capturedAt: new Date().toISOString(),
  sdk: '@openai/agents@0.11.8',
  model: 'gpt-4.1-mini',
  input: 'What is the weather in Berlin? Answer in one short sentence.',
  instructions: agent.instructions,
  finalOutput: result.finalOutput,
  // The REAL final history (AgentInputItem[]): the deriveConversation test source.
  history: result.history,
  // Per-response usage (the per-step-journal test source).
  rawResponses,
  // Aggregate usage (the RunResult.usage source).
  stateUsage: {
    requests: result.state.usage?.requests,
    inputTokens: result.state.usage?.inputTokens,
    outputTokens: result.state.usage?.outputTokens,
    totalTokens: result.state.usage?.totalTokens,
    inputTokensDetails: result.state.usage?.inputTokensDetails,
    outputTokensDetails: result.state.usage?.outputTokensDetails,
  },
};

const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  '__fixtures__',
  'openai-tool-run.json',
);
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote fixture: ${outPath}`);
console.log(`history items: ${result.history.length}, rawResponses: ${rawResponses.length}`);
console.log(`finalOutput: ${JSON.stringify(result.finalOutput)}`);
