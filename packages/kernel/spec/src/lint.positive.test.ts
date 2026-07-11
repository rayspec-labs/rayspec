/**
 * lintSpec POSITIVE cases — specs that are shape-valid AND semantically
 * valid must pass the full pipeline (parse → lint) with `ok:true`. These guard against an
 * over-eager linter (a false rejection) — the dual of the negative tests' false-acceptance guard.
 */
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';

describe('lintSpec — positive (valid specs pass the full pipeline)', () => {
  it('accepts a minimal spec (only version + metadata; all sections default to [])', () => {
    const res = parseSpec("version: '1.0'\nmetadata:\n  name: minimal\n");
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.stores).toEqual([]);
    expect(res.value.api).toEqual([]);
    expect(res.value.agents).toEqual([]);
    expect(res.value.tooling).toEqual([]);
    expect(res.value.triggers).toEqual([]);
    expect(res.value.handlers).toEqual([]);
  });

  it('accepts an optional deployment.durableWorker section', () => {
    const yaml = `
version: '1.0'
metadata:
  name: with-worker
deployment:
  durableWorker: true
`;
    const res = parseSpec(yaml);
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.deployment?.durableWorker).toBe(true);
  });

  it('leaves deployment undefined when the section is omitted (minimal spec stays valid)', () => {
    const res = parseSpec("version: '1.0'\nmetadata:\n  name: no-deployment\n");
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.deployment).toBeUndefined();
  });

  it('accepts a cron trigger WHEN deployment.durableWorker:true is declared', () => {
    // The cron→durableWorker coupling is satisfied — the cron is fired by the durable worker.
    const yaml = `
version: '1.0'
metadata:
  name: cron-with-worker
deployment:
  durableWorker: true
agents:
  - id: digest
    name: digest
    backend: openai
    model: gpt-4o-mini
    instructions: digest
triggers:
  - name: nightly
    kind: cron
    schedule: '0 2 * * *'
    action: { kind: agent, agent: digest }
`;
    const res = parseSpec(yaml);
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.triggers[0]?.kind).toBe('cron');
    expect(res.value.deployment?.durableWorker).toBe(true);
  });

  it('accepts a NON-cron trigger (event) without a durable worker (the coupling is cron-only)', () => {
    // Only `cron` triggers require the durable worker; an event/webhook/manual trigger does not.
    const yaml = `
version: '1.0'
metadata:
  name: event-no-worker
agents:
  - id: w
    name: w
    backend: openai
    model: m
    instructions: i
triggers:
  - name: on-thing
    kind: event
    event: thing.created
    action: { kind: agent, agent: w }
`;
    const res = parseSpec(yaml);
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.deployment).toBeUndefined();
  });

  it('accepts an emulated-structured-output agent on pi (NOT requiring native)', () => {
    // Pi has emulated structured output; without requireNativeStructuredOutput it is allowed.
    const yaml = `
version: '1.0'
metadata:
  name: emulated
agents:
  - id: emu
    name: emu
    backend: pi
    model: pi-model
    instructions: produce json
    requireNativeStructuredOutput: false
    outputSchema:
      name: result
      schema:
        type: object
`;
    const res = parseSpec(yaml);
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.agents[0]?.backend).toBe('pi');
  });

  it('accepts a fully cross-referenced spec (store FK, agent→tool→handler, agent route)', () => {
    const yaml = `
version: '1.0'
metadata:
  name: full
stores:
  - name: parents
    columns:
      - { name: label, type: text }
  - name: children
    columns:
      - { name: parent_id, type: uuid }
    foreignKeys:
      - { column: parent_id, references: parents }
api:
  - { method: GET, path: '/parents', action: { kind: store, store: parents, op: list } }
  - { method: POST, path: '/run', action: { kind: agent, agent: worker } }
  - { method: POST, path: '/custom', action: { kind: handler, handler: route_h } }
agents:
  - id: worker
    name: worker
    backend: anthropic
    model: claude-sonnet-4-6
    instructions: work
    tools: [fetch_thing]
tooling:
  - id: fetch_thing
    name: fetch_thing
    description: fetch
    parameters: { type: object }
    handler: tool_h
    idempotent: true
    timeoutMs: 2000
triggers:
  - name: t1
    kind: event
    event: thing.created
    action: { kind: agent, agent: worker }
handlers:
  - { id: tool_h, module: handlers/a.ts, export: a, kind: tool }
  - { id: route_h, module: handlers/b.ts, export: b, kind: route }
`;
    const res = parseSpec(yaml);
    if (!res.ok) throw new Error(`expected ok:\n${JSON.stringify(res.errors, null, 2)}`);
    expect(res.value.stores).toHaveLength(2);
    expect(res.value.api).toHaveLength(3);
    expect(res.value.triggers[0]?.event).toBe('thing.created');
  });

  it('aggregates MULTIPLE violations in one pass (not just the first)', () => {
    // Two independent dangling refs + a duplicate — all must be reported together.
    const yaml = `
version: '1.0'
metadata:
  name: multi
agents:
  - id: a
    name: a
    backend: openai
    model: m
    instructions: i
    tools: [ghost_tool]
  - id: a
    name: a2
    backend: openai
    model: m
    instructions: i
api:
  - { method: GET, path: '/x', action: { kind: store, store: ghost_store, op: list } }
`;
    const res = parseSpec(yaml);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const codes = res.errors.map((e) => e.code);
    expect(codes).toContain('duplicate_name'); // duplicate agent id 'a'
    expect(codes).toContain('dangling_ref'); // ghost_tool + ghost_store
    // At least 3 violations aggregated (1 dup + 2 dangling).
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });
});
