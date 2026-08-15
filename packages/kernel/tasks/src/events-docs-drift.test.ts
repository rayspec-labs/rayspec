/**
 * The journal documentation is DRIFT-LOCKED onto the engine's exported vocabularies: the events
 * page's table must enumerate exactly `WORKFORCE_EVENT_TYPES`, and the tools page's
 * structured-result prose must match `workerResultSchema` (fields and the closed status enum)
 * and `ESCALATION_REASONS`. The result-contract arm lives HERE rather than beside the tools doc
 * because these constants export from @rayspec/tasks — the doc quotes the engine, so the engine
 * package holds the lock.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORKFORCE_EVENT_TYPES } from './events.js';
import { ESCALATION_REASONS, workerResultSchema } from './intent-applier.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, `../../../../${rel}`), 'utf8');

describe('docs/workforce-events.md', () => {
  it('enumerates exactly WORKFORCE_EVENT_TYPES in its vocabulary table', () => {
    const page = read('docs/workforce-events.md');
    const after = page.split('The journal event vocabulary is:')[1];
    expect(after, 'the vocabulary anchor sentence moved or was reworded').toBeDefined();
    // Exactly the TABLE that follows the anchor (first-column backticks only): prose elsewhere
    // names event types again as examples, and a page-wide scrape would quietly repair a table
    // with a row missing from it.
    const table = (after as string).trimStart().split('\n\n')[0] as string;
    const documented = new Set(
      [...table.matchAll(/^\| `(workforce\.[a-z_.]+)`/gm)].map((m) => m[1] as string),
    );
    expect(documented).toEqual(new Set(WORKFORCE_EVENT_TYPES));
  });
});

describe('docs/workforce-tools.md (the result contract the engine owns)', () => {
  it('lists exactly the structured-result fields and the closed status enum', () => {
    const page = read('docs/workforce-tools.md');
    const after = page.split('The structured result fields are:')[1];
    expect(after, 'the result-fields anchor sentence moved or was reworded').toBeDefined();
    const listSentence = (after as string).split('.')[0] as string;
    const fields = new Set([...listSentence.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1] as string));
    expect(fields).toEqual(new Set(Object.keys(workerResultSchema.shape)));

    const statusLine = page.split('\n').find((line) => line.includes('`status` is a closed enum'));
    expect(statusLine, 'the status-enum line moved or was reworded').toBeDefined();
    const statuses = [...(statusLine as string).matchAll(/`([a-z_]+)`/g)]
      .map((m) => m[1] as string)
      .filter((name) => name !== 'status');
    expect(new Set(statuses)).toEqual(new Set(workerResultSchema.shape.status.options));
  });

  it('lists exactly the closed escalation reasons', () => {
    const page = read('docs/workforce-tools.md');
    const after = page.split('with a typed reason from a closed set:')[1];
    expect(after, 'the escalation-reasons anchor moved or was reworded').toBeDefined();
    const sentence = (after as string).split('.\n')[0] as string;
    const reasons = new Set([...sentence.matchAll(/`([a-z_]+)`/g)].map((m) => m[1] as string));
    expect(reasons).toEqual(new Set(ESCALATION_REASONS));
  });
});
