/**
 * The FORCING-FUNCTION test.
 *
 * This is the proof the six-section grammar is expressive against a REAL backend: it reads the
 * throwaway `examples/acme-notes-backend/rayspec.yaml` (authored OUTSIDE the platform) and asserts
 * `parseSpec` returns `ok:true` with ALL six sections populated and ALL cross-references resolved.
 * If the grammar were under-expressive, this test would fail at parse time — that is the point.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpec } from './parse.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/spec/src -> repo-root/examples/acme-notes-backend
const YAML_PATH = resolve(here, '../../../../examples/acme-notes-backend/rayspec.yaml');

describe('forcing function — the throwaway notebook backend', () => {
  const raw = readFileSync(YAML_PATH, 'utf8');
  const result = parseSpec(raw);

  it('parses ok (the grammar is expressive against a real backend)', () => {
    if (!result.ok) {
      // Surface the actual violations on failure so a regression is debuggable.
      throw new Error(`parseSpec failed:\n${JSON.stringify(result.errors, null, 2)}`);
    }
    expect(result.ok).toBe(true);
  });

  it('populates all six sections', () => {
    if (!result.ok) throw new Error('expected ok');
    const v = result.value;
    expect(v.stores.length).toBeGreaterThan(0);
    expect(v.api.length).toBeGreaterThan(0);
    expect(v.agents.length).toBeGreaterThan(0);
    expect(v.tooling.length).toBeGreaterThan(0);
    expect(v.triggers.length).toBeGreaterThan(0);
    expect(v.handlers.length).toBeGreaterThan(0);
  });

  it('has the child→parent FK (entries → notebooks, cascade)', () => {
    if (!result.ok) throw new Error('expected ok');
    const entries = result.value.stores.find((s) => s.name === 'entries');
    expect(entries).toBeDefined();
    expect(entries?.foreignKeys).toEqual([
      { column: 'notebook_id', references: 'notebooks', onDelete: 'cascade' },
    ]);
  });

  it('has an {agent} route action that resolves to the summarizer', () => {
    if (!result.ok) throw new Error('expected ok');
    const agentRoute = result.value.api.find((r) => r.action.kind === 'agent');
    expect(agentRoute).toBeDefined();
    if (agentRoute?.action.kind !== 'agent') throw new Error('expected agent action');
    expect(agentRoute.action.agent).toBe('summarizer');
    // The referenced agent is actually declared (cross-ref would have failed parse otherwise).
    expect(result.value.agents.some((a) => a.id === agentRoute.action.agent)).toBe(true);
  });

  it('resolves the agent→tool→handler chain', () => {
    if (!result.ok) throw new Error('expected ok');
    const v = result.value;
    const agent = v.agents.find((a) => a.id === 'summarizer');
    expect(agent?.tools).toContain('lookup_notebook');
    const tool = v.tooling.find((t) => t.id === 'lookup_notebook');
    expect(tool).toBeDefined();
    expect(tool?.idempotent).toBe(true);
    // The tool's handler resolves to a declared handler of kind 'tool'.
    const handler = v.handlers.find((h) => h.id === tool?.handler);
    expect(handler?.kind).toBe('tool');
  });

  it('parses the cron trigger with its schedule + a trigger-kind handler', () => {
    if (!result.ok) throw new Error('expected ok');
    const trigger = result.value.triggers.find((t) => t.name === 'nightly-digest');
    expect(trigger?.kind).toBe('cron');
    expect(trigger?.schedule).toBe('0 2 * * *');
    if (trigger?.action.kind !== 'handler') throw new Error('expected handler action');
    const handler = result.value.handlers.find((h) => h.id === trigger.action.handler);
    expect(handler?.kind).toBe('trigger');
  });
});
