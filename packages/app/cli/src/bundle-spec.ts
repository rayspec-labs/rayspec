/**
 * The spec checks of a bundle: parse the spec a bundle carries, and derive from it the manifest
 * fields that must equal what the spec uses — `requires`, `permissions.execution` and
 * `permissions.egressHosts`.
 *
 * `rayspec pack` writes these fields from the same derivation, and `rayspec bundle verify` re-derives
 * them from the spec inside the archive and refuses a manifest that asks for more or less. The spec
 * is parsed as YAML text and checked against the grammar; nothing it names is resolved, imported or
 * run.
 *
 * The derivation follows the `derivedFrom` rule of each id in the capability vocabulary. Two ids are
 * never derived from a document today: the runtime-provided ids a bundle cannot require, and
 * `extraction-deterministic`, which no grammar field selects yet. Egress hosts come from a spec
 * field the grammar does not have yet, so every current spec derives an empty list, and a manifest
 * that lists a host is refused until the grammar can declare it.
 */
import {
  type BundleError,
  bundleError,
  compareCodePoints,
  type RayManifest,
  specEnvelopeCode,
} from '@rayspec/bundle-contract';
import { type ProductSpec, parseAnySpec, type RaySpec } from '@rayspec/spec';

/** The manifest fields a spec decides. */
export interface DerivedFields {
  requires: string[];
  execution: 'none' | 'in-process';
  egressHosts: string[];
}

/** The product-profile `requires.capabilities` ids that are also bundle capability ids. */
const PRODUCT_CAPABILITY_IDS = [
  'audio_input',
  'media_playback',
  'conversation_input',
  'file_input',
  'record_input',
] as const;

/** A spec parsed from a bundle, of either profile. */
export type BundleSpec =
  | { kind: 'rayspec'; spec: RaySpec }
  | { kind: 'product'; spec: ProductSpec };

/**
 * Parse the spec bytes of a bundle. A spec that is not UTF-8, or that the grammar refuses, is
 * `RAY_SPEC_INVALID` followed by each spec error as a `SPEC_` code with its path.
 *
 * The parser's own messages quote the document (a YAML error repeats the offending line, a schema
 * error the offending value), and the document here comes from an archive, so its text could be a
 * secret. Each message is therefore rebuilt from the error code and, when the parser gives one,
 * the line and column; nothing of the spec's text reaches the envelope except the path.
 */
export function parseBundleSpec(
  bytes: Uint8Array,
): { ok: true; value: BundleSpec } | { ok: false; errors: BundleError[] } {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return {
      ok: false,
      errors: [bundleError('RAY_SPEC_INVALID', 'the spec file is not valid UTF-8')],
    };
  }
  const parsed = parseAnySpec(text);
  if (parsed.ok) {
    return {
      ok: true,
      value:
        parsed.kind === 'product'
          ? { kind: 'product', spec: parsed.spec }
          : { kind: 'rayspec', spec: parsed.spec },
    };
  }
  return {
    ok: false,
    errors: [
      bundleError('RAY_SPEC_INVALID', 'the spec in the bundle does not validate'),
      ...parsed.errors.map((e) => {
        const error: BundleError = {
          code: specEnvelopeCode(e.code),
          message: redactedMessage(e.code, e.message),
          retryable: false,
        };
        if (e.path !== undefined && e.path !== '') error.path = e.path;
        return error;
      }),
    ],
  };
}

/** A spec error's message without the spec's text: the rule it breaks and where. */
function redactedMessage(code: string, message: string): string {
  const position = /\bline (\d+), column (\d+)/.exec(message);
  const where = position === null ? '' : ` at line ${position[1]}, column ${position[2]}`;
  return `the spec breaks the ${code.replaceAll('_', ' ')} rule${where}`;
}

/** The manifest fields a parsed spec derives, in the form the manifest carries them. */
export function deriveManifestFields(parsed: BundleSpec): DerivedFields {
  const ids = new Set<string>();
  if (parsed.kind === 'product') {
    const spec = parsed.spec;
    if (spec.stores.length > 0) ids.add('declarative-stores');
    // Every product deployment runs its workflows on the durable executor.
    ids.add('durable-workflow');
    for (const id of PRODUCT_CAPABILITY_IDS) {
      if (spec.requires.capabilities.includes(id)) ids.add(id);
    }
    return { requires: sorted(ids), execution: 'none', egressHosts: [] };
  }
  const spec = parsed.spec;
  if ((spec.frontend ?? []).length > 0) ids.add('static-frontend');
  if (spec.stores.length > 0) ids.add('declarative-stores');
  if (spec.api.length > 0) ids.add('declarative-api');
  if (spec.api.some((route) => route.action.kind === 'stream')) ids.add('stream-routes');
  if (spec.handlers.length > 0) ids.add('custom-handlers');
  if (spec.extensions.length > 0) ids.add('extensions');
  if (spec.deployment?.durableWorker === true) ids.add('durable-workflow');
  if (spec.deployment?.eventBus !== undefined) ids.add('tenant-event-bus');
  for (const trigger of spec.triggers) ids.add(`trigger-${trigger.kind}`);
  for (const agent of spec.agents) ids.add(`agent-backend-${agent.backend}`);
  const execution = spec.handlers.length > 0 || spec.extensions.length > 0 ? 'in-process' : 'none';
  return { requires: sorted(ids), execution, egressHosts: [] };
}

/**
 * Compare the derived fields with the manifest, in the order the contract lists them: `requires`,
 * then the execution level, then the egress hosts. `requires` must be the derived list exactly, in
 * code-point order; the egress hosts are compared as sets.
 */
export function checkDerivedFields(
  manifest: RayManifest & { kind: 'application' },
  derived: DerivedFields,
): BundleError[] {
  if (!sameList(manifest.requires, derived.requires)) {
    return [
      bundleError('RAY_MANIFEST_INVALID', 'requires is not the capability list the spec derives', {
        reason: 'requires-mismatch',
        path: '/requires',
      }),
    ];
  }
  if (manifest.permissions.execution !== derived.execution) {
    return [
      bundleError('RAY_MANIFEST_INVALID', 'the execution level is not the one the spec derives', {
        reason: 'execution-mismatch',
        path: '/permissions/execution',
      }),
    ];
  }
  if (
    !sameList(
      sorted(new Set(manifest.permissions.egressHosts)),
      sorted(new Set(derived.egressHosts)),
    )
  ) {
    return [
      bundleError('RAY_MANIFEST_INVALID', 'the egress hosts are not the ones the spec declares', {
        reason: 'permissions-mismatch',
        path: '/permissions/egressHosts',
      }),
    ];
  }
  return [];
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort(compareCodePoints);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
