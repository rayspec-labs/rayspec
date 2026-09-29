/**
 * Budgets: one test per reader limit, the operation-dependent archive limit of the first step,
 * the cumulative extracted bytes, and the time budget. Limits can only be lowered; a raised one is
 * a usage error.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BundleError } from '@rayspec/bundle-contract';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_TIME_BUDGET_MS, extractBundle, inspectBundle } from './index.js';
import { loadExpectations } from './test-support/contract.js';
import { baseFiles, bundleEntries, rawZip } from './test-support/raw-zip.js';

const expectations = loadExpectations();
const app = rawZip(bundleEntries(expectations));
const migration = rawZip(bundleEntries(expectations, { kind: 'migration' }));
const payloadBytes = [...baseFiles(expectations).values()].reduce((n, b) => n + b.length, 0);

const outcome = (r: { ok: true } | { ok: false; errors: BundleError[] }) =>
  r.ok ? 'ok' : `${r.errors[0]!.code}/${r.errors[0]!.reason ?? ''}`;

const sandboxes: string[] = [];
afterAll(() => {
  for (const s of sandboxes) rmSync(s, { recursive: true, force: true });
});
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-bundle-budget-'));
  sandboxes.push(dir);
  return dir;
}

describe('the archive limit of the first step', () => {
  it('applies before the end record is looked for', async () => {
    const garbage = Buffer.alloc(4096, 0x41);
    expect(
      outcome(
        await inspectBundle(garbage, { limits: { archiveBytes: 100, migrationArchiveBytes: 100 } }),
      ),
    ).toBe('RAY_LIMIT_EXCEEDED/archive-size');
    expect(outcome(await inspectBundle(garbage))).toBe('RAY_INVALID_ARCHIVE/not-a-zip');
  });

  it('inspect and verify take the larger of the two kind limits', async () => {
    const limits = { archiveBytes: 64 };
    for (const operation of ['inspect', 'verify'] as const) {
      expect(outcome(await inspectBundle(migration, { limits, operation }))).toBe('ok');
    }
  });

  it('deploy and prepare take the application limit, whatever the kind', async () => {
    const limits = { archiveBytes: 64 };
    for (const operation of ['deploy', 'prepare'] as const) {
      expect(outcome(await inspectBundle(migration, { limits, operation }))).toBe(
        'RAY_LIMIT_EXCEEDED/archive-size',
      );
    }
    expect(outcome(await inspectBundle(app, { operation: 'deploy' }))).toBe('ok');
  });

  it('import takes the migration limit', async () => {
    const limits = { migrationArchiveBytes: 64 };
    expect(outcome(await inspectBundle(app, { limits, operation: 'import' }))).toBe(
      'RAY_LIMIT_EXCEEDED/archive-size',
    );
    expect(outcome(await inspectBundle(app, { limits, operation: 'inspect' }))).toBe('ok');
  });

  it('once the kind is known, the limit of that kind applies', async () => {
    expect(outcome(await inspectBundle(app, { limits: { archiveBytes: app.length - 1 } }))).toBe(
      'RAY_LIMIT_EXCEEDED/archive-size',
    );
    expect(outcome(await inspectBundle(app, { limits: { archiveBytes: app.length } }))).toBe('ok');
    expect(
      outcome(
        await inspectBundle(migration, { limits: { migrationArchiveBytes: migration.length - 1 } }),
      ),
    ).toBe('RAY_LIMIT_EXCEEDED/archive-size');
  });
});

describe('per-limit refusals', () => {
  it('entry count: the end record announces more entries than the limit', async () => {
    const entries = bundleEntries(expectations).length;
    expect(outcome(await inspectBundle(app, { limits: { entryCount: entries - 1 } }))).toBe(
      'RAY_LIMIT_EXCEEDED/entry-count',
    );
    expect(outcome(await inspectBundle(app, { limits: { entryCount: entries } }))).toBe('ok');
  });

  it('manifest size: checked before the manifest is read or parsed', async () => {
    const entries = bundleEntries(expectations);
    const manifest = entries.find((e) => e.name === 'ray.json')!;
    const size = Buffer.byteLength(manifest.data as string);
    expect(outcome(await inspectBundle(app, { limits: { manifestBytes: size - 1 } }))).toBe(
      'RAY_LIMIT_EXCEEDED/manifest-size',
    );
    expect(outcome(await inspectBundle(app, { limits: { manifestBytes: size } }))).toBe('ok');
    // Not JSON at all, and still refused for its size first.
    manifest.data = 'x'.repeat(64);
    expect(outcome(await inspectBundle(rawZip(entries), { limits: { manifestBytes: 63 } }))).toBe(
      'RAY_LIMIT_EXCEEDED/manifest-size',
    );
  });

  it('path length: the longest name is one byte over the limit', async () => {
    const longest = Math.max(...bundleEntries(expectations).map((e) => Buffer.byteLength(e.name)));
    expect(outcome(await inspectBundle(app, { limits: { pathBytes: longest - 1 } }))).toBe(
      'RAY_LIMIT_EXCEEDED/path-length',
    );
    expect(outcome(await inspectBundle(app, { limits: { pathBytes: longest } }))).toBe('ok');
  });

  it('JSON depth: the manifest nests deeper than the limit', async () => {
    expect(outcome(await inspectBundle(app, { limits: { jsonDepth: 2 } }))).toBe(
      'RAY_LIMIT_EXCEEDED/json-depth',
    );
    expect(outcome(await inspectBundle(app, { limits: { jsonDepth: 3 } }))).toBe('ok');
  });
});

describe('cumulative extracted bytes', () => {
  it('refuses when the entries add up past the limit though each is under it', async () => {
    const largest = Math.max(...[...baseFiles(expectations).values()].map((b) => b.length));
    const limit = payloadBytes - 1;
    expect(largest).toBeLessThan(limit);
    expect(outcome(await inspectBundle(app, { limits: { extractedBytes: limit } }))).toBe(
      'RAY_LIMIT_EXCEEDED/extracted-size',
    );
    expect(outcome(await inspectBundle(app, { limits: { extractedBytes: payloadBytes } }))).toBe(
      'ok',
    );
  });

  it('an extraction refused for it leaves nothing behind', async () => {
    const dir = sandbox();
    const r = await extractBundle(app, join(dir, 'out'), {
      limits: { extractedBytes: payloadBytes - 1 },
    });
    expect(outcome(r)).toBe('RAY_LIMIT_EXCEEDED/extracted-size');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a migration bundle counts against the migration limit', async () => {
    const ciphertext = [...baseFiles(expectations, 'migration').values()][0]!.length;
    expect(
      outcome(
        await inspectBundle(migration, { limits: { migrationExtractedBytes: ciphertext - 1 } }),
      ),
    ).toBe('RAY_LIMIT_EXCEEDED/extracted-size');
    expect(outcome(await inspectBundle(migration, { limits: { extractedBytes: 0 } }))).toBe('ok');
  });
});

describe('the time budget', () => {
  /** A clock that stands still for `calls` readings and then jumps past any budget. */
  const jumpingClock = (calls: number) => {
    let n = 0;
    return () => (n++ < calls ? 0 : 10 * DEFAULT_TIME_BUDGET_MS);
  };

  it('refuses a read that outlasts the budget', async () => {
    expect(outcome(await inspectBundle(app, { clock: jumpingClock(1), timeBudgetMs: 1000 }))).toBe(
      'RAY_LIMIT_EXCEEDED/time-budget',
    );
  });

  it('is checked while entries stream, not only at the start', async () => {
    // Count the readings a full read takes, then let the clock jump on the last of them.
    let readings = 0;
    const counting = () => {
      readings++;
      return 0;
    };
    expect(outcome(await inspectBundle(app, { clock: counting, timeBudgetMs: 1000 }))).toBe('ok');
    expect(readings).toBeGreaterThan(bundleEntries(expectations).length);
    expect(
      outcome(await inspectBundle(app, { clock: jumpingClock(readings - 1), timeBudgetMs: 1000 })),
    ).toBe('RAY_LIMIT_EXCEEDED/time-budget');
  });

  it('an extraction that runs out of time leaves nothing behind', async () => {
    let readings = 0;
    await inspectBundle(app, {
      clock: () => {
        readings++;
        return 0;
      },
    });
    const dir = sandbox();
    const r = await extractBundle(app, join(dir, 'out'), {
      clock: jumpingClock(readings - 1),
      timeBudgetMs: 1000,
    });
    expect(outcome(r)).toBe('RAY_LIMIT_EXCEEDED/time-budget');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a real clock with the default budget reads the base bundle', async () => {
    expect(outcome(await inspectBundle(app))).toBe('ok');
  });
});

describe('limits can only be lowered', () => {
  it.each([
    ['archiveBytes', 512 * 1024 * 1024 + 1],
    ['migrationArchiveBytes', 2 * 1024 * 1024 * 1024 + 1],
    ['extractedBytes', 512 * 1024 * 1024 + 1],
    ['migrationExtractedBytes', 2 * 1024 * 1024 * 1024 + 1],
    ['entryCount', 10_001],
    ['manifestBytes', 1024 * 1024 + 1],
    ['pathBytes', 4097],
    ['jsonDepth', 65],
    ['entryCount', -1],
    ['pathBytes', 1.5],
  ])('%s = %s is a usage error', async (key, value) => {
    expect(outcome(await inspectBundle(app, { limits: { [key]: value } }))).toBe('RAY_USAGE/');
    expect(
      outcome(await extractBundle(app, join(sandbox(), 'out'), { limits: { [key]: value } })),
    ).toBe('RAY_USAGE/');
  });

  it.each([
    DEFAULT_TIME_BUDGET_MS + 1,
    -1,
    0.5,
    Number.NaN,
  ])('a time budget of %s is a usage error', async (timeBudgetMs) => {
    expect(outcome(await inspectBundle(app, { timeBudgetMs }))).toBe('RAY_USAGE/');
  });

  it('an unknown operation is a usage error', async () => {
    expect(outcome(await inspectBundle(app, { operation: 'upload' as never }))).toBe('RAY_USAGE/');
  });
});
