/**
 * What a resolved closure turns into: the preview `rayspec pack --preview` prints, the manifest the
 * writer completes with its inventory, and the files it writes. All three are pure functions of the
 * closure; none reads the disk.
 */
import type { BundleFile, BundleManifestInput } from '@rayspec/bundle';
import type { BundleWarning, ExecutionLevel, Target } from '@rayspec/bundle-contract';
import type { Closure, FileRole } from './closure.js';

/** One line of the inclusion list. */
export interface PreviewEntry {
  /** The bundle path. */
  path: string;
  size: number;
  sha256: string;
  /** Where it comes from: a path relative to the application root, or `generated`. */
  source: string;
  role: FileRole;
}

/** The inclusion summary `rayspec pack` prints before, or instead of, writing a bundle. */
export interface ClosurePreview {
  applicationId: string;
  applicationVersion: string;
  /** The bundle path of the spec. */
  spec: string;
  runtimeVersion: string;
  target: Target;
  /** The capability ids the bundle requires. */
  requires: string[];
  /** The binding names a deployer supplies, never values. */
  bindings: { name: string; kind: 'secret' | 'config'; required: boolean }[];
  execution: ExecutionLevel;
  egressHosts: string[];
  warnings: BundleWarning[];
  notes: string[];
  /** Files and directories the walk left out, with the reason. */
  excluded: { source: string; reason: string }[];
  totalBytes: number;
  inclusion: PreviewEntry[];
}

export function closurePreview(closure: Closure): ClosurePreview {
  return {
    applicationId: closure.application.id,
    applicationVersion: closure.application.version,
    spec: closure.spec,
    runtimeVersion: closure.runtime.version,
    target: { ...closure.target },
    requires: [...closure.requires],
    bindings: closure.bindings.map(({ name, kind, required }) => ({ name, kind, required })),
    execution: closure.permissions.execution,
    egressHosts: [...closure.permissions.egressHosts],
    warnings: closure.warnings.map((w) => ({ ...w })),
    notes: [...closure.notes],
    excluded: closure.excluded.map((e) => ({ ...e })),
    totalBytes: closure.totalBytes,
    inclusion: closure.files.map(({ path, size, sha256, source, role }) => ({
      path,
      size,
      sha256,
      source,
      role,
    })),
  };
}

/** The application manifest of a closure, without the inventory the writer computes. */
export function closureManifest(closure: Closure): BundleManifestInput {
  const manifest: BundleManifestInput = {
    formatVersion: 1,
    kind: 'application',
    application: { ...closure.application },
    runtime: { ...closure.runtime },
    target: { ...closure.target },
    spec: closure.spec,
    requires: [...closure.requires],
    bindings: closure.bindings.map((b) => ({ ...b })),
    permissions: {
      execution: closure.permissions.execution,
      egressHosts: [...closure.permissions.egressHosts],
    },
  };
  if (closure.productMigration !== undefined) {
    manifest.productMigration = { ...closure.productMigration };
  }
  return manifest;
}

/**
 * The files of a closure as the writer takes them. A file on disk is passed by path, so the writer
 * reads it again; a caller compares the written inventory with the closure's digests to be sure
 * nothing changed in between.
 */
export function closureFiles(closure: Closure): BundleFile[] {
  return closure.files.map((f) =>
    f.bytes !== undefined ? { path: f.path, bytes: f.bytes } : { path: f.path, file: f.file! },
  );
}
