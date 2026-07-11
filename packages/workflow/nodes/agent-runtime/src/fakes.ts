import type { AgentRuntimeOutputArtifact, FakeAgentHandler } from './types.js';

/**
 * Deterministic, product-neutral fake agent-extraction handler for tests/gates. It emits a generic
 * note-extraction shape (headline/detail/output_language + item/pointer/query/label arrays + mentions)
 * onto the step's FIRST declared output artifact, drawing its inputs from the neutral open-core STT
 * capability refs (`stt.transcript`, `stt.transcript_span`). It knows no product: any product that
 * declares a single extraction output over this neutral shape gets a deterministic materialization here.
 */
export const fakeAgentExtractionHandler: FakeAgentHandler = (input) => {
  const output = input.artifact_outputs[0];
  if (!output) return [];

  const transcript = input.artifact_inputs.find((artifact) => artifact.ref === 'stt.transcript');
  const spans = input.artifact_inputs.find((artifact) => artifact.ref === 'stt.transcript_span');

  return [
    {
      ...output,
      value: {
        headline: 'Deterministic extraction digest',
        detail: `Fake extraction from ${String(transcript?.ref ?? 'missing transcript')}.`,
        output_language: 'en',
        items: [
          {
            text: 'Use provider-neutral agent runtime contracts before live execution.',
            evidence: ['span-1'],
          },
        ],
        pointers: [
          {
            text: 'Validate typed artifact refs through downstream nodes.',
            evidence: ['span-2'],
          },
        ],
        queries: [],
        labels: [],
        mentions: [
          {
            name: String(spans?.ref ?? 'missing spans'),
            evidence: [],
          },
        ],
      },
    },
  ] satisfies AgentRuntimeOutputArtifact[];
};
