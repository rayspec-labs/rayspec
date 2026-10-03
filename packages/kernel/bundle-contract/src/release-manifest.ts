/**
 * The signed release manifest: the release catalog of one RaySpec release.
 *
 * The file is canonical JSON followed by one LF, admitted by `release-manifest.schema.json`, and
 * its SHA-256 over exactly those bytes is the `releaseManifestSha256` the receipt, `inspect()` and
 * the plan digest name. Beyond the schema, the contract states semantic rules a reader enforces:
 * packages sorted by name with each name once, every package at the release version, every image
 * target listed in `targets`, at most one image per target. A manifest that breaks one is not a
 * release catalog, so a runtime version cannot resolve to it (`RAY_RUNTIME_UNSUPPORTED`).
 *
 * Pure: it reads no file and opens no connection. The detached signature over the manifest digest
 * is made and verified by `@rayspec/bundle`, beside the `.ray` signature.
 */
import {
  canonicalJson,
  compareCodePoints,
  MAX_JSON_DEPTH,
  parseJsonDocument,
} from './canonical-json.js';
import { type BundleError, bundleError } from './errors.js';
import { failingPointer, schemaValidator } from './schemas.js';
import type { ReleaseManifest } from './types.js';
import type { ValidationResult } from './validate.js';
import type { Target } from './vocabulary.js';

/** The largest release manifest read: the document limit the receipt applies to its own file. */
export const RELEASE_MANIFEST_MAX_BYTES = 4 * 1024 * 1024;

/** The domain string a release-manifest signature signs under; a `.ray` signature uses another. */
export const RELEASE_SIGNATURE_DOMAIN = 'rayspec-release-manifest-v1';

const sameTarget = (a: Target, b: Target) =>
  a.os === b.os && a.arch === b.arch && a.nodeMajor === b.nodeMajor;

/**
 * Every semantic rule of the contract the manifest breaks, in document order. Empty when the
 * manifest is a release catalog. The manifest must already be admitted by the schema.
 */
export function releaseManifestViolations(manifest: ReleaseManifest): BundleError[] {
  const errors: BundleError[] = [];
  const refuse = (message: string, path: string) =>
    errors.push(bundleError('RAY_RUNTIME_UNSUPPORTED', message, { path }));
  manifest.packages.forEach((pkg, i) => {
    const before = manifest.packages[i - 1];
    if (before !== undefined) {
      const order = compareCodePoints(before.name, pkg.name);
      if (order === 0) refuse('a package is listed twice', `/packages/${i}/name`);
      else if (order > 0) refuse('the packages are not sorted by name', `/packages/${i}/name`);
    }
    if (pkg.version !== manifest.rayspecVersion) {
      refuse('a package has another version than the release', `/packages/${i}/version`);
    }
  });
  manifest.images.forEach((image, i) => {
    if (!manifest.targets.some((t) => sameTarget(t, image.target))) {
      refuse('an image names a target the release does not list', `/images/${i}/target`);
    }
    if (manifest.images.slice(0, i).some((other) => sameTarget(other.target, image.target))) {
      refuse('a target has more than one image', `/images/${i}/target`);
    }
  });
  return errors;
}

/**
 * Read a release manifest file: canonical JSON within the document limit, the schema, then the
 * semantic rules. A failure in the bytes or the schema is `RAY_MANIFEST_INVALID`; a broken
 * semantic rule is `RAY_RUNTIME_UNSUPPORTED`, the code a runtime answers for a version that is not
 * in a signed release catalog.
 */
export function validateReleaseManifest(input: Uint8Array): ValidationResult<ReleaseManifest> {
  try {
    if (!(input instanceof Uint8Array)) {
      return refused('RAY_MANIFEST_INVALID', 'the release manifest is not a byte sequence', {
        reason: 'invalid-json',
      });
    }
    // The contract names no size reason for this document, so the refusal carries none.
    if (input.length > RELEASE_MANIFEST_MAX_BYTES) {
      return {
        ok: false,
        errors: [bundleError('RAY_LIMIT_EXCEEDED', 'the release manifest is larger than 4 MiB')],
      };
    }
    const parsed = parseJsonDocument(input, {
      maxBytes: RELEASE_MANIFEST_MAX_BYTES,
      maxDepth: MAX_JSON_DEPTH,
      canonical: true,
    });
    if (!parsed.ok) {
      const { code, reason } = parsed.failure;
      return {
        ok: false,
        errors: [
          bundleError(code, `the release manifest is refused (${reason})`, {
            reason,
          } as never),
        ],
      };
    }
    const validate = schemaValidator('releaseManifest');
    if (!validate(parsed.value)) {
      const first = validate.errors?.[0];
      return refused(
        'RAY_MANIFEST_INVALID',
        `the release manifest fails its JSON Schema (${first?.keyword ?? 'schema'})`,
        { reason: 'schema', path: first === undefined ? '' : failingPointer(first) },
      );
    }
    const manifest = parsed.value as ReleaseManifest;
    const violations = releaseManifestViolations(manifest);
    if (violations.length > 0) return { ok: false, errors: violations };
    return { ok: true, value: manifest };
  } catch {
    return refused('RAY_INTERNAL', 'validating the release manifest failed unexpectedly');
  }
}

/** The bytes of a release manifest file: canonical JSON and one LF. */
export function releaseManifestFile(manifest: ReleaseManifest): string {
  return `${canonicalJson(manifest)}\n`;
}

function refused(
  code: 'RAY_MANIFEST_INVALID' | 'RAY_INTERNAL',
  message: string,
  detail: { reason?: 'schema' | 'invalid-json'; path?: string } = {},
): { ok: false; errors: BundleError[] } {
  return { ok: false, errors: [bundleError(code, message, detail as never)] };
}
