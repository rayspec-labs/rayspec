/**
 * HOW A DEPLOYED BUNDLE'S MODULES RESOLVE — an application served from a version directory imports
 * the platform from the runtime that serves it and everything else from the bundle.
 *
 * A bundle never carries a copy of a `@rayspec/*` package: pack removes them from every vendored
 * extension closure. So a handler or an extension in a version directory that imports `@rayspec/...`
 * would find nothing next to it. The resolve hook installed here answers such an import, and such a
 * CommonJS `require()`, from the installed runtime's own packages, the exact runtime the bundle was
 * admitted against. A copy a bundle carries anyway is never loaded.
 *
 * Every other bare import from inside the version directory must resolve inside it: a third-party
 * package the bundle does not carry is refused as not found, rather than picked up from whatever
 * `node_modules` happens to lie above the state directory (the operator's own project, for example).
 * Node's built-in modules resolve as always.
 *
 * The hook is process-wide and synchronous (`module.registerHooks`, Node 22.15 and later). It changes
 * nothing for a module outside the version directory, so the runtime itself resolves as before.
 */
import { realpathSync } from 'node:fs';
import module, { createRequire } from 'node:module';
import { sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface ResolveContext {
  parentURL?: string;
  conditions?: readonly string[];
  importAttributes?: Record<string, string>;
}
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context?: ResolveContext) => ResolveResult;
interface ModuleHooks {
  resolve?: (specifier: string, context: ResolveContext, next: NextResolve) => ResolveResult;
}
type RegisterHooks = (hooks: ModuleHooks) => { deregister(): void };

/**
 * Where a `@rayspec/*` import from a bundle is resolved from: the runtime's own packages — this
 * package, then the platform package, whose dependencies include the handler SDK.
 */
function runtimeParents(): string[] {
  const parents = [import.meta.url];
  try {
    parents.push(pathToFileURL(createRequire(import.meta.url).resolve('@rayspec/platform')).href);
  } catch {
    // Not resolvable from here: this package's own resolution is the only one.
  }
  return parents;
}

/** An installed resolution, removable in tests. */
export interface BundleModuleResolution {
  /** The version directory whose modules this resolution governs. */
  readonly root: string;
  remove(): void;
}

function isBare(specifier: string): boolean {
  return !(
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('file:') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('data:') ||
    module.isBuiltin(specifier)
  );
}

function notFound(specifier: string): Error {
  const err = new Error(
    `Cannot find package '${specifier}': a deployed bundle resolves its dependencies from the ` +
      'bundle itself, and this one does not carry it',
  ) as Error & { code: string };
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

/**
 * Install the resolution for the version directory `root`. Throws when this Node has no synchronous
 * module hooks.
 */
export function installBundleModuleResolution(root: string): BundleModuleResolution {
  const register = (module as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (typeof register !== 'function') {
    throw new Error(
      'this Node.js has no synchronous module hooks (module.registerHooks); a bundle deploy needs ' +
        'Node.js 22.15 or later',
    );
  }
  // Module URLs name real paths, so the directory is compared by its real path too.
  const real = realpathSync(root);
  const base = real.endsWith(sep) ? real : `${real}${sep}`;
  const parents = runtimeParents();
  const inside = (url: string | undefined): boolean => {
    if (url === undefined || !url.startsWith('file:')) return false;
    try {
      return fileURLToPath(url).startsWith(base);
    } catch {
      return false;
    }
  };
  const hooks = register({
    resolve(specifier, context, next) {
      if (!inside(context.parentURL) || !isBare(specifier)) return next(specifier, context);
      if (specifier === '@rayspec' || specifier.startsWith('@rayspec/')) {
        // A `require()` is resolved by Node's CommonJS resolver, which ignores a replaced
        // `parentURL` and would search the bundle's own `node_modules` (or any above it). So a
        // require is resolved here, from the runtime, and never handed on; an import is handed on
        // with the runtime as its parent. Either way a copy the bundle carries is never used.
        const required = context.conditions?.includes('require') === true;
        let lastError: unknown;
        for (const parentURL of parents) {
          try {
            if (!required) return next(specifier, { ...context, parentURL });
            const path = createRequire(parentURL).resolve(specifier);
            return { url: pathToFileURL(path).href, shortCircuit: true };
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError;
      }
      const resolved = next(specifier, context);
      if (resolved.url.startsWith('file:') && !inside(resolved.url)) throw notFound(specifier);
      return resolved;
    },
  });
  return { root, remove: () => hooks.deregister() };
}
