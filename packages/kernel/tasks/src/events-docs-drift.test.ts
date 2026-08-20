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

  // The PAYLOAD-FIELD column (not just the event-type list) is what a consumer keys on, and it drifts
  // silently. Lock the fields the engine actually emits for the events whose payloads are non-obvious
  // — the two the field audit corrected: `queued.queueReason`'s full value set, and the TWO shapes of
  // `budget.exceeded`. A row that drops one of these tokens fails here.
  const rowFor = (page: string, type: string): string => {
    const line = page.split('\n').find((l) => l.startsWith(`| \`${type}\``));
    if (line === undefined) throw new Error(`no vocabulary row for '${type}'`);
    return line;
  };

  it('locks queueReason to every value the engine emits (turn_yield/tool_error/turn_reaped/turn_lease_expired/review_verdict)', () => {
    const row = rowFor(read('docs/workforce-events.md'), 'workforce.task.queued');
    for (const value of [
      'initial',
      'turn_yield',
      'tool_error',
      'turn_reaped',
      // The lease reap is a DISTINCT reason: same mechanism, different diagnosis. An operator
      // reading the journal must be able to tell "the workflow died" from "the worker wedged".
      'turn_lease_expired',
      'review_verdict',
    ]) {
      expect(row, `queued.queueReason omits '${value}'`).toContain(`\`${value}\``);
    }
  });

  it('locks BOTH budget.exceeded payload shapes (the exceedance and the block_and_escalate root event)', () => {
    const row = rowFor(read('docs/workforce-events.md'), 'workforce.budget.exceeded');
    // shape 1 — the exceedance on the offending task
    for (const field of ['ceiling', 'consumed', 'onBudgetExhausted']) {
      expect(row, `budget.exceeded omits '${field}'`).toContain(`\`${field}\``);
    }
    // shape 2 — the escalation event on the root
    for (const field of ['escalatedFrom', 'unblock']) {
      expect(row, `budget.exceeded omits the block_and_escalate field '${field}'`).toContain(
        `\`${field}\``,
      );
    }
  });

  it('locks the fields that distinguish a POLICY-GATED approval from a seat’s own request', () => {
    // The approval events carry TWO shapes for the same type, and the difference is the whole
    // meaning: a seat ASKED a question, or a declared `approvalPolicies` rule INTERCEPTED a
    // completion and is holding finished work. A consumer that cannot tell them apart reads an
    // authorization decision as a routine wake. The engine emits these from approval-gate.ts and
    // approvals.ts; nothing else in this suite would notice if the page stopped mentioning them.
    // The VALUE is pinned with the key on the two flags, not just the key name: `policy` and
    // `gatedCompletion` are presence-flags whose only legal value is `true`, and a page that
    // documented them as merely "present" would leave a consumer guessing at a boolean it might
    // read as false. `policyId` carries a value and is pinned by name alone.
    const page = read('docs/workforce-events.md');
    const requested = rowFor(page, 'workforce.approval.requested');
    for (const token of ['`policy: true`', '`policyId`']) {
      expect(requested, `approval.requested omits ${token}`).toContain(token);
    }
    const decided = rowFor(page, 'workforce.approval.decided');
    expect(decided, 'approval.decided omits `gatedCompletion: true`').toContain(
      '`gatedCompletion: true`',
    );
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
