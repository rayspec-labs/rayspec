import { defineConfig } from 'vitest/config';

// The equivalence test spawns the two built bins (`rayspec` and `@rayspec/cli`) as child `node`
// processes and compares their behavior. A cold `node` start-up plus a couple of subprocesses can
// exceed vitest's 5000ms default under full-suite CPU load, so give the same generous timeout the
// other process-spawning suites use. No product behavior depends on the timeout.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
