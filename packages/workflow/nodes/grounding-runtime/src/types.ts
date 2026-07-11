import type { CapabilityNodeHandler } from '@rayspec/foundation';

export type ArtifactContent = Record<string, unknown> | string | number | boolean | null;

export interface ArtifactEnvelope<TContent extends ArtifactContent = ArtifactContent> {
  kind: string;
  content: TContent;
  metadata?: Record<string, unknown>;
}

export interface ArtifactScope {
  namespace: string;
  scope: string;
}

export interface ArtifactHandle {
  id: string;
  kind: string;
  namespace: string;
  scope: string;
  content_hash: string;
  version: number;
  metadata: Record<string, unknown>;
}

export interface StoredArtifact<TContent extends ArtifactContent = ArtifactContent> {
  handle: ArtifactHandle;
  content: TContent;
}

export interface ArtifactPersistInput<TContent extends ArtifactContent = ArtifactContent> {
  artifact: ArtifactEnvelope<TContent>;
  namespace: string;
  scope: string;
  idempotency_key?: string;
}

export interface ArtifactReadInput {
  handle: ArtifactHandle | string;
}

export interface ArtifactStore {
  persist<TContent extends ArtifactContent>(
    input: ArtifactPersistInput<TContent>,
  ): Promise<StoredArtifact<TContent>> | StoredArtifact<TContent>;
  read(
    handle: ArtifactHandle | string,
  ): Promise<StoredArtifact | undefined> | StoredArtifact | undefined;
  resolve(
    handle: ArtifactHandle | string,
  ): Promise<ArtifactHandle | undefined> | ArtifactHandle | undefined;
}

export interface ArtifactPersistNodeOptions {
  store: ArtifactStore;
}

export interface ArtifactReadNodeOptions {
  store: ArtifactStore;
}

export interface GroundingReference {
  id: string;
  source_artifact_id?: string;
  path?: string;
}

export type GroundingVerdict = 'grounded' | 'ungrounded';

export interface GroundingFinding {
  code: 'missing_reference' | 'unknown_reference' | 'empty_evidence' | 'unsupported_claim';
  message: string;
  path?: string;
  reference_id?: string;
}

export interface GroundingCheckInput {
  source_artifact: ArtifactEnvelope;
  candidate_artifact: ArtifactEnvelope;
  references: GroundingReference[];
  closed_reference_ids: string[];
  /**
   * OPT-IN verbatim quote for quote-text verification. When a non-empty string, the checker requires
   * it to be a token-run subset of the TEXT of at least one CITED, in-closed-set span; the span texts
   * are read from `source_artifact.content.spans` (`{ id, text }[]`). If no cited span supports it, an
   * `unsupported_claim` finding is emitted. ABSENT ⇒ id-only closed-set checking (byte-identical to
   * the default path). Fail-closed: a quote with no resolvable span texts is UNSUPPORTED, never a
   * silent pass.
   */
  quote?: string;
}

export interface GroundingCheckResult {
  verdict: GroundingVerdict;
  findings: GroundingFinding[];
  corrected_references: GroundingReference[];
  dropped_references: GroundingReference[];
}

export type GroundingChecker = (
  input: GroundingCheckInput,
) => Promise<GroundingCheckResult> | GroundingCheckResult;

export interface GroundingCheckNodeOptions {
  checker?: GroundingChecker;
}

export type ValidationVerdict = 'valid' | 'invalid';

export interface ValidationFinding {
  code: 'missing_required_path' | 'invalid_type' | 'custom_validation_failed';
  message: string;
  path: string;
}

export interface ValidationCheckInput {
  artifact: ArtifactEnvelope;
  required_paths?: string[];
}

export interface ValidationCheckResult {
  verdict: ValidationVerdict;
  findings: ValidationFinding[];
}

export type ValidationChecker = (
  input: ValidationCheckInput,
) => Promise<ValidationCheckResult> | ValidationCheckResult;

export interface ValidationCheckNodeOptions {
  checker?: ValidationChecker;
}

export type GroundingCapabilityNodeHandler = CapabilityNodeHandler;
