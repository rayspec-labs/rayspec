/**
 * The journal vocabulary's EXPERIMENTAL marking, pinned so it cannot vanish silently.
 *
 * `docs/workforce-events.md` already carried a real EXPERIMENTAL paragraph — and nothing asserted
 * it, so a reword or a delete would have passed CI unremarked. A marking nothing pins is a marking
 * with a half-life. This file is the pin, plus the `@experimental` tag on the vocabulary's own
 * exports (the source AND the emitted `dist/events.d.ts`, which is what an installed
 * `@rayspec/tasks` hands an IDE — it is in the published runtime closure, `scripts/publish.mjs`).
 *
 * Two things are asserted about the paragraph, and only two, because they are the two a consumer
 * plans against: that it names the FLAG, and that it explains what `v: 1` is for. Its exact wording
 * is deliberately NOT frozen — a doc test that forbids rephrasing is a doc test people route
 * around.
 *
 * The `.d.ts` assertion reads `packages/kernel/tasks/dist`, so it needs a build behind it
 * (`pnpm build` precedes every test step in all three CI lanes). It fails CLOSED with that
 * instruction rather than skipping.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKFORCE_EVENT_VERSION } from './events.js';

const here = dirname(fileURLToPath(import.meta.url));
const readRepo = (rel: string): string => readFileSync(resolve(here, `../../../../${rel}`), 'utf8');

const TAG = '@experimental';
const FLAG = 'RAYSPEC_EXPERIMENTAL_WORKFORCE';

/** Same line-based export scan the spec package uses — see its header for why not an AST. */
function exportsWithLeadingDoc(source: string): Array<{ name: string; doc: string }> {
  const lines = source.split('\n');
  const out: Array<{ name: string; doc: string }> = [];
  for (const [index, line] of lines.entries()) {
    const decl =
      /^export\s+(?:declare\s+)?(?:const|let|var|function|async function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        line,
      );
    if (!decl) continue;
    let cursor = index - 1;
    const doc: string[] = [];
    if (cursor >= 0 && (lines[cursor] as string).trim().endsWith('*/')) {
      while (cursor >= 0) {
        doc.unshift(lines[cursor] as string);
        if ((lines[cursor] as string).trim().startsWith('/*')) break;
        cursor -= 1;
      }
    }
    out.push({ name: decl[1] as string, doc: doc.join('\n') });
  }
  return out;
}

describe('docs/workforce-events.md states the vocabulary is EXPERIMENTAL', () => {
  /**
   * The paragraph, located by its own bold marker rather than by line number — a line-number
   * citation in this repo has rotted between being written and being read more than once.
   */
  const paragraph = (): string => {
    const page = readRepo('docs/workforce-events.md');
    const at = page.indexOf('**EXPERIMENTAL.**');
    expect(
      at,
      'the EXPERIMENTAL paragraph marker is gone from docs/workforce-events.md',
    ).toBeGreaterThan(-1);
    const end = page.indexOf('\n\n', at);
    return page.slice(at, end === -1 ? undefined : end);
  };

  it('names the flag that gates the section producing these events', () => {
    expect(paragraph()).toContain(FLAG);
  });

  it('explains what the `v` stamp is for — the reason the vocabulary is consumable anyway', () => {
    const text = paragraph();
    expect(text).toContain(`v: ${WORKFORCE_EVENT_VERSION}`);
    // The stamp is a DETECTION mechanism, not a stability promise. The paragraph has to say the
    // former; if it ever says the latter, that is a claim wider than the mechanism behind it.
    expect(text.toLowerCase()).toContain('detectable');
  });

  it('the version constant the paragraph quotes is the one the writer actually stamps', () => {
    expect(WORKFORCE_EVENT_VERSION).toBe(1);
    expect(readRepo('packages/kernel/tasks/src/events.ts')).toContain(
      `export const WORKFORCE_EVENT_VERSION = ${WORKFORCE_EVENT_VERSION};`,
    );
  });
});

describe('the event vocabulary’s exports are marked @experimental', () => {
  it('every export of events.ts carries the tag in SOURCE', () => {
    const found = exportsWithLeadingDoc(readRepo('packages/kernel/tasks/src/events.ts'));
    expect(found.length, 'no exports parsed out of events.ts').toBeGreaterThan(0);
    const unmarked = found.filter((e) => !e.doc.includes(TAG)).map((e) => e.name);
    expect(unmarked, `events.ts exports without ${TAG}`).toEqual([]);
  });

  it('the tag SHIPS in the emitted dist/events.d.ts', () => {
    const declPath = resolve(here, '../dist/events.d.ts');
    if (!existsSync(declPath)) {
      throw new Error(
        `events-experimental-marking: ${declPath} is absent — run \`pnpm build\` first. This ` +
          'assertion reads the SHIPPED declarations on purpose: the tag existing in src/ proves ' +
          'nothing about what an installed package hands an IDE.',
      );
    }
    const sourceCount = (
      readRepo('packages/kernel/tasks/src/events.ts').match(/@experimental/g) ?? []
    ).length;
    const declCount = (readFileSync(declPath, 'utf8').match(/@experimental/g) ?? []).length;
    expect(sourceCount).toBeGreaterThan(0);
    expect(declCount).toBeGreaterThanOrEqual(sourceCount);
  });
});

describe('the forward-compatibility page pins the events row', () => {
  it('names the events surface and the version stamp it relies on', () => {
    const page = readRepo('docs/workforce-compatibility.md');
    expect(page).toContain('WORKFORCE_EVENT_VERSION');
    expect(page).toContain('docs/workforce-events.md');
    expect(page).toContain(TAG);
  });
});
