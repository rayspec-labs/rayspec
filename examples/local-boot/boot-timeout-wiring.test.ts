/**
 * A source-level guard WITH TEETH for this wrapper's boot-timeout wiring.
 *
 * The wrapper guards its (potentially slow) dev-DB provisioning + assemble step with the same boot
 * timeout the shipped `rayspec-serve` entrypoint uses, and prints an early progress line before it, so a
 * hung boot is DIAGNOSED rather than silent. A boot smoke test CANNOT catch a dropped timeout wrapper (it
 * would simply hang), so assert against serve.ts source that it (a) prints the early `[local-boot]
 * booting —` progress line and (b) wraps `assembleServer(...)` in `withBootTimeout(...,
 * resolveBootTimeoutMs())`. Dropping either wire REDs a case below — the same teeth
 * `@rayspec/server`'s boot-timeout.test.ts uses for the shipped entrypoint.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('serve.ts — wires the boot timeout and the early progress line', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'serve.ts'), 'utf8');
  // Strip comments so the assertions read the CODE, not prose that merely names the wiring.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('prints a progress line before the assemble step', () => {
    expect(code).toMatch(/\[local-boot\] booting —/);
  });

  it('wraps assembleServer in withBootTimeout with the resolved timeout', () => {
    expect(code).toMatch(/withBootTimeout\(\s*[\s\S]*assembleServer\(/);
    expect(code).toMatch(/resolveBootTimeoutMs\(\)/);
  });
});
