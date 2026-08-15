/**
 * The tools documentation is DRIFT-LOCKED onto this package's exported role vocabulary: each
 * per-role list in docs/workforce-tools.md must equal `TOOLSETS_BY_ROLE[role]` as a set, and the
 * turn-ending list must equal `TURN_ENDING_TOOLS`. The anchors are the sentences the page
 * renders the lists after — a moved anchor is its own failure message, never a silent pass.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMPLOYEE_ROLES, TOOLSETS_BY_ROLE, TURN_ENDING_TOOLS } from './roles.js';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(resolve(here, '../../../../docs/workforce-tools.md'), 'utf8');

/** The backticked names inside the ONE paragraph following an anchor sentence. */
function listedAfter(anchor: string): Set<string> {
  const after = page.split(anchor)[1];
  expect(after, `anchor ${JSON.stringify(anchor)} moved or was reworded`).toBeDefined();
  const paragraph = (after as string).split('\n\n')[0] as string;
  return new Set([...paragraph.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string));
}

describe('docs/workforce-tools.md', () => {
  for (const role of EMPLOYEE_ROLES) {
    it(`documents the ${role} toolset exactly`, () => {
      expect(listedAfter(`The ${role} toolset is:`)).toEqual(new Set(TOOLSETS_BY_ROLE[role]));
    });
  }

  it('documents the turn-ending set exactly', () => {
    expect(listedAfter('The turn-ending tools are:')).toEqual(new Set(TURN_ENDING_TOOLS));
  });
});
