/**
 * The spec checks shared by `rayspec pack` and `rayspec bundle verify`: parse the spec a bundle
 * carries, resolve the application identity, and derive from the spec the manifest fields that must
 * equal what the spec uses — `requires`, `permissions.execution` and `permissions.egressHosts` —
 * together with the bindings its agent backends read.
 *
 * pack writes these fields from this derivation, and verify re-derives them from the spec inside the
 * archive and refuses a manifest that asks for more or less, so the two can never disagree. The spec
 * is parsed as YAML text and checked against the grammar; nothing it names is resolved, imported or
 * run.
 *
 * The derivation follows the `derivedFrom` rule of each id in the capability vocabulary. Two ids are
 * never derived from a document today: the runtime-provided ids a bundle cannot require, and
 * `extraction-deterministic`, which no grammar field selects yet. Egress hosts are the ones the spec
 * declares: backend `deployment.egressHosts`, product `deployment_overrides.egress_hosts`, in
 * code-point order; a spec that declares none derives an empty list.
 */
import {
  type BindingDeclaration,
  type BundleError,
  bundleError,
  compareCodePoints,
  type RayManifest,
  specEnvelopeCode,
  type ValidationResult,
} from '@rayspec/bundle-contract';
import {
  APPLICATION_ID_PATTERN,
  APPLICATION_VERSION_MAX_LENGTH,
  APPLICATION_VERSION_PATTERN,
  type ProductSpec,
  parseAnySpec,
  type RaySpec,
} from '@rayspec/spec';

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
    return {
      requires: sorted(ids),
      execution: 'none',
      egressHosts: sorted(new Set(spec.deployment_overrides?.egress_hosts ?? [])),
    };
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
  return {
    requires: sorted(ids),
    execution,
    egressHosts: sorted(new Set(spec.deployment?.egressHosts ?? [])),
  };
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

// ─── application identity ──────────────────────────────────────────────────────────────────────

/** The id and version an application bundle carries. */
export interface ApplicationIdentity {
  id: string;
  version: string;
}

/**
 * The application identity of a spec: `--id` and `--version` when given, otherwise the spec's own
 * `metadata.id` and `metadata.version` (backend profile) or `product.metadata.id` and
 * `product.metadata.version` (product profile). Nothing else is a source: the id is never taken from
 * `metadata.name` or `product.id`, and the version never from the runtime version. A missing value,
 * or one that does not match the manifest pattern, is `RAY_APPLICATION_IDENTITY_MISSING` with the
 * reason `id` or `version`; the id is checked first.
 */
export function resolveApplicationIdentity(
  parsed: BundleSpec,
  overrides: { id?: string | undefined; version?: string | undefined } = {},
): ValidationResult<ApplicationIdentity> {
  const metadata =
    parsed.kind === 'product' ? (parsed.spec.product.metadata ?? {}) : parsed.spec.metadata;
  const where = parsed.kind === 'product' ? 'product.metadata' : 'metadata';
  const id = overrides.id ?? metadata.id;
  const version = overrides.version ?? metadata.version;
  if (id === undefined || !APPLICATION_ID_PATTERN.test(id)) {
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_APPLICATION_IDENTITY_MISSING',
          id === undefined
            ? `the application has no id: add ${where}.id to the spec, or pass --id`
            : 'the application id must be a lowercase letter followed by up to 62 lowercase ' +
                'letters, digits or hyphens',
          { reason: 'id' },
        ),
      ],
    };
  }
  if (
    version === undefined ||
    version.length > APPLICATION_VERSION_MAX_LENGTH ||
    !APPLICATION_VERSION_PATTERN.test(version)
  ) {
    return {
      ok: false,
      errors: [
        bundleError(
          'RAY_APPLICATION_IDENTITY_MISSING',
          version === undefined
            ? `the application has no version: add ${where}.version to the spec, or pass --version`
            : 'the application version must be an exact semantic version (MAJOR.MINOR.PATCH with ' +
                'an optional -prerelease and no +build metadata)',
          { reason: 'version' },
        ),
      ],
    };
  }
  return { ok: true, value: { id, version } };
}

// ─── bindings ──────────────────────────────────────────────────────────────────────────────────

/**
 * The platform-grantable bindings each agent backend reads (reserved-bindings.json
 * `platformGrantable`). A backend with one credential requires it. The anthropic backend accepts
 * either of two, and codex can run on a login the operator places in `CODEX_HOME`, so those
 * bindings are declared but not required. A backend absent from this table reads no application
 * binding.
 */
const BACKEND_BINDINGS: Readonly<Record<string, readonly { name: string; required: boolean }[]>> = {
  openai: [{ name: 'OPENAI_API_KEY', required: true }],
  pi: [{ name: 'OPENAI_API_KEY', required: true }],
  anthropic: [
    { name: 'ANTHROPIC_API_KEY', required: false },
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', required: false },
  ],
  codex: [{ name: 'CODEX_API_KEY', required: false }],
};

const BINDING_DESCRIPTIONS: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: 'The OpenAI API key the openai and pi agent backends call the model with.',
  ANTHROPIC_API_KEY:
    'The Anthropic API key for the anthropic agent backend. Give it or CLAUDE_CODE_OAUTH_TOKEN.',
  CLAUDE_CODE_OAUTH_TOKEN:
    'The subscription token for the anthropic agent backend. Give it or ANTHROPIC_API_KEY.',
  CODEX_API_KEY:
    'An API key for the codex agent backend. Without it the backend uses the login the operator ' +
    'places in CODEX_HOME.',
};

/**
 * The bindings a spec's agent backends read, sorted by name, each named once. A backend profile
 * names its backends in `agents[]`; a product profile names them in its extraction, responder and
 * normalizer configuration files, which the caller reads and passes as `configuredBackends`.
 * Declaring a binding grants nothing: it tells the deployer which names to supply.
 */
export function deriveBindings(
  parsed: BundleSpec,
  configuredBackends: readonly string[] = [],
): BindingDeclaration[] {
  const backends = new Set<string>(configuredBackends);
  if (parsed.kind === 'rayspec')
    for (const agent of parsed.spec.agents) backends.add(agent.backend);
  const required = new Map<string, boolean>();
  for (const backend of backends) {
    for (const binding of BACKEND_BINDINGS[backend] ?? []) {
      required.set(binding.name, (required.get(binding.name) ?? false) || binding.required);
    }
  }
  return sorted(required.keys()).map((name) => ({
    name,
    kind: 'secret',
    required: required.get(name) === true,
    description: BINDING_DESCRIPTIONS[name] ?? name,
  }));
}

/** The agent backends a spec names that call a provider over the network. */
export function networkBackends(
  parsed: BundleSpec,
  configuredBackends: readonly string[] = [],
): string[] {
  const backends = new Set<string>(configuredBackends);
  if (parsed.kind === 'rayspec')
    for (const agent of parsed.spec.agents) backends.add(agent.backend);
  return sorted([...backends].filter((b) => Object.hasOwn(BACKEND_BINDINGS, b)));
}
