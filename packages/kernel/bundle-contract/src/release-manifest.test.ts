/**
 * The release manifest reader: the canonical bytes and the schema refuse with
 * `RAY_MANIFEST_INVALID`, and every semantic rule of the contract refuses with
 * `RAY_RUNTIME_UNSUPPORTED`, naming the member that breaks it.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';
import type { BundleError } from './errors.js';
import {
  RELEASE_MANIFEST_MAX_BYTES,
  releaseManifestFile,
  releaseManifestViolations,
  validateReleaseManifest,
} from './release-manifest.js';
import type { ReleaseManifest } from './types.js';

const linux = { os: 'linux', arch: 'x64', nodeMajor: 22 };

function manifest(): ReleaseManifest {
  return {
    releaseManifestFormatVersion: 1,
    rayspecVersion: '1.9.0-rc.0',
    sourceCommit: 'a'.repeat(40),
    identityManifestSha256: 'b'.repeat(64),
    targets: [linux],
    packages: [
      { name: '@rayspec/cli', version: '1.9.0-rc.0', integrity: `sha512-${'A'.repeat(86)}==` },
      { name: '@rayspec/server', version: '1.9.0-rc.0', integrity: `sha512-${'B'.repeat(86)}==` },
      { name: 'rayspec', version: '1.9.0-rc.0', integrity: `sha512-${'C'.repeat(86)}==` },
    ],
    images: [
      {
        target: linux,
        platform: 'linux/amd64',
        nodeVersion: '22.23.3',
        repository: 'ghcr.io/rayspec-labs/rayspec',
        digest: `sha256:${'c'.repeat(64)}`,
      },
    ],
  };
}

const bytes = (value: unknown) => Buffer.from(releaseManifestFile(value as ReleaseManifest));
const first = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}@${r.errors[0]!.path ?? ''}`;

describe('validateReleaseManifest', () => {
  it('admits a manifest that keeps every rule, written as canonical JSON and one LF', () => {
    const file = bytes(manifest());
    expect(file.toString('utf8')).toBe(`${canonicalJson(manifest())}\n`);
    const r = validateReleaseManifest(file);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(manifest());
  });

  it('refuses bytes that are not the canonical form', () => {
    const pretty = Buffer.from(`${JSON.stringify(manifest(), null, 2)}\n`);
    expect(first(validateReleaseManifest(pretty))).toBe('RAY_MANIFEST_INVALID/not-canonical@');
    const noNewline = Buffer.from(canonicalJson(manifest()));
    expect(first(validateReleaseManifest(noNewline))).toBe('RAY_MANIFEST_INVALID/not-canonical@');
  });

  it('refuses a manifest over the document limit before parsing it', () => {
    const big = Buffer.alloc(RELEASE_MANIFEST_MAX_BYTES + 1, 0x20);
    expect(big.length).toBeGreaterThan(RELEASE_MANIFEST_MAX_BYTES);
    expect(first(validateReleaseManifest(big))).toBe('RAY_LIMIT_EXCEEDED/@');
  });

  it('refuses a member the closed schema does not know, naming it', () => {
    const extended = { ...manifest(), contractVersion: '1.0.0-rc.1' };
    expect(first(validateReleaseManifest(bytes(extended)))).toBe(
      'RAY_MANIFEST_INVALID/schema@/contractVersion',
    );
  });

  it('refuses an image named by a tag instead of a digest', () => {
    const m = manifest();
    m.images[0]!.digest = 'latest';
    expect(first(validateReleaseManifest(bytes(m)))).toBe(
      'RAY_MANIFEST_INVALID/schema@/images/0/digest',
    );
  });

  it('refuses an image outside ghcr.io', () => {
    const m = manifest();
    m.images[0]!.repository = 'docker.io/rayspec/rayspec';
    expect(first(validateReleaseManifest(bytes(m)))).toBe(
      'RAY_MANIFEST_INVALID/schema@/images/0/repository',
    );
  });

  it('refuses a semantic violation with the code of a version outside the catalog', () => {
    const m = manifest();
    m.packages[1]!.version = '1.8.0';
    expect(first(validateReleaseManifest(bytes(m)))).toBe(
      'RAY_RUNTIME_UNSUPPORTED/@/packages/1/version',
    );
  });

  it('refuses input that is not bytes', () => {
    expect(first(validateReleaseManifest('{}' as never))).toBe(
      'RAY_MANIFEST_INVALID/invalid-json@',
    );
  });
});

describe('releaseManifestViolations', () => {
  it('finds nothing in a manifest that keeps every rule', () => {
    expect(releaseManifestViolations(manifest())).toEqual([]);
  });

  it('packages must be sorted by name', () => {
    const m = manifest();
    m.packages.reverse();
    expect(releaseManifestViolations(m).map((e) => e.path)).toEqual([
      '/packages/1/name',
      '/packages/2/name',
    ]);
  });

  it('each package name appears once', () => {
    const m = manifest();
    m.packages[1] = { ...m.packages[0]! };
    const errors = releaseManifestViolations(m);
    expect(errors.map((e) => [e.code, e.path, e.message])).toEqual([
      ['RAY_RUNTIME_UNSUPPORTED', '/packages/1/name', 'a package is listed twice'],
    ]);
  });

  it('every package is at the release version', () => {
    const m = manifest();
    m.packages[2]!.version = '1.9.0';
    expect(releaseManifestViolations(m).map((e) => e.path)).toEqual(['/packages/2/version']);
  });

  it('every image target is a listed target', () => {
    const m = manifest();
    m.images[0]!.target = { os: 'linux', arch: 'arm64', nodeMajor: 22 };
    expect(releaseManifestViolations(m).map((e) => e.path)).toEqual(['/images/0/target']);
  });

  it('a target has at most one image', () => {
    const m = manifest();
    m.images.push({ ...m.images[0]!, digest: `sha256:${'d'.repeat(64)}` });
    expect(releaseManifestViolations(m).map((e) => e.path)).toEqual(['/images/1/target']);
  });
});
