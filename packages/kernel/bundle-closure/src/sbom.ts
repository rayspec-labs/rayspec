/**
 * The two generated files every application bundle carries at fixed paths: the per-application
 * SBOM (`payload/sbom.cdx.json`, CycloneDX 1.5 JSON in the bundle's canonical form) and the license
 * notices of every redistributed package (`payload/THIRD-PARTY-NOTICES.txt`).
 *
 * Both are built from the packages the closure vendored and nothing else, so the same closure
 * always yields the same bytes: no timestamps, no serial numbers, packages sorted by name and
 * version. An application that redistributes no package still gets both files, with no components
 * and a notice that says so. Platform packages are not listed: the runtime supplies them.
 */
import { canonicalJsonFile } from '@rayspec/bundle-contract';
import type { ApplicationIdentity } from './spec-fields.js';

/** One redistributed third-party package. */
export interface VendoredPackage {
  name: string;
  version: string;
  /** The license its `package.json` declares, verbatim. */
  license?: string;
  /** Every bundle path the package is placed at. */
  paths: string[];
  /** The license, copying and notice files it ships at its top level. */
  licenseTexts: { file: string; text: string }[];
}

/** The package URL of an npm package (`pkg:npm/%40scope/name@1.0.0`). */
export function packageUrl(name: string, version: string): string {
  const encoded = name.startsWith('@') ? `%40${name.slice(1)}` : name;
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

/** The SBOM of an application, as the bytes of a canonical JSON file. */
export function sbomBytes(
  application: ApplicationIdentity,
  packages: readonly VendoredPackage[],
): Uint8Array {
  const components = packages.map((p) => {
    const slash = p.name.indexOf('/');
    const scoped = p.name.startsWith('@') && slash > 0;
    const component: Record<string, unknown> = {
      type: 'library',
      'bom-ref': packageUrl(p.name, p.version),
      name: scoped ? p.name.slice(slash + 1) : p.name,
      version: p.version,
      purl: packageUrl(p.name, p.version),
    };
    if (scoped) component.group = p.name.slice(0, slash);
    if (p.license !== undefined)
      component.licenses = [{ license: { name: p.license.normalize('NFC') } }];
    return component;
  });
  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        'bom-ref': `application:${application.id}`,
        name: application.id,
        version: application.version,
      },
    },
    components,
  };
  return new TextEncoder().encode(canonicalJsonFile(document));
}

/** The license notices of an application's redistributed packages. */
export function noticesText(
  application: ApplicationIdentity,
  packages: readonly VendoredPackage[],
): string {
  const lines = [
    `Third-party notices for ${application.id} ${application.version}`,
    '',
    packages.length === 0
      ? 'This bundle redistributes no third-party packages. The RaySpec platform packages it ' +
        'uses are supplied by the runtime and carry their own notices.'
      : 'This bundle redistributes the third-party packages below. Each entry names the package, ' +
        'the license its package.json declares, where it is placed in the bundle, and the ' +
        'license text it ships. The RaySpec platform packages it uses are supplied by the runtime ' +
        'and carry their own notices.',
  ];
  for (const p of packages) {
    lines.push('', '='.repeat(72), `${p.name} ${p.version}`);
    lines.push(`License: ${p.license ?? 'not declared in its package.json'}`);
    for (const path of p.paths) lines.push(`Path: ${path}`);
    if (p.licenseTexts.length === 0) {
      lines.push('', 'The package ships no license file.');
    }
    for (const license of p.licenseTexts) {
      lines.push('', `--- ${license.file} ---`, '', license.text.trimEnd());
    }
  }
  return `${lines.join('\n')}\n`;
}
