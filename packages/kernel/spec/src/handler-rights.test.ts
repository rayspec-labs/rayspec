/**
 * `handlers[].uses`: the rights a handler asks for. A right outside the closed vocabulary is refused
 * when the document is parsed; one the handler's kind never receives is refused by the lint, at the
 * entry's path — both before anything is loaded or run.
 */
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';

const spec = (handlers: string, api = '', extra = '') => `
version: '1.0'
metadata:
  name: rights
stores:
  - name: notes
    columns:
      - { name: body, type: text }
api:
  - { method: GET, path: '/notes', action: { kind: store, store: notes, op: list } }
${api}handlers:
${handlers}${extra}`;

function errors(text: string): [string, string | undefined][] {
  const r = parseSpec(text);
  return r.ok ? [] : r.errors.map((e) => [e.code, e.path]);
}

describe('handlers[].uses', () => {
  it('accepts the rights each kind receives, and an empty list', () => {
    const r = parseSpec(
      spec(
        `  - { id: report, module: h.mjs, export: report, kind: route, uses: [stt, emit, enqueue, bindings] }
  - { id: upload, module: h.mjs, export: upload, kind: route, uses: [blob] }
  - { id: lookup, module: h.mjs, export: lookup, kind: tool, uses: [fsSource, blob] }
  - { id: nightly, module: h.mjs, export: nightly, kind: trigger, uses: [] }
`,
        `  - { method: POST, path: '/report', action: { kind: handler, handler: report } }
  - { method: POST, path: '/upload/{id}', action: { kind: stream, handler: upload, mode: ingest } }
`,
      ),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.value.handlers.map((h) => h.uses)).toEqual([
      ['stt', 'emit', 'enqueue', 'bindings'],
      ['blob'],
      ['fsSource', 'blob'],
      [],
    ]);
  });

  it('refuses a right outside the vocabulary when the document is parsed', () => {
    for (const right of ['shell', 'network', 'db', 'process.env']) {
      expect(
        errors(spec(`  - { id: t, module: h.mjs, export: t, kind: tool, uses: [${right}] }\n`)),
      ).toContainEqual(['schema_violation', 'handlers[0].uses[0]']);
    }
  });

  it('refuses a right listed twice', () => {
    expect(
      errors(spec('  - { id: t, module: h.mjs, export: t, kind: tool, uses: [stt, stt] }\n')),
    ).toContainEqual(['schema_violation', 'handlers[0].uses']);
  });

  it.each([
    ['a trigger asking for speech', 'trigger', '[stt]', '', 'a trigger handler never receives'],
    ['a tool asking to enqueue a run', 'tool', '[enqueue]', '', 'a tool never receives'],
    [
      'a {handler} route asking for a blob handle',
      'route',
      '[blob]',
      "  - { method: POST, path: '/x', action: { kind: handler, handler: h } }\n",
      'a {handler} route handler never receives',
    ],
    [
      'a stream route asking for speech',
      'route',
      '[blob, stt]',
      "  - { method: POST, path: '/x/{id}', action: { kind: stream, handler: h, mode: ingest } }\n",
      'a stream route handler never receives',
    ],
  ])('refuses %s: a right its kind never receives', (_what, kind, uses, api, message) => {
    const r = parseSpec(
      spec(`  - { id: h, module: h.mjs, export: h, kind: ${kind}, uses: ${uses} }\n`, api),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const violation = r.errors.find((e) => e.code === 'capability_violation');
      expect(violation?.message).toContain(message);
      expect(violation?.path).toMatch(/^handlers\[0\]\.uses\[\d\]$/);
    }
  });

  it('refuses a stream route handler that declares rights without blob', () => {
    const r = parseSpec(
      spec(
        '  - { id: h, module: h.mjs, export: h, kind: route, uses: [bindings] }\n',
        "  - { method: POST, path: '/x/{id}', action: { kind: stream, handler: h, mode: ingest } }\n",
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => [e.code, e.path])).toContainEqual([
        'capability_violation',
        'handlers[0].uses',
      ]);
    }
  });

  it('leaves a handler without uses exactly as before', () => {
    const r = parseSpec(spec('  - { id: t, module: h.mjs, export: t, kind: tool }\n'));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.value.handlers[0]?.uses).toBeUndefined();
  });
});
