/**
 * The check of a platform dependency against the runtime a bundle pins.
 *
 * `@rayspec/*` packages are never copied into a bundle: the runtime that runs the bundle resolves
 * them to its own packages. What a bundle can still say is which platform versions its code was
 * written for, through the range a `package.json` declares for each `@rayspec/*` dependency. The
 * pinned runtime version must satisfy that range under npm's rules; a range it does not satisfy,
 * or a value that is not a version range at all (`workspace:*`, a path, a URL, a tag), is refused
 * with `RAY_RUNTIME_UNSUPPORTED`.
 */
import semver from 'semver';
import { refuse } from './refusal.js';

/** Refuse unless `runtimeVersion` satisfies `range`, declared for `name` in `declaredIn`. */
export function checkPlatformRange(
  name: string,
  range: string,
  runtimeVersion: string,
  declaredIn: string,
): void {
  if (semver.validRange(range) === null) {
    refuse(
      'RAY_RUNTIME_UNSUPPORTED',
      `${declaredIn} declares ${name} as '${range}', which is not a version range; declare the ` +
        `platform version the code was written for, such as '${runtimeVersion}' or '^${runtimeVersion}'`,
    );
  }
  if (!semver.satisfies(runtimeVersion, range)) {
    refuse(
      'RAY_RUNTIME_UNSUPPORTED',
      `${declaredIn} declares ${name} '${range}', which excludes the runtime ${runtimeVersion} the ` +
        'bundle pins; widen the range to include it, or pin a runtime inside the range',
    );
  }
}

/** The package name a bare module specifier names: `@scope/name` or `name`. */
export function packageNameOf(specifier: string): string | undefined {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    if (segments.length < 2 || segments[0] === '@' || segments[1] === '') return undefined;
    return `${segments[0]}/${segments[1]}`;
  }
  return segments[0] === '' ? undefined : segments[0];
}

/** Whether a package name belongs to the platform. */
export function isPlatformPackage(name: string): boolean {
  return name.startsWith('@rayspec/');
}
