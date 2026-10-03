/**
 * Whether the module at `moduleUrl` is the script Node was started with.
 *
 * Both sides are compared as real paths: a script started through a path that holds a symbolic link
 * (macOS keeps its temporary directories under /var, a link to /private/var) is still the entry
 * point, and its main function runs. A plain URL comparison would skip it and exit 0 having done
 * nothing.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
