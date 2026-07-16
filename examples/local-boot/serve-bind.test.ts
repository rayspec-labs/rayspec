/**
 * A source-level guard WITH TEETH for this wrapper's listener wiring.
 *
 * The wrapper must bind the RESOLVED host (`hostname: config.host`) so the loopback default is not
 * silently the all-interfaces default, and must log the ACTUAL bound address (`bootBaseUrl(info.address,
 * …)`) rather than a hard-coded `http://127.0.0.1:${port}` that would misreport a non-loopback bind.
 *
 * A boot test CANNOT catch a regression here: an all-interfaces bind (0.0.0.0 / ::) also answers on
 * 127.0.0.1, so a boot suite stays green even if the hostname pass-through is dropped or the banner
 * reverts to a hard-coded loopback. So we assert it against the entrypoint SOURCE instead — the same
 * teeth `@rayspec/server`'s serve-bind.test.ts uses for the shipped `rayspec-serve` entrypoint.
 * Reverting either edit (dropping `hostname` or restoring the `http://127.0.0.1:${info.port}` banner)
 * REDs a case below.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('serve.ts — passes the resolved host to the listener and logs the real bind', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'serve.ts'), 'utf8');
  // Strip comments so the assertions read the CODE, not prose that merely names the wiring.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('binds the RESOLVED host (hostname: config.host)', () => {
    expect(code).toMatch(/hostname:\s*config\.host/);
  });

  it('logs the ACTUAL bound address via bootBaseUrl(info.address, …)', () => {
    expect(code).toMatch(/bootBaseUrl\(\s*info\.address/);
  });

  it('does NOT hard-code a loopback base URL in the banner', () => {
    expect(code).not.toMatch(/http:\/\/127\.0\.0\.1:\$\{info\.port\}/);
  });
});
