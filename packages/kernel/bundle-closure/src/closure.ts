/**
 * The closure resolver: from a spec path, the explicit list of every file an application bundle
 * carries, and the manifest fields the spec derives.
 *
 * The inclusion list is built from what the spec names, never from the directory as a whole:
 *
 *   - the spec itself;
 *   - backend profile: each `handlers[].module`, each extension's entry module and the modules under
 *     its `handlers/` directory, and every module those import, followed statically; each
 *     `frontend[].dir` with its files;
 *   - product profile: the extraction, responder and normalizer configuration files the runtime
 *     reads next to the spec, and the prompt and schema files they and `instructions_ref` name;
 *   - the `package.json` that makes each module an ES module, the `package.json` and dependency lock
 *     of every directory whose `node_modules` supplies a package, and every third-party package the
 *     modules import, with the packages those depend on;
 *   - the product migration delta and allowlist when the caller supplies them;
 *   - `--include` additions;
 *   - a CycloneDX SBOM and the license notices of every redistributed package, generated.
 *
 * `@rayspec/*` imports are platform-owned and never copied: their declared ranges are checked
 * against the runtime the bundle pins instead. Nothing is imported, evaluated or executed: modules
 * are read by a lexer, native addons by their ELF header. Every refusal happens before any output
 * exists, and names the file and the fix.
 */
import { realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { isSecretPath } from '@rayspec/bundle';
import {
  type BindingDeclaration,
  type BundleError,
  type BundleWarning,
  bundleError,
  DEFAULT_READER_LIMITS,
  NOTICES_PATH,
  SBOM_PATH,
  SUPPORTED_TARGETS,
  type Target,
  type ValidationResult,
} from '@rayspec/bundle-contract';
import { APPLICATION_VERSION_PATTERN, typeScriptSourceExtensionOf } from '@rayspec/spec';
import { moduleImports } from './imports.js';
import { inspectAddon, packagePlatformExclusion } from './native.js';
import { ClosureRefusal, refuse } from './refusal.js';
import {
  excludedDirectory,
  excludedFile,
  excludedPackageDirectory,
  excludedPackageFile,
  LOCKFILE_NAMES,
  MAX_PAYLOAD_PATH_LENGTH,
  NATIVE_LOADERS,
  payloadPathFor,
} from './rules.js';
import { checkPlatformRange, isPlatformPackage, packageNameOf } from './runtime-range.js';
import { noticesText, sbomBytes, type VendoredPackage } from './sbom.js';
import {
  type ApplicationIdentity,
  type BundleSpec,
  deriveBindings,
  deriveManifestFields,
  networkBackends,
  parseBundleSpec,
  resolveApplicationIdentity,
} from './spec-fields.js';
import { ApplicationTree, digestBytes, type FileDigest } from './tree.js';

/** What a file in the closure is there for. */
export type FileRole =
  | 'spec'
  | 'module'
  | 'module-scope'
  | 'asset'
  | 'frontend'
  | 'package'
  | 'dependency-manifest'
  | 'lock'
  | 'migration'
  | 'include'
  | 'sbom'
  | 'notices';

/** One file of the closure. Exactly one of `file` and `bytes` is set. */
export interface ClosureFile {
  /** The bundle path, under `payload/`. */
  path: string;
  /** Where it comes from: a path relative to the application root, or `generated`. */
  source: string;
  /** The absolute path of the file on disk. */
  file?: string;
  /** The content of a generated file. */
  bytes?: Uint8Array;
  size: number;
  sha256: string;
  role: FileRole;
}

/** A file or directory left out of the closure, and why. */
export interface ExcludedEntry {
  /** The path relative to the application root. */
  source: string;
  reason: string;
}

/** A `@rayspec/*` import the runtime resolves, with the range its code declares, if any. */
export interface PlatformImport {
  name: string;
  range?: string;
  declaredIn?: string;
}

/** The product migration a caller generated against a previous spec, carried with the bundle. */
export interface ProductMigrationInput {
  delta: Uint8Array;
  allowlist?: Uint8Array;
  fromProductSchemaDigest: string;
  toProductSchemaDigest: string;
  destructive: boolean;
}

export interface ClosureOptions {
  /** The spec file. Its directory is the application root. */
  specPath: string;
  /** The exact runtime version the bundle pins. */
  runtimeVersion: string;
  /** The target; defaults to the one target a v1 runtime supports. */
  target?: Target;
  /** Overrides the spec's application id. */
  id?: string;
  /** Overrides the spec's application version. */
  version?: string;
  /** Extra files or directories, relative to the spec directory. */
  include?: readonly string[];
  /** Carry source maps (`*.map`) instead of leaving them out. */
  sourceMaps?: boolean;
  /** A generated product migration to carry under `payload/migrations/`. */
  productMigration?: ProductMigrationInput;
}

/** Everything `rayspec pack` needs to write the bundle and print its preview. */
export interface Closure {
  /** The real path of the application root. */
  root: string;
  profile: 'backend' | 'product';
  /** The bundle path of the spec. */
  spec: string;
  application: ApplicationIdentity;
  runtime: { version: string };
  target: Target;
  requires: string[];
  bindings: BindingDeclaration[];
  permissions: { execution: 'none' | 'in-process'; egressHosts: string[] };
  productMigration?: {
    fromProductSchemaDigest: string;
    toProductSchemaDigest: string;
    deltaPath: string;
    allowlistPath?: string;
    destructive: boolean;
  };
  /** Every file, sorted by bundle path. */
  files: ClosureFile[];
  /** What the walk left out. */
  excluded: ExcludedEntry[];
  /** The third-party packages the bundle redistributes, sorted by name and version. */
  packages: VendoredPackage[];
  /** The platform packages the modules import, sorted by name. */
  platformImports: PlatformImport[];
  /** Contract warnings (`RAY_W_*`). */
  warnings: BundleWarning[];
  /** Other things the author should know, in plain words. */
  notes: string[];
  /** The sum of every file's size. */
  totalBytes: number;
}

/** The bundle paths of the carried product migration. */
export const PRODUCT_DELTA_PATH = 'payload/migrations/product-delta.sql';
export const PRODUCT_ALLOWLIST_PATH = 'payload/migrations/product-allowlist.json';

const MODULE_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs']);
const DECLARATION_FILE = /\.d\.[cm]?ts$/i;
const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;
const URL_SIGNIFICANT = /[%#?]/;
/** A `require()` of one string literal in a CommonJS module. */
const REQUIRE_CALL = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
/** A source map inlined as a `data:` URL at the end of a script or style sheet. */
const INLINE_SOURCE_MAP = /\/[/*][#@][ \t]*sourceMappingURL[ \t]*=[ \t]*data:/;
const INLINE_MAP_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs', '.css']);
const SHA256 = /^[a-f0-9]{64}$/;

/**
 * Resolve the closure of the application whose spec is `options.specPath`. Returns the closure, or
 * the refusal as `{ ok: false, errors }` with a contract code: `RAY_USAGE`, `RAY_SPEC_INVALID` and
 * its `SPEC_` codes, `RAY_APPLICATION_IDENTITY_MISSING`, `RAY_CLOSURE_INVALID`,
 * `RAY_RUNTIME_UNSUPPORTED`, `RAY_SECRET_DETECTED` or `RAY_LIMIT_EXCEEDED`, in that order of the
 * pack pipeline. Reads the tree and writes nothing.
 */
export async function resolveClosure(options: ClosureOptions): Promise<ValidationResult<Closure>> {
  try {
    return { ok: true, value: await new Resolver(options).run() };
  } catch (e) {
    if (e instanceof ClosureRefusal) return { ok: false, errors: e.errors };
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'EACCES' || code === 'ELOOP' || code === 'ENOTDIR') {
      return {
        ok: false,
        errors: [
          bundleError(
            'RAY_CLOSURE_INVALID',
            `a file of the application could not be read (${code}); check that every path the ` +
              'spec names exists and is readable',
            { reason: 'unresolved-import' },
          ),
        ],
      };
    }
    return {
      ok: false,
      errors: [bundleError('RAY_INTERNAL', 'the closure resolver failed unexpectedly')],
    };
  }
}

interface PackageManifest {
  path: string;
  json: Record<string, unknown>;
}

/** A dependency of a vendored package. */
interface PackageDependency {
  name: string;
  range: string;
  optional: boolean;
  /** Named in `peerDependencies`: every dependent must reach the same copy. */
  peer: boolean;
  /** Where an import the package does not declare resolves, found when its modules were read. */
  found?: { logical: string; real: string };
}

interface PackageRecord {
  real: string;
  name: string;
  version: string;
  license: string | undefined;
  files: string[];
  licenseTexts: { file: string; text: string }[];
  dependencies: PackageDependency[];
  logicalPaths: string[];
}

/**
 * One package lookup Node makes in the bundle: from the directory `from` (a bundle-relative
 * directory, `''` for the root), the package `name` resolves to the placed directory `at`. A later
 * placement must never change it.
 */
interface Resolution {
  from: string;
  name: string;
  at: string;
}

class Resolver {
  private tree!: ApplicationTree;
  private readonly files = new Map<string, ClosureFile>();
  private readonly excluded: ExcludedEntry[] = [];
  private readonly notes: string[] = [];
  private readonly scanned = new Set<string>();
  private readonly manifests = new Map<string, PackageManifest | null>();
  private readonly platform = new Map<string, PlatformImport>();
  /** Packages the application's own modules import: logical path → real directory. */
  private readonly topLevel = new Map<string, string>();
  /** The package lookups the application's own modules make. */
  private readonly appResolutions: Resolution[] = [];
  private readonly packages = new Map<string, PackageRecord>();
  private readonly configuredBackends: string[] = [];
  private readonly sourceMaps: boolean;
  private readonly target: Target;

  constructor(private readonly options: ClosureOptions) {
    this.sourceMaps = options.sourceMaps === true;
    this.target = options.target ?? { ...SUPPORTED_TARGETS[0]! };
  }

  async run(): Promise<Closure> {
    const { runtimeVersion } = this.options;
    if (typeof runtimeVersion !== 'string' || !APPLICATION_VERSION_PATTERN.test(runtimeVersion)) {
      refuse('RAY_USAGE', 'the runtime version must be an exact version such as 1.8.0');
    }
    const specName = basename(this.options.specPath);
    if (!/\.ya?ml$/.test(specName)) {
      refuse('RAY_USAGE', 'the spec must be a .yaml or .yml file');
    }
    try {
      this.tree = await ApplicationTree.open(dirname(this.options.specPath));
    } catch {
      refuse('RAY_USAGE', 'the directory of the spec cannot be opened');
    }
    const specFile = join(this.tree.root, specName);
    const specStats = await this.tree.statInside(specFile, 'the spec');
    if (specStats === undefined || !specStats.isFile()) {
      refuse('RAY_USAGE', `the spec '${specName}' is not a regular file`);
    }

    // Spec parse, then identity, then the closure: the order of the pack pipeline.
    const specBytes = await this.tree.readFile(specFile);
    const parsed = parseBundleSpec(specBytes);
    if (!parsed.ok) throw new ClosureRefusal(parsed.errors);
    const spec = parsed.value;
    const identity = resolveApplicationIdentity(spec, {
      id: this.options.id,
      version: this.options.version,
    });
    if (!identity.ok) throw new ClosureRefusal(identity.errors);

    await this.addFile(specFile, 'spec', true);
    if (spec.kind === 'rayspec') await this.backendInputs(spec.spec);
    else await this.productInputs(spec.spec);
    for (const include of this.options.include ?? []) await this.includeInput(include);
    await this.vendorPackages();
    const migration = this.productMigration(spec);

    const derived = deriveManifestFields(spec);
    const bindings = deriveBindings(spec, this.configuredBackends);
    const warnings: BundleWarning[] = [];
    const backends = networkBackends(spec, this.configuredBackends);
    if (backends.length > 0 && derived.egressHosts.length === 0) {
      warnings.push({
        code: 'RAY_W_EGRESS_UNDECLARED',
        message:
          `the spec uses the agent backends ${backends.join(', ')} but declares no egress hosts; ` +
          'a host network policy that enforces the declared hosts will deny their calls',
      });
    }

    const packages = this.vendoredPackages();
    this.addGenerated(SBOM_PATH, sbomBytes(identity.value, packages), 'sbom');
    this.addGenerated(
      NOTICES_PATH,
      new TextEncoder().encode(noticesText(identity.value, packages)),
      'notices',
    );

    const files = [...this.files.values()].sort((a, b) => compareBytes(a.path, b.path));
    this.checkNames(files);
    this.secretScan(files);
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    this.checkLimits(files, totalBytes);

    const closure: Closure = {
      root: this.tree.root,
      profile: spec.kind === 'product' ? 'product' : 'backend',
      spec: this.payloadPath(specFile),
      application: identity.value,
      runtime: { version: runtimeVersion },
      target: this.target,
      requires: derived.requires,
      bindings,
      permissions: { execution: derived.execution, egressHosts: derived.egressHosts },
      files,
      excluded: [...this.excluded].sort((a, b) => compareBytes(a.source, b.source)),
      packages,
      platformImports: [...this.platform.values()].sort((a, b) => compareBytes(a.name, b.name)),
      warnings,
      notes: this.notes,
      totalBytes,
    };
    if (migration !== undefined) closure.productMigration = migration;
    return closure;
  }

  // ─── inputs the spec names ──────────────────────────────────────────────────────────────────

  private async backendInputs(
    spec: Extract<BundleSpec, { kind: 'rayspec' }>['spec'],
  ): Promise<void> {
    for (const handler of spec.handlers) {
      const what = `handler '${handler.id}' module`;
      const path = await this.moduleReference(this.tree.root, handler.module, what);
      if (typeScriptSourceExtensionOf(path) !== undefined) {
        refuse(
          'RAY_CLOSURE_INVALID',
          `${what} '${handler.module}' is TypeScript source; the runtime loads compiled JavaScript ` +
            'only. Compile the handlers first (the backend examples ship a build step, node ' +
            'build.mjs) and pack the spec of the built output',
          { reason: 'unresolved-import', path: handler.module },
        );
      }
      await this.scanModule(path);
    }
    for (const extension of spec.extensions) await this.extensionInputs(extension);
    for (const mount of spec.frontend ?? []) {
      const what = `frontend mount '${mount.route}' directory`;
      const { path, stats } = await this.tree.anchor(this.tree.root, mount.dir, what);
      if (stats === undefined || !stats.isDirectory()) {
        refuse(
          'RAY_CLOSURE_INVALID',
          `${what} '${mount.dir}' does not exist or is not a directory; build the frontend first`,
          { reason: 'unresolved-import', path: mount.dir },
        );
      }
      await this.addDirectory(path, 'frontend', what);
    }
  }

  private async extensionInputs(extension: { id: string; module: string }): Promise<void> {
    const what = `extension '${extension.id}'`;
    if (!extension.module.startsWith('.') && !extension.module.startsWith('/')) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${what} module '${extension.module}' is a package name; an extension is referenced as a ` +
          'directory relative to the spec',
        { reason: 'unresolved-import', path: extension.module },
      );
    }
    const root = await this.moduleReference(
      this.tree.root,
      extension.module,
      `${what} module`,
      true,
    );
    const entry = await this.extensionModule(root, 'index.ts', what);
    await this.scanModule(entry);
    const handlers = join(root, 'handlers');
    const stats = await this.tree.statInside(handlers, `${what} handlers directory`);
    if (stats === undefined) return;
    if (!stats.isDirectory()) {
      refuse('RAY_CLOSURE_INVALID', `${what}: 'handlers' is not a directory`, {
        reason: 'unresolved-import',
      });
    }
    const found = await this.tree.walk(
      handlers,
      `${what} file`,
      (path, name) => this.keepDirectory(path, name),
      (path, name) => this.keepFile(path, name),
    );
    for (const file of found) {
      const name = basename(file);
      if (DECLARATION_FILE.test(name)) continue;
      const ext = typeScriptSourceExtensionOf(file);
      if (ext !== undefined) {
        const compiled = `${file.slice(0, -ext.length)}.js`;
        if ((await this.tree.statInside(compiled, `${what} file`))?.isFile()) continue;
        refuse(
          'RAY_CLOSURE_INVALID',
          `${what} handler '${this.tree.relativePath(file)}' is TypeScript source with no compiled ` +
            '.js beside it; build the extension and pack the built directory',
          { reason: 'unresolved-import', path: this.tree.relativePath(file) },
        );
      }
      if (MODULE_EXTENSIONS.has(extname(file).toLowerCase())) await this.scanModule(file);
      else await this.addFile(file, 'asset', false);
    }
  }

  /** The loader's `.js`-preferred resolution of an extension module inside its directory. */
  private async extensionModule(root: string, module: string, what: string): Promise<string> {
    const ext = typeScriptSourceExtensionOf(module);
    if (ext !== undefined) {
      const compiled = join(root, `${module.slice(0, -ext.length)}.js`);
      if ((await this.tree.statInside(compiled, `${what} entry`))?.isFile()) return compiled;
      refuse(
        'RAY_CLOSURE_INVALID',
        `${what} has no compiled entry '${module.slice(0, -ext.length)}.js' in ` +
          `'${this.tree.relativePath(root)}'; the runtime loads compiled JavaScript only, so build ` +
          'the extension and point its module at the built directory',
        { reason: 'unresolved-import', path: this.tree.relativePath(root) },
      );
    }
    const path = join(root, module);
    if (!(await this.tree.statInside(path, `${what} entry`))?.isFile()) {
      refuse('RAY_CLOSURE_INVALID', `${what} has no entry module '${module}'`, {
        reason: 'unresolved-import',
      });
    }
    return path;
  }

  /**
   * A `module:` path of the spec, with the handler loader's jail: no URL-significant character, no
   * `..` segment, not absolute, inside the root, no link on the way. Returns the absolute path of an
   * existing file (or directory, when `directory` is set).
   */
  private async moduleReference(
    from: string,
    reference: string,
    what: string,
    directory = false,
  ): Promise<string> {
    if (URL_SIGNIFICANT.test(reference)) {
      refuse('RAY_CLOSURE_INVALID', `${what} '${reference}' contains % # or ?`, {
        reason: 'unresolved-import',
        path: reference,
      });
    }
    if (reference.split(/[/\\]/).includes('..')) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${what} '${reference}' contains a '..' segment; the loader refuses it`,
        { reason: 'escaping-link', path: reference },
      );
    }
    const { path, stats } = await this.tree.anchor(from, reference, what);
    const ok = directory ? stats?.isDirectory() : stats?.isFile();
    if (ok !== true) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${what} '${reference}' does not exist${directory ? ' as a directory' : ' as a file'}; ` +
          'build the application first and pack the spec of the built output',
        { reason: 'unresolved-import', path: reference },
      );
    }
    return path;
  }

  private async productInputs(
    spec: Extract<BundleSpec, { kind: 'product' }>['spec'],
  ): Promise<void> {
    const root = this.tree.root;
    for (const extractor of spec.extractors) {
      const perAgent = `extraction/${extractor.id}.extractor.json`;
      let config = perAgent;
      if (
        spec.extractors.length === 1 &&
        !(await this.tree.statInside(join(root, perAgent), 'extraction config'))?.isFile()
      ) {
        config = 'extraction/extractor.json';
      }
      const configPath = join(root, config);
      const configStats = await this.tree.statInside(configPath, 'extraction config');
      if (configStats?.isFile() === true) {
        await this.addFile(configPath, 'asset', true);
        const json = await this.readJson(configPath);
        if (typeof json?.backend === 'string') this.configuredBackends.push(json.backend);
        for (const key of ['prompt_file', 'schema_file']) {
          const value = json?.[key];
          if (typeof value !== 'string') continue;
          await this.referencedAsset(
            dirname(configPath),
            value,
            `extraction config '${config}' ${key}`,
          );
        }
      } else {
        this.notes.push(
          `extractor '${extractor.id}' has no ${config}; a live extraction executor needs it`,
        );
      }
      if (extractor.instructions_ref !== undefined) {
        await this.referencedAsset(
          root,
          extractor.instructions_ref.file,
          `extractor '${extractor.id}' instructions_ref`,
        );
      }
    }
    const declared = (id: string) => spec.capabilities.find((c) => c.id === id);
    if (declared('conversation_input') !== undefined) {
      const dir = join(root, 'conversation');
      if ((await this.tree.statInside(dir, 'conversation directory'))?.isDirectory() === true) {
        const found = await this.tree.walk(
          dir,
          'responder config',
          () => false,
          (_path, name) => name.endsWith('.responder.json'),
        );
        for (const file of found) {
          await this.addFile(file, 'asset', true);
          const json = await this.readJson(file);
          if (typeof json?.backend === 'string') this.configuredBackends.push(json.backend);
        }
      } else {
        this.notes.push('the spec declares conversation_input but has no conversation/ directory');
      }
    }
    const normalize = declared('record_input')?.input_normalize;
    if (normalize !== undefined) {
      const file = join(root, 'record', `${normalize.agent}.normalizer.json`);
      if ((await this.tree.statInside(file, 'normalizer config'))?.isFile() === true) {
        await this.addFile(file, 'asset', true);
        const json = await this.readJson(file);
        if (typeof json?.backend === 'string') this.configuredBackends.push(json.backend);
      } else {
        this.notes.push(
          `the spec declares input_normalize for '${normalize.agent}' but has no ` +
            `record/${normalize.agent}.normalizer.json`,
        );
      }
    }
  }

  private async referencedAsset(from: string, reference: string, what: string): Promise<void> {
    const { path, stats } = await this.tree.anchor(from, reference, what);
    if (stats?.isFile() !== true) {
      refuse('RAY_CLOSURE_INVALID', `${what} '${reference}' does not exist as a file`, {
        reason: 'unresolved-import',
        path: reference,
      });
    }
    await this.addFile(path, 'asset', true);
  }

  private async includeInput(include: string): Promise<void> {
    const what = 'the included path';
    const { path, stats } = await this.tree.anchor(this.tree.root, include, what);
    if (stats === undefined) refuse('RAY_USAGE', `${what} '${include}' does not exist`);
    if (stats.isDirectory()) await this.addDirectory(path, 'include', what);
    else await this.addFile(path, 'include', true);
  }

  private productMigration(spec: BundleSpec): Closure['productMigration'] {
    const input = this.options.productMigration;
    if (input === undefined) return undefined;
    if (spec.spec.stores.length === 0) {
      refuse('RAY_USAGE', 'a product migration was given, but the spec declares no stores');
    }
    if (!SHA256.test(input.fromProductSchemaDigest) || !SHA256.test(input.toProductSchemaDigest)) {
      refuse('RAY_USAGE', 'a product schema digest is not a lowercase SHA-256');
    }
    this.addGenerated(PRODUCT_DELTA_PATH, input.delta, 'migration');
    const migration: NonNullable<Closure['productMigration']> = {
      fromProductSchemaDigest: input.fromProductSchemaDigest,
      toProductSchemaDigest: input.toProductSchemaDigest,
      deltaPath: PRODUCT_DELTA_PATH,
      destructive: input.destructive,
    };
    if (input.allowlist !== undefined) {
      this.addGenerated(PRODUCT_ALLOWLIST_PATH, input.allowlist, 'migration');
      migration.allowlistPath = PRODUCT_ALLOWLIST_PATH;
    }
    return migration;
  }

  // ─── application modules ────────────────────────────────────────────────────────────────────

  /** Add one application module and follow its imports. */
  private async scanModule(path: string): Promise<void> {
    if (this.scanned.has(path)) return;
    this.scanned.add(path);
    const rel = this.tree.relativePath(path);
    const ext = extname(path).toLowerCase();
    if (typeScriptSourceExtensionOf(path) !== undefined) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `'${rel}' is TypeScript source; the runtime loads compiled JavaScript only, so compile it ` +
          'and import the compiled .js',
        { reason: 'unresolved-import', path: rel },
      );
    }
    const scope = await this.scopeOf(dirname(path));
    const esm = ext === '.mjs' || (ext === '.js' && scope?.json.type === 'module');
    if (!esm) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `'${rel}' is a CommonJS module, whose require() calls cannot be resolved without running ` +
          'it; compile it as an ES module (a .mjs file, or a .js file under a package.json with ' +
          '"type": "module")',
        { reason: 'unresolved-import', path: rel },
      );
    }
    if (scope) await this.addFile(scope.path, 'module-scope', true);
    await this.addFile(path, 'module', true);
    const source = (await this.tree.readFile(path)).toString('utf8');
    const imports = await moduleImports(source);
    if (imports === undefined) {
      refuse('RAY_CLOSURE_INVALID', `'${rel}' cannot be parsed as an ES module`, {
        reason: 'unresolved-import',
        path: rel,
      });
    }
    for (const entry of imports) {
      if (entry.kind === 'computed') {
        refuse(
          'RAY_CLOSURE_INVALID',
          `'${rel}' line ${entry.line} has a dynamic import() whose module name is computed at run ` +
            'time, which no bundle can follow; import the module by a string literal',
          { reason: 'unresolved-import', path: rel },
        );
      }
      await this.resolveImport(path, rel, entry.specifier, entry.line);
    }
  }

  private async resolveImport(from: string, rel: string, specifier: string, line: number) {
    const where = `'${rel}' line ${line}`;
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
      if (URL_SIGNIFICANT.test(specifier)) {
        refuse('RAY_CLOSURE_INVALID', `${where} imports '${specifier}', which carries % # or ?`, {
          reason: 'unresolved-import',
          path: rel,
        });
      }
      const { path, stats } = await this.tree.anchor(
        dirname(from),
        specifier,
        `${where}: the import`,
      );
      if (stats === undefined) {
        refuse(
          'RAY_CLOSURE_INVALID',
          `${where} imports '${specifier}', which does not exist; build it, or fix the import`,
          { reason: 'unresolved-import', path: rel },
        );
      }
      if (!stats.isFile()) {
        refuse(
          'RAY_CLOSURE_INVALID',
          `${where} imports the directory '${specifier}'; an ES module imports a file by its full ` +
            'name, such as ./lib/index.js',
          { reason: 'unresolved-import', path: rel },
        );
      }
      const ext = extname(path).toLowerCase();
      if (MODULE_EXTENSIONS.has(ext) || typeScriptSourceExtensionOf(path) !== undefined) {
        await this.scanModule(path);
      } else if (ext === '.node') {
        await this.checkAddon(path, `${where} imports the native addon '${specifier}'`);
        await this.addFile(path, 'asset', true);
      } else {
        await this.addFile(path, 'asset', true);
      }
      return;
    }
    if (specifier.startsWith('node:') || isBuiltin(specifier)) {
      if (specifier === 'module' || specifier === 'node:module') {
        refuse(
          'RAY_CLOSURE_INVALID',
          `${where} imports node:module, whose createRequire() loads modules by a name computed at ` +
            'run time that no bundle can follow; use static imports instead',
          { reason: 'unresolved-import', path: rel },
        );
      }
      return;
    }
    const name = packageNameOf(specifier);
    if (specifier.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier) || !name) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${where} imports '${specifier}', which is neither a relative file, a Node built-in nor a ` +
          'package name the closure can resolve',
        { reason: 'unresolved-import', path: rel },
      );
    }
    if (isPlatformPackage(name)) {
      await this.platformImport(name, dirname(from));
      return;
    }
    if (NATIVE_LOADERS.has(name)) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${where} imports '${name}', which loads a compiled native addon; native modules must be ` +
          'built for linux/x64 in an isolated build and carried as a vendored package instead',
        { reason: 'native-module', path: rel },
      );
    }
    const found = await this.findPackage(name, dirname(from));
    if (found === undefined) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${where} imports the package '${name}', which is not installed in a node_modules ` +
          'directory inside the application root; install it there (npm install) and pack again',
        { reason: 'unresolved-import', path: rel },
      );
    }
    const at = this.tree.relativePath(found.logical);
    this.topLevel.set(at, found.real);
    this.appResolutions.push({ from: this.tree.relativePath(dirname(from)), name, at });
  }

  /** Check a platform import against the range the nearest declaring package.json gives it. */
  private async platformImport(name: string, fromDirectory: string): Promise<void> {
    for (const manifest of await this.manifestsUpward(fromDirectory)) {
      const range = declaredRange(manifest.json, name);
      if (range === undefined) continue;
      const declaredIn = this.tree.relativePath(manifest.path);
      checkPlatformRange(name, range, this.options.runtimeVersion, declaredIn);
      await this.addFile(manifest.path, 'module-scope', true);
      if (!this.platform.has(name)) this.platform.set(name, { name, range, declaredIn });
      return;
    }
    if (!this.platform.has(name)) this.platform.set(name, { name });
  }

  // ─── third-party packages ───────────────────────────────────────────────────────────────────

  /**
   * Find a package the way Node does from `fromDirectory`: `node_modules/<name>` in the directory
   * and each parent, skipping directories that are themselves named `node_modules`, and stopping at
   * the application root. Package managers link packages into place, so the entry may be a link;
   * its real directory must lie inside the root.
   */
  private async findPackage(
    name: string,
    fromDirectory: string,
  ): Promise<{ logical: string; real: string } | undefined> {
    let dir = fromDirectory;
    for (;;) {
      if (basename(dir) !== 'node_modules') {
        const candidate = join(dir, 'node_modules', ...name.split('/'));
        const real = await realpathOrUndefined(candidate);
        if (real !== undefined) {
          if (!this.tree.contains(real)) {
            refuse(
              'RAY_CLOSURE_INVALID',
              `the package '${name}' at '${this.tree.relativePath(candidate)}' is a link to a ` +
                'directory outside the application root; install the package instead of linking it',
              { reason: 'escaping-link', path: this.tree.relativePath(candidate) },
            );
          }
          if ((await this.tree.statInside(real, `the package '${name}'`))?.isDirectory() === true) {
            return { logical: candidate, real };
          }
        }
      }
      if (dir === this.tree.root) return undefined;
      const parent = dirname(dir);
      if (parent === dir || !(this.tree.contains(parent) || parent === this.tree.root)) {
        return undefined;
      }
      dir = parent;
    }
  }

  /**
   * Copy every package the modules import, and the packages those depend on, into a layout where
   * Node resolves each import to the package it resolves to on the author's machine, and where a
   * package several others share is one copy, as it is one module instance there.
   *
   * A package the application imports stays at the path it was imported from. A dependency is
   * reused where Node already finds the same package from its dependent. Otherwise it is placed at
   * the path it has on disk when that path is on its dependent's lookup chain (an npm layout keeps
   * its shape), or else at the highest `node_modules` of that chain, from the dependent's dependency
   * root down (a pnpm layout is flattened into a hoisted one). A placement is valid only when the
   * dependent then finds it and no lookup made so far, the application's own included, changes.
   * Each package's dependencies are placed before any of them is processed.
   *
   * A package named as a peer dependency that still ends up in two places would be two module
   * instances where the author's machine has one, so it is refused.
   */
  private async vendorPackages(): Promise<void> {
    const placed = new Map<string, string>();
    const resolutions: Resolution[] = [...this.appResolutions];
    const peers = new Map<string, string>();
    const queue: { logical: string; real: string }[] = [];
    for (const logical of [...this.topLevel.keys()].sort(compareBytes)) {
      const real = this.topLevel.get(logical)!;
      placed.set(logical, real);
      queue.push({ logical, real });
    }
    while (queue.length > 0) {
      const { logical, real } = queue.shift()!;
      const record = await this.packageRecord(real, logical);
      record.logicalPaths.push(logical);
      for (const file of record.files) {
        const inside = relative(real, file).split(sep).join('/');
        await this.addPackageFile(file, `${logical}/${inside}`);
      }
      for (const dependency of record.dependencies) {
        if (isPlatformPackage(dependency.name)) {
          checkPlatformRange(
            dependency.name,
            dependency.range,
            this.options.runtimeVersion,
            `the package ${record.name}@${record.version}`,
          );
          continue;
        }
        const found = dependency.found ?? (await this.findPackage(dependency.name, real));
        if (found === undefined) {
          if (dependency.optional) continue;
          refuse(
            'RAY_CLOSURE_INVALID',
            `the package ${record.name}@${record.version} depends on '${dependency.name}', which is ` +
              'not installed; install the application dependencies inside the application root',
            { reason: 'unresolved-import', path: logical },
          );
        }
        if (dependency.peer && !peers.has(found.real)) {
          peers.set(found.real, `${record.name}@${record.version}`);
        }
        const visible = visiblePackage((p) => placed.has(p), logical, dependency.name);
        if (visible !== undefined && placed.get(visible) === found.real) {
          resolutions.push({ from: logical, name: dependency.name, at: visible });
          continue;
        }
        const target = placementFor(
          placed,
          resolutions,
          logical,
          dependency.name,
          this.tree.relativePath(found.logical),
        );
        if (target === undefined) {
          refuse('RAY_INTERNAL', `no place was found for '${dependency.name}' under '${logical}'`);
        }
        placed.set(target, found.real);
        resolutions.push({ from: logical, name: dependency.name, at: target });
        queue.push({ logical: target, real: found.real });
      }
    }
    for (const [real, dependent] of [...peers].sort(([a], [b]) => compareBytes(a, b))) {
      const copies = [...placed].filter(([, r]) => r === real).map(([p]) => p);
      if (copies.length < 2) continue;
      const record = this.packages.get(real)!;
      refuse(
        'RAY_CLOSURE_INVALID',
        `the package ${record.name}@${record.version} is a peer dependency of ${dependent} and is ` +
          `one copy on disk, but the bundle would need it in ${copies.length} places ` +
          `(${copies.sort(compareBytes).join(', ')}), which would make it ${copies.length} module ` +
          'instances; import it from the application, or install the dependencies so that one ' +
          'version of it is shared (npm dedupe), and pack again',
        { reason: 'unresolved-import', path: copies[0]! },
      );
    }
    const dependencyRoots = new Set<string>();
    for (const logical of placed.keys()) {
      const segments = logical.split('/');
      dependencyRoots.add(segments.slice(0, segments.indexOf('node_modules')).join('/'));
    }
    for (const dir of [...dependencyRoots].sort(compareBytes)) {
      const base = dir === '' ? this.tree.root : join(this.tree.root, ...dir.split('/'));
      let lock = false;
      for (const name of ['package.json', ...LOCKFILE_NAMES]) {
        const path = join(base, name);
        if ((await this.tree.statInside(path, 'dependency manifest'))?.isFile() !== true) continue;
        await this.addFile(path, name === 'package.json' ? 'dependency-manifest' : 'lock', true);
        if (name !== 'package.json') lock = true;
      }
      if (!lock) {
        this.notes.push(
          `the packages under '${dir === '' ? '.' : dir}/node_modules' have no dependency lock ` +
            'file next to them; the SBOM records their exact versions',
        );
      }
    }
  }

  private async packageRecord(real: string, logical: string): Promise<PackageRecord> {
    const known = this.packages.get(real);
    if (known !== undefined) return known;
    const manifestPath = join(real, 'package.json');
    const manifest = await this.readJson(manifestPath);
    const name = manifest?.name;
    const version = manifest?.version;
    if (manifest === undefined || typeof name !== 'string' || typeof version !== 'string') {
      refuse(
        'RAY_CLOSURE_INVALID',
        `the package at '${logical}' has no package.json with a name and a version`,
        { reason: 'unresolved-import', path: logical },
      );
    }
    const platform = packagePlatformExclusion(manifest);
    if (platform !== undefined) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `the package ${name}@${version} ('${logical}') is built for ${platform} by its package.json ` +
          'os and cpu fields, not for linux/x64; a platform-specific package installed on this ' +
          'machine is never copied. Install the dependencies for linux/x64 in an isolated build ' +
          '(npm install --os=linux --cpu=x64) and pack that tree',
        { reason: 'native-module', path: logical },
      );
    }
    const files = await this.tree.walk(
      real,
      `the package ${name} file`,
      (path, entry) => entry !== 'node_modules' && this.keepPackageDirectory(path, entry),
      (path, entry) => this.keepPackageFile(path, entry),
    );
    const dependencies = packageDependencies(manifest);
    const undeclared = await this.undeclaredImports(real, name, manifest, files, dependencies);
    for (const dependency of undeclared) {
      this.notes.push(
        `the package ${name}@${version} imports '${dependency.name}' without declaring it in its ` +
          'package.json; pack carries the copy it resolves to on this machine',
      );
    }
    dependencies.push(...undeclared);
    const addons = files.filter((f) => f.toLowerCase().endsWith('.node'));
    const buildsNative =
      files.some((f) => basename(f) === 'binding.gyp') ||
      manifest.gypfile === true ||
      dependencies.some((d) => NATIVE_LOADERS.has(d.name));
    if (addons.length > 0 || buildsNative) {
      if (addons.length === 0) {
        refuse(
          'RAY_CLOSURE_INVALID',
          `the package ${name}@${version} ('${logical}') is a native module with no compiled ` +
            'addon; build it for linux/x64 and Node 22 in an isolated build, then pack that tree',
          { reason: 'native-module', path: logical },
        );
      }
      for (const addon of addons) {
        await this.checkAddon(
          addon,
          `the package ${name}@${version} carries the native addon '${relative(real, addon)
            .split(sep)
            .join('/')}'`,
        );
      }
      this.notes.push(
        `the package ${name}@${version} carries a native addon built for linux/x64 and Node 22`,
      );
    }
    const licenseTexts: { file: string; text: string }[] = [];
    for (const file of files) {
      if (dirname(file) !== real || !LICENSE_FILE.test(basename(file))) continue;
      licenseTexts.push({
        file: basename(file),
        text: (await this.tree.readFile(file)).toString('utf8'),
      });
    }
    const license = typeof manifest.license === 'string' ? manifest.license : undefined;
    const record: PackageRecord = {
      real,
      name,
      version,
      license,
      files,
      licenseTexts,
      dependencies,
      logicalPaths: [],
    };
    this.packages.set(real, record);
    return record;
  }

  /**
   * The packages a vendored package's modules import without declaring them, as npm's hoisting
   * lets them: every literal `import`, `import()` and `require()` of its ES and CommonJS modules is
   * read, and a bare name the package's `package.json` does not declare is looked up the way Node
   * does from the importing file. One that is installed is carried like a declared dependency; one
   * that is not fails on the author's machine too, and is left alone.
   */
  private async undeclaredImports(
    real: string,
    name: string,
    manifest: Record<string, unknown>,
    files: readonly string[],
    declared: readonly PackageDependency[],
  ): Promise<PackageDependency[]> {
    const known = new Set([name, ...declared.map((d) => d.name)]);
    const found = new Map<string, PackageDependency>();
    const types = new Map<string, unknown>([[real, manifest.type]]);
    for (const file of files) {
      if (basename(file) !== 'package.json' || dirname(file) === real) continue;
      types.set(dirname(file), (await this.readJsonOrUndefined(file))?.type);
    }
    const esmScope = (file: string): boolean => {
      for (let dir = dirname(file); ; dir = dirname(dir)) {
        if (types.has(dir)) return types.get(dir) === 'module';
        if (dir === real || dir === dirname(dir)) return false;
      }
    };
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (!MODULE_EXTENSIONS.has(ext)) continue;
      const source = (await this.tree.readFile(file)).toString('utf8');
      const specifiers: string[] = [];
      if (ext === '.mjs' || (ext === '.js' && esmScope(file))) {
        for (const entry of (await moduleImports(source)) ?? []) {
          if (entry.kind !== 'computed') specifiers.push(entry.specifier);
        }
      } else {
        for (const match of source.matchAll(REQUIRE_CALL)) specifiers.push(match[2]!);
      }
      for (const specifier of specifiers) {
        if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
          continue;
        }
        if (specifier.startsWith('node:') || isBuiltin(specifier)) continue;
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) continue;
        const imported = packageNameOf(specifier);
        if (!imported || known.has(imported) || found.has(imported)) continue;
        if (isPlatformPackage(imported)) continue;
        const location = await this.findPackage(imported, dirname(file));
        if (location === undefined) continue;
        found.set(imported, {
          name: imported,
          range: '*',
          optional: false,
          peer: false,
          found: location,
        });
      }
    }
    return [...found.values()].sort((a, b) => compareBytes(a.name, b.name));
  }

  private async checkAddon(path: string, what: string): Promise<void> {
    const verdict = inspectAddon(await this.tree.readFile(path));
    if (!verdict.ok) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `${what}, built for ${verdict.builtFor}; a bundle carries native code only when built for ` +
          'linux/x64 and Node 22 (module ABI 127 or Node-API). Rebuild it in an isolated linux/x64 ' +
          'build and pack that tree; a local build for another platform is never copied',
        { reason: 'native-module', path: this.tree.relativePath(path) },
      );
    }
  }

  private vendoredPackages(): VendoredPackage[] {
    const byId = new Map<string, VendoredPackage>();
    for (const record of this.packages.values()) {
      const id = `${record.name}@${record.version}`;
      const paths = record.logicalPaths.map((p) => `payload/${p}`);
      const existing = byId.get(id);
      if (existing !== undefined) {
        existing.paths = [...existing.paths, ...paths].sort(compareBytes);
        continue;
      }
      const vendored: VendoredPackage = {
        name: record.name,
        version: record.version,
        paths: paths.sort(compareBytes),
        licenseTexts: record.licenseTexts,
      };
      if (record.license !== undefined) vendored.license = record.license;
      byId.set(id, vendored);
    }
    return [...byId.values()].sort(
      (a, b) => compareBytes(a.name, b.name) || compareBytes(a.version, b.version),
    );
  }

  // ─── files ──────────────────────────────────────────────────────────────────────────────────

  private keepDirectory(path: string, name: string): boolean {
    const exclusion = excludedDirectory(name);
    if (exclusion === undefined) return true;
    this.excluded.push({ source: this.tree.relativePath(path), reason: exclusion });
    return false;
  }

  private keepPackageDirectory(path: string, name: string): boolean {
    const exclusion = excludedPackageDirectory(name);
    if (exclusion === undefined) return true;
    this.excluded.push({ source: this.tree.relativePath(path), reason: exclusion });
    return false;
  }

  private keepPackageFile(path: string, name: string): boolean {
    const exclusion = excludedPackageFile(name, this.sourceMaps);
    if (exclusion === undefined) return true;
    this.excluded.push({ source: this.tree.relativePath(path), reason: exclusion });
    return false;
  }

  private keepFile(path: string, name: string): boolean {
    const exclusion = excludedFile(name, this.sourceMaps);
    if (exclusion === undefined) return true;
    this.excluded.push({ source: this.tree.relativePath(path), reason: exclusion });
    return false;
  }

  private async addDirectory(path: string, role: FileRole, what: string): Promise<void> {
    const found = await this.tree.walk(
      path,
      `${what} file`,
      (p, name) => this.keepDirectory(p, name),
      (p, name) => this.keepFile(p, name),
    );
    for (const file of found) await this.addFile(file, role, false);
  }

  private payloadPath(absolute: string): string {
    const rel = this.tree.relativePath(absolute);
    const path = payloadPathFor(rel);
    if (path === undefined) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `'${rel}' has a name a bundle path cannot carry (only A-Z a-z 0-9 _ . - @ + in each ` +
          'segment); rename it',
        { reason: 'excluded-file', path: rel },
      );
    }
    return path;
  }

  /**
   * Add a file of the application. A file named explicitly (by the spec, an import or `--include`)
   * that belongs to an excluded class is refused, never dropped. A file with a second name on disk
   * (a hard link) is refused, since that name may lie outside the root, and so is a script or style
   * sheet that inlines its source map, unless source maps are asked for.
   */
  private async addFile(path: string, role: FileRole, explicit: boolean): Promise<void> {
    const rel = this.tree.relativePath(path);
    if (explicit) {
      const exclusion = excludedFile(basename(path), this.sourceMaps);
      if (exclusion === 'a source map') {
        refuse(
          'RAY_CLOSURE_INVALID',
          `'${rel}' is a source map; pass --source-maps to carry source maps`,
          { reason: 'source-map-not-opted-in', path: rel },
        );
      }
      if (exclusion !== undefined) {
        refuse('RAY_CLOSURE_INVALID', `'${rel}' is ${exclusion} and never enters a bundle`, {
          reason: 'excluded-file',
          path: rel,
        });
      }
    }
    const payload = this.payloadPath(path);
    if (this.files.has(payload)) return;
    const digest = await this.tree.digestFile(path);
    if (digest.links > 1) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `'${rel}' is a hard link: the same file has ${digest.links} names on disk, and pack cannot ` +
          'tell whether the others lie outside the application root. Replace it with a copy of ' +
          'its own and pack again',
        { reason: 'escaping-link', path: rel },
      );
    }
    if (!this.sourceMaps && INLINE_MAP_EXTENSIONS.has(extname(path).toLowerCase())) {
      const text = (await this.tree.readFile(path)).toString('utf8');
      if (INLINE_SOURCE_MAP.test(text)) {
        refuse(
          'RAY_CLOSURE_INVALID',
          `'${rel}' inlines a source map (a sourceMappingURL with a data: URL), which may carry ` +
            'the original source; build without inline source maps, or pass --source-maps to ' +
            'carry them',
          { reason: 'source-map-not-opted-in', path: rel },
        );
      }
    }
    this.put(payload, rel, role, digest, { file: path });
  }

  private async addPackageFile(file: string, logicalPath: string): Promise<void> {
    const payload = payloadPathFor(logicalPath);
    if (payload === undefined) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `'${logicalPath}' has a name a bundle path cannot carry (only A-Z a-z 0-9 _ . - @ + in ` +
          'each segment)',
        { reason: 'excluded-file', path: logicalPath },
      );
    }
    if (this.files.has(payload)) return;
    const digest = await this.tree.digestFile(file);
    if (digest.nativePlatform !== undefined && digest.nativePlatform !== 'linux/x64') {
      refuse(
        'RAY_CLOSURE_INVALID',
        `'${logicalPath}' is a native binary built for ${digest.nativePlatform}; a bundle carries ` +
          'native code only when built for linux/x64. Install the dependencies for linux/x64 in ' +
          'an isolated build and pack that tree; a local build for another platform is never copied',
        { reason: 'native-module', path: logicalPath },
      );
    }
    this.put(payload, this.tree.relativePath(file), 'package', digest, { file });
  }

  private addGenerated(path: string, bytes: Uint8Array, role: FileRole): void {
    if (this.files.has(path)) {
      refuse(
        'RAY_CLOSURE_INVALID',
        `the application has its own '${path.slice('payload/'.length)}', a path the bundle ` +
          'reserves for a generated file; rename or remove it',
        { reason: 'excluded-file', path: path.slice('payload/'.length) },
      );
    }
    this.put(path, 'generated', role, digestBytes(bytes), { bytes });
  }

  private secretFindings = new Set<string>();

  private put(
    path: string,
    source: string,
    role: FileRole,
    digest: FileDigest,
    content: { file: string } | { bytes: Uint8Array },
  ): void {
    if (digest.privateKey || isSecretPath(path)) this.secretFindings.add(path);
    this.files.set(path, {
      path,
      source,
      ...content,
      size: digest.size,
      sha256: digest.sha256,
      role,
    });
  }

  /** Two names that differ only in case, or a file that is also a directory, cannot both exist. */
  private checkNames(files: readonly ClosureFile[]): void {
    const folded = new Map<string, string>();
    for (const file of files) {
      const key = file.path.toLowerCase();
      const other = folded.get(key);
      if (other !== undefined) {
        refuse(
          'RAY_CLOSURE_INVALID',
          `'${other}' and '${file.path}' differ only in letter case, which a bundle cannot carry; ` +
            'rename one',
          { reason: 'excluded-file', path: file.path },
        );
      }
      folded.set(key, file.path);
    }
    for (const file of files) {
      const segments = file.path.toLowerCase().split('/');
      for (let i = 1; i < segments.length; i++) {
        const prefix = segments.slice(0, i).join('/');
        const other = folded.get(prefix);
        if (other !== undefined) {
          refuse(
            'RAY_CLOSURE_INVALID',
            `'${other}' is a file and also a directory of '${file.path}'; rename one`,
            { reason: 'excluded-file', path: file.path },
          );
        }
      }
    }
  }

  /** The bundle's secret rules over every file: refused with every finding, by path only. */
  private secretScan(files: readonly ClosureFile[]): void {
    const findings = files.filter((f) => this.secretFindings.has(f.path));
    if (findings.length === 0) return;
    const errors: BundleError[] = findings.map((f) =>
      bundleError(
        'RAY_SECRET_DETECTED',
        `'${f.path}' looks like a credential (a secret file name or a private key); remove it from ` +
          'the application and supply the value as a binding at deploy time',
        { path: f.path },
      ),
    );
    throw new ClosureRefusal(errors);
  }

  private checkLimits(files: readonly ClosureFile[], totalBytes: number): void {
    const limits = DEFAULT_READER_LIMITS;
    if (files.length + 1 > limits.entryCount) {
      refuse(
        'RAY_LIMIT_EXCEEDED',
        `the closure holds ${files.length} files; a bundle holds at most ${limits.entryCount - 1}`,
        { reason: 'entry-count' },
      );
    }
    const long = files.find((f) => f.path.length > MAX_PAYLOAD_PATH_LENGTH);
    if (long !== undefined) {
      refuse('RAY_LIMIT_EXCEEDED', 'a bundle path is longer than 4096 bytes', {
        reason: 'path-length',
      });
    }
    if (totalBytes > limits.archiveBytes) {
      refuse(
        'RAY_LIMIT_EXCEEDED',
        `the closure holds ${totalBytes} bytes; an application bundle holds at most ` +
          `${limits.archiveBytes}`,
        { reason: 'archive-size' },
      );
    }
  }

  // ─── package.json ───────────────────────────────────────────────────────────────────────────

  private async readJson(path: string): Promise<Record<string, unknown> | undefined> {
    let text: string;
    try {
      text = (await this.tree.readFile(path)).toString('utf8');
    } catch {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      refuse('RAY_CLOSURE_INVALID', `'${this.tree.relativePath(path)}' is not valid JSON`, {
        reason: 'unresolved-import',
        path: this.tree.relativePath(path),
      });
    }
  }

  /** A JSON object, or `undefined` when the file is not one; never refuses. */
  private async readJsonOrUndefined(path: string): Promise<Record<string, unknown> | undefined> {
    try {
      return await this.readJson(path);
    } catch {
      return undefined;
    }
  }

  /** The `package.json` in `directory`, cached; `null` when there is none. */
  private async manifestIn(directory: string): Promise<PackageManifest | null> {
    const cached = this.manifests.get(directory);
    if (cached !== undefined) return cached;
    const path = join(directory, 'package.json');
    const stats = await this.tree.statInside(path, 'package.json');
    let manifest: PackageManifest | null = null;
    if (stats?.isFile() === true) {
      const json = await this.readJson(path);
      if (json === undefined) {
        refuse('RAY_CLOSURE_INVALID', `'${this.tree.relativePath(path)}' is not a JSON object`, {
          reason: 'unresolved-import',
        });
      }
      manifest = { path, json };
    }
    this.manifests.set(directory, manifest);
    return manifest;
  }

  /** Every `package.json` from `directory` up to the root, nearest first. */
  private async manifestsUpward(directory: string): Promise<PackageManifest[]> {
    const found: PackageManifest[] = [];
    let dir = directory;
    for (;;) {
      const manifest = await this.manifestIn(dir);
      if (manifest !== null) found.push(manifest);
      if (dir === this.tree.root) return found;
      dir = dirname(dir);
    }
  }

  /** The nearest `package.json`, which decides whether a `.js` file is an ES module. */
  private async scopeOf(directory: string): Promise<PackageManifest | null> {
    return (await this.manifestsUpward(directory))[0] ?? null;
  }
}

/** The range a manifest declares for `name`, from any of its runtime dependency fields. */
function declaredRange(json: Record<string, unknown>, name: string): string | undefined {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = json[field];
    if (typeof deps !== 'object' || deps === null) continue;
    const range = (deps as Record<string, unknown>)[name];
    if (typeof range === 'string') return range;
  }
  return undefined;
}

/** A package's runtime dependencies, sorted by name; development dependencies are not needed. */
function packageDependencies(json: Record<string, unknown>): PackageDependency[] {
  const byName = new Map<string, PackageDependency>();
  const field = (key: string) => {
    const value = json[key];
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  };
  const peerMeta = field('peerDependenciesMeta');
  for (const [name, range] of Object.entries(field('peerDependencies'))) {
    if (typeof range !== 'string') continue;
    const meta = peerMeta[name];
    const optional =
      typeof meta === 'object' &&
      meta !== null &&
      (meta as { optional?: unknown }).optional === true;
    byName.set(name, { name, range, optional, peer: true });
  }
  for (const [name, range] of Object.entries(field('optionalDependencies'))) {
    if (typeof range !== 'string') continue;
    byName.set(name, { name, range, optional: true, peer: byName.has(name) });
  }
  for (const [name, range] of Object.entries(field('dependencies'))) {
    if (typeof range !== 'string') continue;
    const optional = Object.hasOwn(field('optionalDependencies'), name);
    byName.set(name, { name, range, optional, peer: byName.get(name)?.peer === true });
  }
  return [...byName.values()].sort((a, b) => compareBytes(a.name, b.name));
}

/**
 * The placed package Node would find for `name` from the directory `from`: the first
 * `node_modules/<name>` among the directory and its parents, skipping directories named
 * `node_modules`.
 */
function visiblePackage(
  isPlaced: (path: string) => boolean,
  from: string,
  name: string,
): string | undefined {
  const segments = from === '' ? [] : from.split('/');
  for (let i = segments.length; i >= 0; i--) {
    if (i > 0 && segments[i - 1] === 'node_modules') continue;
    const base = segments.slice(0, i).join('/');
    const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    if (isPlaced(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Where to place `name` for the package at `logical`: its path on disk (`source`) when that is on
 * the package's lookup chain, otherwise the highest free `node_modules` from the package's
 * dependency root down to the package itself. A place is taken only when the package then finds
 * it and every lookup in `resolutions` still finds what it found.
 */
function placementFor(
  placed: ReadonlyMap<string, string>,
  resolutions: readonly Resolution[],
  logical: string,
  name: string,
  source: string,
): string | undefined {
  const segments = logical.split('/');
  const root = segments.indexOf('node_modules');
  const onChain: string[] = [];
  const fallback: string[] = [];
  for (let i = 0; i <= segments.length; i++) {
    const packageDirectory = i === segments.length || segments[i] === 'node_modules';
    if (i > root && !packageDirectory) continue;
    const base = segments.slice(0, i).join('/');
    const target = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
    onChain.push(target);
    if (i >= root && packageDirectory) fallback.push(target);
  }
  const fits = (target: string): boolean => {
    if (placed.has(target)) return false;
    const isPlaced = (p: string) => p === target || placed.has(p);
    if (visiblePackage(isPlaced, logical, name) !== target) return false;
    return resolutions.every(
      (r) => r.name !== name || visiblePackage(isPlaced, r.from, name) === r.at,
    );
  };
  if (onChain.includes(source) && fits(source)) return source;
  return fallback.find(fits);
}

async function realpathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
