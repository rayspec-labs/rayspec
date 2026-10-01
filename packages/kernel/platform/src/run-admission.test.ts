/**
 * The in-request run gate: a bounded number of slots, a refusal that names the bound when none is
 * free, and a release that gives the slot back exactly once.
 */
import { describe, expect, it } from 'vitest';
import { InRequestRunGate, RunAdmissionRefusedError } from './run-admission.js';

describe('InRequestRunGate', () => {
  it('admits up to the bound, refuses past it, and admits again once a slot is released', () => {
    const gate = new InRequestRunGate(2);
    const a = gate.acquire();
    gate.acquire();
    expect(gate.active).toBe(2);
    const refused = (() => {
      try {
        gate.acquire();
        return undefined;
      } catch (err) {
        return err;
      }
    })();
    expect(refused).toBeInstanceOf(RunAdmissionRefusedError);
    expect((refused as RunAdmissionRefusedError).scope).toBe('in-request');
    expect((refused as RunAdmissionRefusedError).message).toContain('RAYSPEC_AGENT_SYNC_RUNS_MAX');
    a();
    expect(gate.active).toBe(1);
    expect(() => gate.acquire()).not.toThrow();
  });

  it('a release called twice gives back one slot, not two', () => {
    const gate = new InRequestRunGate(1);
    const release = gate.acquire();
    release();
    release();
    expect(gate.active).toBe(0);
    gate.acquire();
    expect(() => gate.acquire()).toThrow(RunAdmissionRefusedError);
  });
});
