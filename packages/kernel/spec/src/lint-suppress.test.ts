/**
 * `lintSuppress` — node-scoped advisory acknowledgements with a mandatory justification.
 *
 * The grammar half (fail-closed at parse): a suppression entry is `{ code, because }` where `code`
 * must be a suppressible ADVISORY code — an ERROR code is rejected (errors cannot be suppressed),
 * and every code EXCLUDED from `SuppressibleWarningCode` is rejected — and `because` must
 * carry a non-empty, non-whitespace justification (suppression without a recorded reason is
 * rejected at parse).
 *
 * The exclusion set is NOT restated here, and that is the point: it is read off the enums, so this
 * suite cannot fall behind a new exclusion the way the author-facing message once did.
 *
 * The application half (`applyLintSuppressions`): a suppression filters ONLY advisories produced by
 * the node it sits on (an agent, a store, a route, a trigger, a handler) — never the same code fired
 * by another node — moving each matched advisory into a `suppressed` list carrying the finding's
 * code + the recorded justification. An acknowledgement whose code does not fire on its node becomes its own advisory
 * (`stale_suppression`, pointing at the suppression entry), so acknowledgements cannot rot silently.
 *
 * Fail-the-fix: the parse rejections are RED if the grammar accepts a reason-less or error-code
 * suppression; the scope test is RED if a suppression on node A swallows node B's advisory; the
 * passthrough test is RED if a suppression-free document's warnings are reordered or rewritten.
 */
import { describe, expect, it } from 'vitest';
import { SpecWarningCode, SuppressibleWarningCode } from './errors.js';
import { applyLintSuppressions, lintSpecWarnings } from './lint.js';
import { parseSpec } from './parse.js';

/** Parse a spec that MUST be valid, returning the RaySpec (throws with the errors otherwise). */
function parseOk(yaml: string) {
  const res = parseSpec(yaml);
  if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
  return res.value;
}

/**
 * An agent whose instructions name a free-text column without the precedence/closed-rule vocabulary
 * — fires `agent_untrusted_field_precedence` on `agents[0]`. `suppressYaml` is spliced in verbatim
 * under the agent (empty = no suppression).
 */
const agentSpec = (suppressYaml: string) => `
version: '1.0'
metadata:
  name: suppress-test
stores:
  - name: leads
    columns:
      - { name: company_blurb, type: text }
agents:
  - id: qualifier
    name: qualifier
    backend: openai
    model: gpt-4o-mini
    instructions: >
      Classify the lead. The company_blurb column describes the company.
${suppressYaml}
`;

const AGENT_SUPPRESS = `    lintSuppress:
      - code: agent_untrusted_field_precedence
        because: >
          The column carries a correlation id passed to tools, not free text the
          agent weighs; the untrusted-data framing is stated in the instructions.`;

describe('lintSuppress — grammar (fail-closed at parse)', () => {
  it('accepts a valid suppression (advisory code + non-empty because), and omits the key when absent', () => {
    const value = parseOk(agentSpec(AGENT_SUPPRESS));
    expect(value.agents[0]?.lintSuppress).toHaveLength(1);
    expect(value.agents[0]?.lintSuppress?.[0]?.code).toBe('agent_untrusted_field_precedence');
    // Absent ⇒ the key is not injected (keeps a suppression-free spec byte-identical).
    const bare = parseOk(agentSpec(''));
    expect(bare.agents[0] && 'lintSuppress' in bare.agents[0]).toBe(false);
  });

  it('rejects an EMPTY because at parse (suppression without a recorded reason)', () => {
    const res = parseSpec(
      agentSpec(`    lintSuppress:
      - code: agent_untrusted_field_precedence
        because: ''`),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const v = res.errors.find((e) => e.path === 'agents[0].lintSuppress[0].because');
      expect(v?.code).toBe('schema_violation');
    }
  });

  it('rejects a WHITESPACE-ONLY because at parse (a blank line is not a justification)', () => {
    const res = parseSpec(
      agentSpec(`    lintSuppress:
      - code: agent_untrusted_field_precedence
        because: '   '`),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const v = res.errors.find((e) => e.path === 'agents[0].lintSuppress[0].because');
      expect(v?.code).toBe('schema_violation');
    }
  });

  it('rejects an ERROR code at parse (advisories only — an error is never suppressible)', () => {
    const res = parseSpec(
      agentSpec(`    lintSuppress:
      - code: fk_cycle
        because: reviewed, not applicable here`),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const v = res.errors.find((e) => e.path === 'agents[0].lintSuppress[0].code');
      expect(v?.code).toBe('schema_violation');
    }
  });

  it('rejects stale_suppression as a code at parse (the rot detector cannot acknowledge itself)', () => {
    const res = parseSpec(
      agentSpec(`    lintSuppress:
      - code: stale_suppression
        because: reviewed, not applicable here`),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.path === 'agents[0].lintSuppress[0].code')).toBe(true);
    }
  });

  it('rejects an unknown key on a suppression entry (strict, fail-closed)', () => {
    const res = parseSpec(
      agentSpec(`    lintSuppress:
      - code: agent_untrusted_field_precedence
        because: reviewed
        note: extra`),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.code === 'unknown_field')).toBe(true);
    }
  });
});

describe('applyLintSuppressions — node scope + the suppressed list', () => {
  it('moves a suppressed advisory out of warnings, carrying code + justification + the finding path', () => {
    const value = parseOk(agentSpec(AGENT_SUPPRESS));
    const raw = lintSpecWarnings(value);
    expect(raw.map((w) => w.code)).toEqual(['agent_untrusted_field_precedence']);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.warnings).toEqual([]);
    expect(applied.suppressed).toHaveLength(1);
    expect(applied.suppressed[0]?.code).toBe('agent_untrusted_field_precedence');
    expect(applied.suppressed[0]?.because).toContain('correlation id');
    expect(applied.suppressed[0]?.path).toBe('agents[0].instructions');
  });

  it('scope is the node it sits on: the SAME code fired by ANOTHER node is not swallowed', () => {
    // Two agents, both firing the advisory; only the FIRST carries the suppression.
    const value = parseOk(`
version: '1.0'
metadata:
  name: scope-test
stores:
  - name: leads
    columns:
      - { name: company_blurb, type: text }
agents:
  - id: qualifier
    name: qualifier
    backend: openai
    model: gpt-4o-mini
    instructions: >
      Classify the lead. The company_blurb column describes the company.
    lintSuppress:
      - code: agent_untrusted_field_precedence
        because: the column carries a correlation id passed to tools, not free text
  - id: summarizer
    name: summarizer
    backend: openai
    model: gpt-4o-mini
    instructions: >
      Summarize the lead. The company_blurb column describes the company.
`);
    const raw = lintSpecWarnings(value);
    expect(raw).toHaveLength(2);
    const applied = applyLintSuppressions(value, raw);
    // agents[1]'s advisory survives; ONLY agents[0]'s is acknowledged.
    expect(applied.warnings.map((w) => w.path)).toEqual(['agents[1].instructions']);
    expect(applied.suppressed.map((s) => s.path)).toEqual(['agents[0].instructions']);
  });

  it('a suppression whose code does not fire on its node becomes stale_suppression (pointing at the entry)', () => {
    // The agent states BOTH halves (precedence + closed rule), so the heuristic does not fire —
    // the acknowledgement is stale and must say so rather than rot silently.
    const value = parseOk(`
version: '1.0'
metadata:
  name: stale-test
stores:
  - name: leads
    columns:
      - { name: company_blurb, type: text }
agents:
  - id: qualifier
    name: qualifier
    backend: openai
    model: gpt-4o-mini
    instructions: >
      Classify the lead. The structured fields take priority over company_blurb,
      and the stated rule is the whole rule.
    lintSuppress:
      - code: agent_untrusted_field_precedence
        because: reviewed last quarter
`);
    const raw = lintSpecWarnings(value);
    expect(raw).toEqual([]);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.suppressed).toEqual([]);
    expect(applied.warnings).toHaveLength(1);
    expect(applied.warnings[0]?.code).toBe('stale_suppression');
    expect(applied.warnings[0]?.path).toBe('agents[0].lintSuppress[0]');
    expect(applied.warnings[0]?.message).toContain('agent_untrusted_field_precedence');
  });

  it('works on a STORE node (softdelete_fk_restrict acknowledged on the parent store)', () => {
    const value = parseOk(`
version: '1.0'
metadata:
  name: store-suppress
stores:
  - name: orders
    softDelete: true
    columns:
      - { name: slug, type: text, unique: true }
    lintSuppress:
      - code: softdelete_fk_restrict
        because: shipments are purged by a scheduled job before any order is tombstoned
  - name: shipments
    columns:
      - { name: order_slug, type: text }
    foreignKeys:
      - { column: order_slug, references: orders, referencesColumn: slug, onDelete: restrict }
`);
    const raw = lintSpecWarnings(value);
    expect(raw.map((w) => w.code)).toEqual(['softdelete_fk_restrict']);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.warnings).toEqual([]);
    expect(applied.suppressed.map((s) => s.code)).toEqual(['softdelete_fk_restrict']);
  });

  it('works on a ROUTE node (stream_playback_media_token acknowledged on the playback route)', () => {
    const value = parseOk(`
version: '1.0'
metadata:
  name: route-suppress
handlers:
  - { id: media, module: dist/media.js, export: handler, kind: route }
api:
  - method: GET
    path: /media/{id}
    action: { kind: stream, handler: media, mode: playback }
    lintSuppress:
      - code: stream_playback_media_token
        because: tokens are minted by the companion ingest deployment sharing the media signing key
`);
    const raw = lintSpecWarnings(value);
    expect(raw.map((w) => w.code)).toEqual(['stream_playback_media_token']);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.warnings).toEqual([]);
    expect(applied.suppressed.map((s) => s.code)).toEqual(['stream_playback_media_token']);
  });

  it('works on a TRIGGER node (cron_tenant_required acknowledged on the cron trigger)', () => {
    const value = parseOk(`
version: '1.0'
metadata:
  name: trigger-suppress
deployment:
  durableWorker: true
agents:
  - id: summarizer
    name: summarizer
    backend: openai
    model: gpt-4o-mini
    instructions: >
      Summarize the previous day.
triggers:
  - name: nightly-summary
    kind: cron
    schedule: '0 3 * * *'
    action: { kind: agent, agent: summarizer }
    lintSuppress:
      - code: cron_tenant_required
        because: the deployment's compose file pins RAYSPEC_CRON_TENANT_ID to the operations org
`);
    const raw = lintSpecWarnings(value);
    expect(raw.map((w) => w.code)).toEqual(['cron_tenant_required']);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.warnings).toEqual([]);
    expect(applied.suppressed.map((s) => s.code)).toEqual(['cron_tenant_required']);
    expect(applied.suppressed[0]?.path).toBe('triggers[0].kind');
  });

  it('works on a HANDLER node (typescript_handler_module acknowledged on the .ts handler)', () => {
    const value = parseOk(`
version: '1.0'
metadata:
  name: handler-suppress
handlers:
  - id: export_rows
    module: handlers/export-rows.ts
    export: exportRows
    kind: route
    lintSuppress:
      - code: typescript_handler_module
        because: the deployment's build step transpiles handlers/ and rewrites the module paths
api:
  - method: GET
    path: /export
    action: { kind: handler, handler: export_rows }
`);
    const raw = lintSpecWarnings(value);
    expect(raw.map((w) => w.code)).toEqual(['typescript_handler_module']);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.warnings).toEqual([]);
    expect(applied.suppressed.map((s) => s.code)).toEqual(['typescript_handler_module']);
    expect(applied.suppressed[0]?.path).toBe('handlers[0].module');
  });

  it('a stale acknowledgement on a TRIGGER node names the trigger (label wiring)', () => {
    // The trigger was re-declared as a webhook, which has no fire path and so never demands the
    // cron tenant — the acknowledgement has outlived its finding.
    const value = parseOk(`
version: '1.0'
metadata:
  name: trigger-stale
handlers:
  - { id: ingest, module: dist/ingest.js, export: ingest, kind: trigger }
triggers:
  - name: inbound-hook
    kind: webhook
    action: { kind: handler, handler: ingest }
    lintSuppress:
      - code: cron_tenant_required
        because: reviewed while this was still a cron trigger
`);
    const raw = lintSpecWarnings(value);
    expect(raw).toEqual([]);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.suppressed).toEqual([]);
    expect(applied.warnings).toHaveLength(1);
    expect(applied.warnings[0]?.code).toBe('stale_suppression');
    expect(applied.warnings[0]?.path).toBe('triggers[0].lintSuppress[0]');
    expect(applied.warnings[0]?.message).toContain("trigger 'inbound-hook'");
  });

  it('a stale acknowledgement on a HANDLER node names the handler (label wiring)', () => {
    // The module was compiled to `.js`, so the build-step advisory no longer fires on it.
    const value = parseOk(`
version: '1.0'
metadata:
  name: handler-stale
handlers:
  - id: export_rows
    module: dist/export-rows.js
    export: exportRows
    kind: route
    lintSuppress:
      - code: typescript_handler_module
        because: reviewed while the module still pointed at the TypeScript source
api:
  - method: GET
    path: /export
    action: { kind: handler, handler: export_rows }
`);
    const raw = lintSpecWarnings(value);
    expect(raw).toEqual([]);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.suppressed).toEqual([]);
    expect(applied.warnings).toHaveLength(1);
    expect(applied.warnings[0]?.code).toBe('stale_suppression');
    expect(applied.warnings[0]?.path).toBe('handlers[0].lintSuppress[0]');
    expect(applied.warnings[0]?.message).toContain("handler 'export_rows'");
  });

  it('is a pure passthrough for a suppression-free document (same warnings, same order, nothing suppressed)', () => {
    const value = parseOk(agentSpec(''));
    const raw = lintSpecWarnings(value);
    const applied = applyLintSuppressions(value, raw);
    expect(applied.warnings).toEqual(raw);
    expect(applied.suppressed).toEqual([]);
  });

  /**
   * THE MESSAGE MUST NOT DRIFT BEHIND THE ENUM.
   *
   * This exists because it already happened: `workforce_escalation_unreachable` was excluded from
   * `SuppressibleWarningCode` while the refusal text still offered only two rationales — "an error
   * cannot be suppressed" and "stale_suppression cannot acknowledge itself" — so an author
   * acknowledging the new code was told about two cases that were not theirs. The list was
   * curated; curated lists drift. This reads the exclusion set off the enums and demands the
   * refusal name every member, so the next exclusion cannot land silently.
   *
   * The rationale TEXT is additionally keyed on `ExcludedWarningCode` in errors.ts, so a new
   * exclusion without a reason is a COMPILE error before it ever reaches this assertion.
   */
  it('the parse refusal NAMES every excluded advisory code, derived from the enums', () => {
    const suppressible = new Set<string>(SuppressibleWarningCode.options);
    const excluded = SpecWarningCode.options.filter((c) => !suppressible.has(c));
    // Ran-guard: an empty exclusion set would make every assertion below vacuously true.
    expect(
      excluded.length,
      'there must BE excluded codes for this guard to mean anything',
    ).toBeGreaterThan(0);

    const doc = [
      "version: '1.0'",
      'metadata:',
      '  name: p',
      'agents:',
      '  - id: a',
      '    name: a',
      '    backend: openai',
      '    model: gpt-4o-mini',
      '    instructions: Do the thing.',
      '    lintSuppress:',
      `      - code: ${excluded[0]}`,
      '        because: reviewed, not applicable',
      '',
    ].join('\n');
    const res = parseSpec(doc);
    expect(res.ok, 'an excluded code must be refused at parse').toBe(false);
    if (res.ok) return;
    const text = res.errors.map((e) => e.message).join(' | ');

    for (const code of excluded) {
      expect(text, `the refusal must name the excluded code '${code}' and why`).toContain(code);
    }
    // …and it must still list what IS permitted, or the author is told what they cannot do and
    // never what they can.
    for (const code of SuppressibleWarningCode.options) {
      expect(text, `the refusal must still offer the permitted code '${code}'`).toContain(code);
    }
  });
});
