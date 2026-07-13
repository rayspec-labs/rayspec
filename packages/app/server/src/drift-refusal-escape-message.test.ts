/**
 * The two mount-vs-deploy drift-refusal messages must NAME the operator escape — the exact
 * `rayspec plan … --against …` → `rayspec deploy --apply-migration <delta.sql>` command — so an operator
 * who hits a drifted schema is told precisely how to reconcile it, in BOTH boot profiles:
 *   - the BACKEND deploy path (composition-root.ts `deployDeclaredSpec`), and
 *   - the PRODUCT-YAML boot path (product-boot.ts `deployProductYamlSpec`).
 *
 * These are string-literal pins (the messages are thrown inline, not exported constants). RED if a
 * refusal drops the escape command — the message was augmented alongside the `--apply-migration` CLI.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

function read(file: string): string {
  return readFileSync(join(here, file), 'utf8');
}

describe('drift-refusal messages name the rayspec deploy --apply-migration escape', () => {
  it('the BACKEND drift refusal (composition-root) names the plan → deploy escape', () => {
    const src = read('composition-root.ts');
    expect(src).toMatch(/mount-without-deploy refuses to boot against a drifted/);
    expect(src).toMatch(/rayspec plan <new-spec> --against <old-spec>/);
    expect(src).toMatch(/rayspec deploy --apply-migration <delta\.sql>/);
  });

  it('the PRODUCT-YAML drift refusal (product-boot) names the plan → deploy escape', () => {
    const src = read('product-boot.ts');
    expect(src).toMatch(/mount-without-deploy refuses a drifted schema/);
    expect(src).toMatch(/rayspec plan <new-spec> --against <old-spec>/);
    expect(src).toMatch(/rayspec deploy --apply-migration <delta\.sql>/);
  });
});
