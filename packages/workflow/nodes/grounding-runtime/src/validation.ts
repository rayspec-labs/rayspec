import type { CapabilityInvocationResult, CapabilityNodeHandler } from '@rayspec/foundation';
import type {
  ValidationChecker,
  ValidationCheckInput,
  ValidationCheckNodeOptions,
  ValidationCheckResult,
  ValidationFinding,
} from './types.js';

export const VALIDATION_CHECK_OPERATION = 'validation.check';

export function createValidationCheckNode(
  options: ValidationCheckNodeOptions = {},
): ValidationChecker {
  return options.checker ?? requiredPathValidationChecker;
}

export function createValidationCheckHandler(
  options: ValidationCheckNodeOptions = {},
): CapabilityNodeHandler {
  const checker = createValidationCheckNode(options);
  return async ({ input, step }): Promise<CapabilityInvocationResult> => {
    const result = await checker(input as unknown as ValidationCheckInput);
    if (result.verdict === 'invalid') {
      return {
        status: 'terminal_failure',
        error: {
          code: 'validation_failed',
          message: `Validation node '${step.id}' failed.`,
          retryable: false,
        },
        artifact_refs: [
          {
            id: `${step.id}:validation_result`,
            kind: 'validation.result',
            source_node_id: step.id,
            value: result,
          },
        ],
      };
    }

    return {
      status: 'completed',
      artifact_refs: [
        {
          id: `${step.id}:validation_result`,
          kind: 'validation.result',
          source_node_id: step.id,
          value: result,
        },
      ],
      output: result,
    };
  };
}

export function requiredPathValidationChecker(input: ValidationCheckInput): ValidationCheckResult {
  const findings: ValidationFinding[] = [];
  for (const path of input.required_paths ?? []) {
    if (!hasPath(input.artifact.content, path)) {
      findings.push({
        code: 'missing_required_path',
        message: `Artifact is missing required path '${path}'.`,
        path,
      });
    }
  }

  return {
    verdict: findings.length === 0 ? 'valid' : 'invalid',
    findings,
  };
}

function hasPath(value: unknown, path: string): boolean {
  const segments = path.split('.').filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !(segment in current)) return false;
    current = (current as Record<string, unknown>)[segment];
  }
  return current !== undefined;
}
