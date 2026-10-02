/**
 * The supervisor never loads application code (supervisor.ts): from the moment it supervises, a
 * module resolution into the application's directories fails in its process. It imports nothing but
 * Node built-ins.
 */
import { realpathSync } from 'node:fs';
import module from 'node:module';
import { dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Refuse a resolution into the application's directories in this process from now on: the
 * supervisor never loads application code. A directory that contains the runtime itself (a document
 * kept beside the installation) is not guarded, since the runtime's own modules resolve into it.
 * Returns the function that removes the guard.
 */
export function guardSupervisorImports(directories: readonly string[]): () => void {
  type ResolveResult = { url: string };
  type Register = (hooks: {
    resolve: (
      specifier: string,
      context: unknown,
      next: (specifier: string, context: unknown) => ResolveResult,
    ) => ResolveResult;
  }) => { deregister(): void };
  const register = (module as unknown as { registerHooks?: Register }).registerHooks;
  if (typeof register !== 'function') return () => {};
  const runtime = realpathSync(dirname(fileURLToPath(import.meta.url)));
  const bases: string[] = [];
  for (const directory of directories) {
    try {
      const real = realpathSync(directory);
      const base = real.endsWith(sep) ? real : `${real}${sep}`;
      if (!`${runtime}${sep}`.startsWith(base)) bases.push(base);
    } catch {
      // A directory that does not exist holds no module.
    }
  }
  if (bases.length === 0) return () => {};
  const hooks = register({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (resolved.url.startsWith('file:')) {
        const path = fileURLToPath(resolved.url);
        if (bases.some((base) => path.startsWith(base))) {
          throw new Error(
            `the supervisor does not load application code: ${specifier} resolves into the ` +
              "application's files",
          );
        }
      }
      return resolved;
    },
  });
  return () => hooks.deregister();
}
