/**
 * The supported-backend matrix for the managed hosting posture, and the boot refusal that enforces it.
 *
 * Each row states, per backend, what the tests in this repository prove about bounding and stopping
 * it — the provider-call timeout, what a cancellation does, whether a child process is killed — and
 * what remains a gap. The `managed` column is the managed-posture status of the backend's capability
 * id in the contract vocabulary (`@rayspec/bundle-contract`): only `allowed` backends may run under
 * `RAYSPEC_HOSTING_POSTURE=managed`. A boot under the posture that would use any other backend is
 * refused before anything is written, with the reason from the row — it never runs a backend outside
 * the matrix, and never silently swaps one for another.
 *
 * docs/hardened-posture.md renders this matrix for operators; a test holds the two equal.
 */
import { CAPABILITIES } from '@rayspec/bundle-contract';
import { BootConfigError } from './boot-config-error.js';

/** What kind of provider a backend is. */
export type BackendKind = 'agent' | 'speech-to-text' | 'text-to-speech';

/** One row of the matrix. */
export interface SupportedBackend {
  readonly kind: BackendKind;
  /** The backend id as the spec or the environment names it (`openai`, `deepgram`, …). */
  readonly id: string;
  /** The capability id in the contract vocabulary. */
  readonly capability: string;
  /** `allowed` ⇒ supported under the managed posture; anything else is refused there. */
  readonly managed: 'allowed' | 'self-host-only' | 'test-only';
  /** How one provider call is bounded. */
  readonly callTimeout: string;
  /** What cancelling a run (or its wall-clock bound) does to the call in flight. */
  readonly cancellation: string;
  /** Whether a child process that ignores SIGTERM is killed, and after how long. */
  readonly childProcess: string;
  /** What is NOT bounded or stopped. */
  readonly gaps: readonly string[];
  /** The tests that prove the bound, repository-relative. */
  readonly evidence: readonly string[];
  /** Why the backend is refused under the managed posture (absent for an allowed one). */
  readonly refusal?: string;
}

const UNCERTIFIED =
  'it runs a local child process or in-process agent loop that is bounded by this release but not ' +
  'certified for public hosting: a backend that needs a local CLI or arbitrary tools needs a ' +
  'separately isolated sandbox, which this runtime does not provide';

/** The matrix, in the order docs/hardened-posture.md renders it. */
export const SUPPORTED_BACKEND_MATRIX: readonly SupportedBackend[] = [
  {
    kind: 'agent',
    id: 'openai',
    capability: 'agent-backend-openai',
    managed: 'allowed',
    callTimeout:
      'every HTTP request: RAYSPEC_AGENT_REQUEST_TIMEOUT_MS on the client, at most ' +
      'RAYSPEC_AGENT_MAX_ATTEMPTS attempts',
    cancellation: "the run's signal aborts the HTTP request; the record says `call-aborted`",
    childProcess: 'none',
    gaps: ['a tool call already dispatched runs to its own tool timeout'],
    evidence: [
      'packages/adapters/openai/src/hanging-provider.test.ts',
      'packages/kernel/platform/src/run-core-bound.db.test.ts',
    ],
  },
  {
    kind: 'agent',
    id: 'anthropic',
    capability: 'agent-backend-anthropic',
    managed: 'self-host-only',
    callTimeout:
      'silence of the child: no message for RAYSPEC_AGENT_REQUEST_TIMEOUT_MS ends the run as `timeout`',
    cancellation:
      "the run's signal ends the SDK query; stdin is closed at once, SIGTERM after 2 s, SIGKILL 5 s later",
    childProcess: 'killed: the SDK sends SIGKILL 7 s after the abort (fixed by the SDK)',
    gaps: [
      'processes the child starts are not signalled (no process group)',
      'a host process that exits inside the ladder can orphan a child that ignores SIGTERM',
      'a tool call already dispatched runs to its own tool timeout',
    ],
    evidence: ['packages/adapters/anthropic/src/cancellation.real-process.test.ts'],
    refusal: UNCERTIFIED,
  },
  {
    kind: 'agent',
    id: 'codex',
    capability: 'agent-backend-codex',
    managed: 'self-host-only',
    callTimeout:
      'silence of the turn: no event for RAYSPEC_AGENT_REQUEST_TIMEOUT_MS ends the run as `timeout`',
    cancellation:
      "the run's signal ends the streamed turn; the launcher forwards SIGTERM to the child",
    childProcess: 'killed: SIGKILL RAYSPEC_AGENT_KILL_GRACE_MS after an ignored SIGTERM',
    gaps: [
      'processes the child starts are not signalled (no process group)',
      'without the bundled binary or a writable temp directory the escalation is unavailable (logged)',
    ],
    evidence: ['packages/adapters/codex/src/cancel.integration.test.ts'],
    refusal: UNCERTIFIED,
  },
  {
    kind: 'agent',
    id: 'pi',
    capability: 'agent-backend-pi',
    managed: 'self-host-only',
    callTimeout:
      'silence of the session: no event for RAYSPEC_AGENT_REQUEST_TIMEOUT_MS ends the run as `timeout`',
    cancellation: "the run's signal calls session.abort(), which aborts the HTTP request",
    childProcess: 'none',
    gaps: [
      'compaction and branch-summary requests run under controllers session.abort() does not reach',
      "a tool's own abort signal is not honoured; a dispatched tool runs to its own timeout",
    ],
    evidence: ['packages/adapters/pi/src/hanging-provider.test.ts'],
    refusal: UNCERTIFIED,
  },
  {
    kind: 'speech-to-text',
    id: 'deepgram',
    capability: 'stt-deepgram',
    managed: 'allowed',
    callTimeout: 'every request, body included: RAYSPEC_AGENT_REQUEST_TIMEOUT_MS',
    cancellation: 'none: handlers and workflow steps call it with no run signal',
    childProcess: 'none',
    gaps: ['a cancelled run does not stop a transcription already in flight'],
    evidence: ['packages/adapters/deepgram/src/hanging-provider.test.ts'],
  },
  {
    kind: 'speech-to-text',
    id: 'fake',
    capability: 'stt-fake',
    managed: 'test-only',
    callTimeout: 'not applicable (no provider)',
    cancellation: 'not applicable',
    childProcess: 'none',
    gaps: [],
    evidence: [],
    refusal: 'it is a deterministic stand-in for staging and conformance, not a provider',
  },
  {
    kind: 'text-to-speech',
    id: 'openai',
    capability: 'tts-openai',
    managed: 'allowed',
    callTimeout: 'every request, body included: RAYSPEC_AGENT_REQUEST_TIMEOUT_MS',
    cancellation: 'none: handlers call it with no run signal',
    childProcess: 'none',
    gaps: ['a cancelled run does not stop a synthesis already in flight'],
    evidence: ['packages/adapters/openai-tts/src/hanging-provider.test.ts'],
  },
  {
    kind: 'text-to-speech',
    id: 'fake',
    capability: 'tts-fake',
    managed: 'test-only',
    callTimeout: 'not applicable (no provider)',
    cancellation: 'not applicable',
    childProcess: 'none',
    gaps: [],
    evidence: [],
    refusal: 'it is a deterministic stand-in for staging and conformance, not a provider',
  },
];

/** The row for a backend, or undefined when the matrix has none for it. */
export function supportedBackend(kind: BackendKind, id: string): SupportedBackend | undefined {
  return SUPPORTED_BACKEND_MATRIX.find((row) => row.kind === kind && row.id === id);
}

/** The ids the managed posture supports for a kind. */
export function managedBackendIds(kind: BackendKind): string[] {
  return SUPPORTED_BACKEND_MATRIX.filter((r) => r.kind === kind && r.managed === 'allowed').map(
    (r) => r.id,
  );
}

const KIND_NOUN: Record<BackendKind, string> = {
  agent: 'agent backend',
  'speech-to-text': 'speech-to-text provider (STT_PROVIDER)',
  'text-to-speech': 'text-to-speech provider (TTS_PROVIDER)',
};

/**
 * The refusal for using `id` under the managed posture, or undefined when it is supported. `usedBy`
 * names what uses it (the agents, the extractor), so the operator sees exactly what to change.
 */
export function managedBackendRefusal(
  kind: BackendKind,
  id: string,
  usedBy: string,
): BootConfigError | undefined {
  const row = supportedBackend(kind, id);
  if (row?.managed === 'allowed') return undefined;
  const why =
    row === undefined
      ? 'it is not in the supported-backend matrix of this release'
      : `its capability '${row.capability}' is ${row.managed}: ${row.refusal ?? row.managed}`;
  return new BootConfigError(
    `Boot aborted — RAYSPEC_HOSTING_POSTURE=managed does not support the ${KIND_NOUN[kind]} ` +
      `'${id}' (${usedBy}): ${why}. Supported under the managed posture: ` +
      `${managedBackendIds(kind).join(', ') || 'none'}. Use a supported one, or boot without the ` +
      'managed posture.',
  );
}

/**
 * Refuse a managed-posture boot whose agents or speech providers fall outside the matrix. A no-op
 * outside the posture. Agents are named per backend, so one refusal lists every agent to change.
 */
export function assertManagedPostureBackends(input: {
  posture: 'local' | 'managed' | undefined;
  agents?: readonly { readonly name: string; readonly backend: string }[];
  sttProvider?: string | undefined;
  ttsProvider?: string | undefined;
}): void {
  if (input.posture !== 'managed') return;
  const byBackend = new Map<string, string[]>();
  for (const agent of input.agents ?? []) {
    byBackend.set(agent.backend, [...(byBackend.get(agent.backend) ?? []), agent.name]);
  }
  for (const [backend, names] of byBackend) {
    const refusal = managedBackendRefusal(
      'agent',
      backend,
      `declared by agent${names.length > 1 ? 's' : ''} ${names.map((n) => `'${n}'`).join(', ')}`,
    );
    if (refusal) throw refusal;
  }
  if (input.sttProvider) {
    const refusal = managedBackendRefusal('speech-to-text', input.sttProvider, 'STT_PROVIDER');
    if (refusal) throw refusal;
  }
  if (input.ttsProvider) {
    const refusal = managedBackendRefusal('text-to-speech', input.ttsProvider, 'TTS_PROVIDER');
    if (refusal) throw refusal;
  }
}

/**
 * The matrix's `managed` column against the contract vocabulary: every row's capability must exist
 * there with the same managed-posture status. Returns the disagreements (empty when they agree).
 */
export function matrixVocabularyDisagreements(): string[] {
  const out: string[] = [];
  for (const row of SUPPORTED_BACKEND_MATRIX) {
    const cap = CAPABILITIES.find((c) => c.id === row.capability);
    if (cap === undefined) out.push(`${row.capability}: not in the capability vocabulary`);
    else if (cap.managedPosture !== row.managed) {
      out.push(
        `${row.capability}: matrix says ${row.managed}, vocabulary says ${cap.managedPosture}`,
      );
    }
  }
  return out;
}
