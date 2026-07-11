import type {
  AgentRuntimeExecutionInput,
  AgentRuntimeFailureCode,
  AgentRuntimeOutputArtifact,
} from './types.js';

const providerNativeKeyPattern =
  /^(?:adapter_visibility|api_key|api_key_env|backend|body|credential_env|deepgram_request|default_backend|default_model|default_provider|headers|model_policy|native_payload|provider|provider_payload|raw_provider_payload)$/i;
const providerNativeValuePattern =
  /\b(?:deepgram|openai|anthropic|gemini|provider_native|native_payload|provider_payload|raw_provider_payload|credential_env|api_key|default_provider|default_model|model_policy)\b/i;
const promptOrModelKeyPattern = /^(?:prompt|prompt_template|system_prompt|user_prompt|model)$/i;
const promptOrModelValuePattern =
  /\b(?:prompt\s+execution|execute\s+prompt|llm\s+call|agent\s+call)\b/i;
const productOwnedKeyPattern =
  /^(?:code|handler|handler_path|handlers|implementation|module|module_path|route_handler)$/i;
const productOwnedValuePattern =
  /(?:packs\/|\/handlers\/|handlers\/|\.tsx?\b|\.mjs\b|\.cjs\b|\.js\b)/i;

/**
 * Neutrality tripwire for the agent CONTRACT/declaration surface — NOT a content filter over
 * runtime artifact data. By contract the runtime is provider-neutral and product-neutral: it does
 * not import product code or know product storage paths. Accordingly the guard walks only the
 * compiled declaration surface — operation, intent, artifact refs/kinds/schema_refs, the
 * required_output_shape, the acceptance_boundary, and the artifact envelope — and MUST NOT
 * inspect the artifact data payloads (`value`). A real transcript may name a provider and a
 * product may legitimately declare a field named `body`/`code`/`model`; those are data, not a
 * contract leak. Fail-closed is preserved for everything it still checks.
 */
export function detectExecutionInputLeak(
  input: AgentRuntimeExecutionInput,
): AgentRuntimeFailureCode | undefined {
  return walk({
    operation: input.operation,
    intent: input.intent,
    artifact_inputs: input.artifact_inputs.map(declarationOnly),
    artifact_outputs: input.artifact_outputs,
    required_output_shape: input.required_output_shape,
    acceptance_boundary: input.acceptance_boundary,
  });
}

/**
 * Neutrality tripwire for the agent OUTPUT declaration surface. Each output artifact's envelope
 * (ref, kind, schema_ref, materialization_target, and any sibling of `value`) is scanned; the
 * data payload (`value`) is never inspected. See {@link detectExecutionInputLeak} for scope.
 */
export function detectOutputArtifactLeak(
  outputs: AgentRuntimeOutputArtifact[],
): AgentRuntimeFailureCode | undefined {
  return walk(outputs.map(declarationOnly));
}

function declarationOnly<T extends { value: unknown }>(artifact: T): Omit<T, 'value'> {
  const { value: _value, ...declaration } = artifact;
  return declaration;
}

function walk(value: unknown): AgentRuntimeFailureCode | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const leak = walk(item);
      if (leak) return leak;
    }
    return undefined;
  }

  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (providerNativeKeyPattern.test(key)) return 'agent_provider_native_leak';
      if (promptOrModelKeyPattern.test(key)) return 'agent_prompt_or_model_leak';
      if (productOwnedKeyPattern.test(key)) return 'agent_product_owned_path_leak';
      const leak = walk(child);
      if (leak) return leak;
    }
    return undefined;
  }

  if (typeof value !== 'string') return undefined;
  if (providerNativeValuePattern.test(value)) return 'agent_provider_native_leak';
  if (promptOrModelValuePattern.test(value)) return 'agent_prompt_or_model_leak';
  if (productOwnedValuePattern.test(value)) return 'agent_product_owned_path_leak';
  return undefined;
}
