/**
 * The experimental `workforce:` opt-in at every CLI entry point — deterministic, no Postgres.
 * With the flag unset, a document declaring the section is rejected with the ONE typed code at
 * doctor, plan and deploy --dry-run (the fail-closed default any un-threaded surface inherits);
 * with the flag set, doctor and plan report the enabled section (the CLI's stderr banner keys on
 * that field) and plan notes the reserved `managed:` section in one neutral line either way.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { runDeploy } from './deploy.js';
import { runDoctor } from './doctor.js';
import { runPlan } from './plan.js';

const WORKFORCE_SPEC = `
version: '1.0'
metadata:
  name: workforce-flag-test
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
managed:
  editorRevision: 7
`;

const PLAIN_SPEC = `
version: '1.0'
metadata:
  name: plain
`;

let dir: string;
let prevCwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-workforce-flag-'));
  writeFileSync(join(dir, 'workforce.yaml'), WORKFORCE_SPEC, 'utf8');
  writeFileSync(join(dir, 'plain.yaml'), PLAIN_SPEC, 'utf8');
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const ON = { RAYSPEC_EXPERIMENTAL_WORKFORCE: '1' } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

describe('doctor', () => {
  it('rejects a workforce document with the typed code when the flag is unset', async () => {
    const result = await runDoctor(['workforce.yaml'], OFF);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'experimental_section_disabled', path: 'workforce' }),
    ]);
    expect(result.experimental).toBeUndefined();
  });

  it('accepts it under the flag and reports the enabled experimental section', async () => {
    const result = await runDoctor(['workforce.yaml'], ON);
    expect(result.ok).toBe(true);
    expect(result.experimental).toEqual(['workforce']);
  });

  it('a workforce-free document carries NO experimental field, flag or not', async () => {
    const off = await runDoctor(['plain.yaml'], OFF);
    const on = await runDoctor(['plain.yaml'], ON);
    expect(off).toEqual(on);
    expect(on.experimental).toBeUndefined();
  });
});

describe('plan', () => {
  it('rejects a workforce document with the typed code when the flag is unset', async () => {
    const result = await runPlan(['workforce.yaml'], { env: OFF });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'experimental_section_disabled', path: 'workforce' }),
    ]);
  });

  it('accepts it under the flag, reports the section, and notes managed: in one neutral line', async () => {
    const result = await runPlan(['workforce.yaml'], { env: ON });
    expect(result.ok).toBe(true);
    expect(result.experimental).toEqual(['workforce']);
    expect(result.managed).toEqual({
      present: true,
      note: expect.stringContaining('accepted and ignored'),
    });
  });

  it('a workforce-free document keeps its envelope byte-identical under the flag', async () => {
    const off = await runPlan(['plain.yaml'], { env: OFF });
    const on = await runPlan(['plain.yaml'], { env: ON });
    expect(on).toEqual(off);
    expect(on.experimental).toBeUndefined();
    expect(on.managed).toBeUndefined();
  });
});

describe('deploy --dry-run', () => {
  it('rejects a workforce document with the typed code when the flag is unset', async () => {
    // HERMETIC, like the `plan` siblings above. `runDeploy` takes no `env` argument (deploy.ts:256)
    // — its dry-run path reads `process.env` directly (deploy.ts, `experimentalSpecOptionsFromEnv(
    // process.env)`) — so the flag is stubbed OFF rather than passed in. Without this the arm reads
    // the AMBIENT environment, and a developer with RAYSPEC_EXPERIMENTAL_WORKFORCE=1 exported gets a
    // misleading `expected true to be false` against code that is working correctly. `vi.stubEnv` is
    // already the local idiom (the paired accept arm below uses it); `afterEach` unstubs.
    vi.stubEnv('RAYSPEC_EXPERIMENTAL_WORKFORCE', undefined);
    const outcome = await runDeploy(['--dry-run', 'workforce.yaml']);
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind !== 'dry-run') return;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.errors.join('\n')).toContain('experimental_section_disabled');
  });

  it('accepts it under the flag and names the live-only redeploy gate in notProven', async () => {
    vi.stubEnv('RAYSPEC_EXPERIMENTAL_WORKFORCE', '1');
    const outcome = await runDeploy(['--dry-run', 'workforce.yaml']);
    expect(outcome.kind).toBe('dry-run');
    if (outcome.kind !== 'dry-run') return;
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.notProven.join('\n')).toContain('workforce redeploy gate');
  });
});
