/**
 * VERSION-BUMP-RE-RECORD RULE — the enforced tripwire.
 *
 * The three agent SDKs churn. A recorded fixture is only trustworthy if it was captured against the
 * SAME SDK version that is currently INSTALLED — otherwise a real wire change passes a stale fixture
 * green (the recorded-fixture false-green risk). This suite TURNS A BUMP INTO A CAUGHT BREAK:
 *
 *   for each backend:  installed pinned version  ==  adapter constant  ==  fixture `sdkVersion` stamp.
 *
 * Bumping @openai/agents / @anthropic-ai/claude-agent-sdk / @earendil-works/pi-coding-agent in a
 * package.json WITHOUT re-recording the fixtures (which re-stamps the version) FAILS HERE in CI — the
 * deterministic gate, no creds needed. The last describe SIMULATES a mismatch to prove the assertion
 * is real (it actually fails on a divergence — not a tautology).
 *
 * Periodic live canary: the self-skipping live-smoke (live-smoke.test.ts) is the per-backend canary —
 * it runs the REAL SDK when creds are present and would surface a wire drift the fixture has not yet
 * caught. Cadence: run the live smoke (or re-capture) at least whenever a pin is bumped, and on a
 * periodic schedule (the docs own the calendar); this test is what BLOCKS a silent bump in between.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTHROPIC_SDK_VERSION } from '@rayspec/adapter-anthropic';
import { CODEX_SDK_VERSION } from '@rayspec/adapter-codex';
import { OPENAI_SDK_VERSION } from '@rayspec/adapter-openai';
import { PI_SDK_VERSION } from '@rayspec/adapter-pi';
import { describe, expect, it } from 'vitest';
import type { ParityBackend, ParityFixture } from './index.js';
import { installedSdkVersion, SDK_PACKAGE, versionMatches } from './sdk-versions.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/** The adapter-exported "recorded against" constant per backend (the single doc-first pinned value). */
const ADAPTER_CONSTANT: Record<ParityBackend, string> = {
  openai: OPENAI_SDK_VERSION,
  anthropic: ANTHROPIC_SDK_VERSION,
  pi: PI_SDK_VERSION,
  codex: CODEX_SDK_VERSION,
};

const FIXTURE_FILE: Record<ParityBackend, string> = {
  openai: 'openai-parity.json',
  anthropic: 'anthropic-parity.json',
  pi: 'pi-parity.json',
  codex: 'codex-parity.json',
};

function loadFixture(backend: ParityBackend): ParityFixture {
  return JSON.parse(
    readFileSync(join(fixturesDir, FIXTURE_FILE[backend]), 'utf8'),
  ) as ParityFixture;
}

const BACKENDS: ParityBackend[] = ['openai', 'anthropic', 'pi', 'codex'];

describe('version-bump rule: installed == adapter constant == fixture stamp (per backend)', () => {
  for (const backend of BACKENDS) {
    it(`${backend}: the INSTALLED pinned ${SDK_PACKAGE[backend]} version equals the adapter constant`, () => {
      // If the package.json pin is bumped but the adapter's *_SDK_VERSION constant is not, this fails —
      // forcing the engineer to update the constant (and, by the next assertion, re-record the fixture).
      expect(installedSdkVersion(backend)).toBe(ADAPTER_CONSTANT[backend]);
    });

    it(`${backend}: the committed fixture was RECORDED against the installed version (else re-record)`, () => {
      const fx = loadFixture(backend);
      // A fixture with NO version stamp is an older (or hand-edited) fixture — treat as a FAILURE
      // (it must be re-captured so the stamp exists), never a silent pass.
      expect(
        fx.sdkVersion,
        `${FIXTURE_FILE[backend]} has no sdkVersion stamp — re-record`,
      ).toBeTypeOf('string');
      expect(fx.sdkVersion).toBe(installedSdkVersion(backend));
      // The cross-backend stamp (every fixture records all three) must also match — a fixture captured
      // against an old multi-SDK set is stale even if its own backend matches.
      expect(fx.sdkVersions?.[backend]).toBe(installedSdkVersion(backend));
      // The SAME pure rule the tripwire block exercises: all three agree -> the fixture is trustworthy.
      expect(
        versionMatches(installedSdkVersion(backend), ADAPTER_CONSTANT[backend], fx.sdkVersion),
      ).toBe(true);
    });
  }
});

describe('version-bump rule: a SIMULATED bump WITHOUT a re-record FAILS (the tripwire is real)', () => {
  // Exercise the SAME `versionMatches` pure rule the real assertions use, on crafted
  // inputs — so "the tripwire is real" is proven by RUNNING the rule (it returns FAIL on a stale/
  // bumped input, PASS on matching), not by a self-comparing `x-BUMPED !== x` tautology.
  const installed = installedSdkVersion('openai');
  const constant = ADAPTER_CONSTANT.openai;

  it('PASS: when installed == constant == fixture stamp the rule holds', () => {
    expect(versionMatches(installed, constant, constant)).toBe(true);
  });

  it('FAIL: a STALE fixture stamp (SDK bumped, fixture not re-recorded) trips the rule', () => {
    // installed == constant (the adapter was updated) but the fixture still carries the OLD version.
    expect(versionMatches(installed, constant, '0.0.0-stale')).toBe(false);
  });

  it('FAIL: a package bump WITHOUT updating the adapter constant trips the rule', () => {
    // The package.json pin moved (installed has -BUMPED) but the adapter constant + fixture did not.
    expect(versionMatches(`${installed}-BUMPED`, constant, constant)).toBe(false);
  });

  it('FAIL: a MISSING fixture stamp (older / hand-edited fixture) trips the rule', () => {
    expect(versionMatches(installed, constant, undefined)).toBe(false);
  });
});
