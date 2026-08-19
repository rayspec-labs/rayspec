/**
 * `rayspec tenant erase` — the OPERATOR SURFACE for the tenant data-erasure control seam (L2-2).
 *
 * WHAT THIS SUITE EXISTS TO PIN. The seam (`BootedServer.eraseTenantNow`) is wired on every boot and
 * has been correct for several PRs; what it had was no way to reach it — no HTTP route and no CLI
 * verb — so exercising it meant writing a private embedder. This command is that path, and because it
 * is a path to an IRREVERSIBLE act, the surface itself carries three properties that are all
 * negative and therefore all easy to lose silently:
 *
 *   1. A REFUSED INVOCATION NEVER REACHES THE SEAM. Every usage arm asserts the injected
 *      implementation recorded ZERO calls — not merely that an error was thrown. A parser that
 *      validated after calling would still throw and would still be catastrophically wrong.
 *   2. THE DEFAULT IS A PREVIEW. Without `--confirm` the command passes `dryRun: true`. The arm
 *      reads the ARGUMENT the seam was handed, so it fails against an implementation that decides
 *      later, or reports "dry-run" while asking for a delete.
 *   3. THE OUTCOME IS ECHOED, NEVER RE-DERIVED. `mode` on the output is the seam's own `mode`. The
 *      fake below is ADVERSARIAL about exactly this: it answers a confirmed erase request with a
 *      gate-disabled dry-run — the shipped shape when `RAYSPEC_ERASURE_ENABLED` is anything but the
 *      exact string `"true"` — so a command that concluded "the operator asked to erase, therefore
 *      it erased" reports success against a database that still holds every row.
 *
 * The fake is adversarial in one further way, on the same reasoning as the `tenant ensure` suite: it
 * returns a result object carrying the connection string in a field no type declares, so the
 * "no secret reaches a stream" arm fails against a `{ ...result }` spread and can only pass because
 * the mapping copies field by field.
 *
 * The usage arms drive the same `main()` the shipped bin does, so the exit codes are the shipped
 * mapping (2 = usage, 1 = operational, 0 = ok).
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../index.js';
import { runTenantErase } from './erase.js';
import { TenantCliError } from './errors.js';

const DB_URL = 'postgres://erase-user:erase-pass@erase-host:5432/erase-db';
const ORG_ID = '5c1a7b90-3d2e-4f61-8a0b-7e6d5c4b3a29';
const OTHER_ID = '11111111-2222-4333-8444-555555555555';
const REASON = 'GDPR erasure request TCK-4711';

const state = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  /** What the fake seam answers with. Overwritten per arm. */
  reply: undefined as unknown,
}));

/**
 * The seam's answer, carrying `databaseUrl` in a field `TenantEraseReport` does not declare — the
 * runtime shape a structural pass-through would publish. The type is what the command is being
 * tested for, not what it is allowed to assume.
 */
function leakyReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gate: false,
    auditRequestId: 'a1b2c3d4-0000-4000-8000-000000000001',
    databaseUrl: DB_URL,
    result: {
      mode: 'dry-run',
      dryRunReason: 'gate-disabled',
      tables: {},
      totalRows: 0,
      coreTables: { runs: 3, run_events: 12 },
      coreTotalRows: 15,
      blobs: 'no-backend',
      databaseUrl: DB_URL,
    },
    ...over,
  };
}

vi.mock('@rayspec/server', () => ({
  eraseTenantData: async (input: Record<string, unknown>) => {
    state.calls.push(input);
    return state.reply ?? leakyReport();
  },
}));

/** The injected stand-in used by the direct (non-`main`) arms — same recorder, no module mocking. */
const spyImpl = (async (input: Record<string, unknown>) => {
  state.calls.push(input);
  return (state.reply ?? leakyReport()) as never;
}) as never;

let outChunks: string[];
let errChunks: string[];
let savedSkipDotenv: string | undefined;

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  state.calls = [];
  state.reply = undefined;
  savedSkipDotenv = process.env.RAYSPEC_SKIP_DOTENV;
  process.env.RAYSPEC_SKIP_DOTENV = '1';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    outChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    errChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedSkipDotenv === undefined) delete process.env.RAYSPEC_SKIP_DOTENV;
  else process.env.RAYSPEC_SKIP_DOTENV = savedSkipDotenv;
});

describe('the verb exists at all — the L2-2 gap', () => {
  it('`tenant erase` is dispatched, not refused as an unknown subcommand', async () => {
    // The RED this whole item is built on: at f658e09 the dispatcher knew exactly one subcommand and
    // answered anything else with "unknown tenant subcommand … (expected `ensure`)".
    const code = await main(['tenant', 'erase', '--org-id', ORG_ID]);
    expect(errChunks.join('')).not.toContain('unknown tenant subcommand');
    expect(code).toBe(0);
  });
});

describe('a refused invocation never reaches the seam', () => {
  it('refuses a missing --org-id, having called nothing', async () => {
    await expect(runTenantErase([], { eraseImpl: spyImpl })).rejects.toBeInstanceOf(TenantCliError);
    expect(state.calls).toEqual([]);
  });

  it('refuses an --org-id that is not an org UUID, having called nothing', async () => {
    await expect(
      runTenantErase(['--org-id', 'acme'], { eraseImpl: spyImpl }),
    ).rejects.toBeInstanceOf(TenantCliError);
    expect(state.calls).toEqual([]);
  });

  it('refuses a --confirm that names a DIFFERENT org than --org-id, having called nothing', async () => {
    // The explicit-ask key. A confirmation that is not compared to the target is not a confirmation:
    // it degrades to "pass any value here", which is what a copy-pasted command line always has.
    await expect(
      runTenantErase(['--org-id', ORG_ID, '--confirm', OTHER_ID, '--reason', REASON], {
        eraseImpl: spyImpl,
      }),
    ).rejects.toBeInstanceOf(TenantCliError);
    expect(state.calls).toEqual([]);
  });

  /**
   * THE COMPARISON IS EXACT, AND THAT IS ASSERTED AGAINST THE NEAR MISSES — not against a wholly
   * different UUID.
   *
   * A review found this hole and it is the sharpest kind: the arm above passes against a comparison
   * that is `startsWith`, `includes`, a case-fold, or a length-truncated compare, because
   * `OTHER_ID` fails all of those too. So the arm proved "the confirm is looked at", never "the
   * confirm must be the WHOLE id". For the one control whose entire job is to make an irreversible
   * act deliberate, "looked at" is not the property — a single character passing a confirmation
   * dialog is the classic form of this bug.
   *
   * So the values below are the confirmation's equivalent of the operator gate's five near-misses:
   * every one is a string a loosened comparison would accept and an exact one must refuse.
   */
  const CONFIRM_NEAR_MISSES: readonly { readonly label: string; readonly value: string }[] = [
    { label: 'one character (a startsWith/prefix compare accepts this)', value: '5' },
    { label: 'a proper prefix', value: ORG_ID.slice(0, ORG_ID.length - 1) },
    { label: 'the first block only', value: ORG_ID.split('-')[0] as string },
    { label: 'a proper suffix (an endsWith compare accepts this)', value: ORG_ID.slice(1) },
    { label: 'a substring (an includes compare accepts this)', value: ORG_ID.slice(4, 20) },
    { label: 'the id with one extra character', value: `${ORG_ID}0` },
    {
      label: 'the id upper-cased (a case-folding compare accepts this)',
      value: ORG_ID.toUpperCase(),
    },
    { label: 'the empty string is a PREVIEW, never a confirmation', value: '' },
  ];

  it.each(
    CONFIRM_NEAR_MISSES,
  )('a --confirm that is $label never reaches the seam as an erasure', async ({ value }) => {
    // The empty string is the one member that is not an ERROR — it is the absent-confirm case, so
    // it must fall through to a PREVIEW. Both outcomes are "this did not erase anything", which is
    // the property under test; what must never happen is a `dryRun: false` call.
    try {
      await runTenantErase(['--org-id', ORG_ID, '--confirm', value, '--reason', REASON], {
        eraseImpl: spyImpl,
      });
    } catch (e) {
      expect(e).toBeInstanceOf(TenantCliError);
    }
    for (const call of state.calls) {
      expect(call.dryRun, `--confirm ${JSON.stringify(value)} produced an ERASE request`).toBe(
        true,
      );
    }
  });

  it('ACCEPT CONTROL — the exact id IS accepted, so the arms above are not refusing everything', async () => {
    // Without this, a parser that refused every --confirm would satisfy the whole table above.
    const out = await runTenantErase(
      ['--org-id', ORG_ID, '--confirm', ORG_ID, '--reason', REASON],
      { eraseImpl: spyImpl },
    );
    expect(out.requested).toBe('erase');
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ dryRun: false });
  });

  it('refuses --confirm without --reason, having called nothing', async () => {
    await expect(
      runTenantErase(['--org-id', ORG_ID, '--confirm', ORG_ID], { eraseImpl: spyImpl }),
    ).rejects.toBeInstanceOf(TenantCliError);
    expect(state.calls).toEqual([]);
  });

  it('refuses a positional argument, having called nothing', async () => {
    await expect(runTenantErase([ORG_ID], { eraseImpl: spyImpl })).rejects.toBeInstanceOf(
      TenantCliError,
    );
    expect(state.calls).toEqual([]);
  });

  it('surfaces every one of those through the shipped main() as the usage error it maps to exit 2', async () => {
    // `main` THROWS `CliError` for a usage problem and the bin maps it to exit 2 (index.test.ts pins
    // that mapping). What matters here is that each refusal travels the usage path — and that the
    // seam is still untouched after all four.
    await expect(main(['tenant', 'erase'])).rejects.toThrow(/--org-id <uuid> is required/);
    await expect(main(['tenant', 'erase', '--org-id', 'acme'])).rejects.toThrow(
      /must be an org UUID/,
    );
    await expect(
      main(['tenant', 'erase', '--org-id', ORG_ID, '--confirm', OTHER_ID]),
    ).rejects.toThrow(/--confirm must repeat --org-id exactly/);
    await expect(
      main(['tenant', 'erase', '--org-id', ORG_ID, '--confirm', ORG_ID]),
    ).rejects.toThrow(/--reason <text> is required with --confirm/);
    expect(state.calls).toEqual([]);
  });
});

describe('the dry-run / real distinction is carried by the argument, not by prose', () => {
  it('WITHOUT --confirm the seam is asked for a dry run', async () => {
    const out = await runTenantErase(['--org-id', ORG_ID], { eraseImpl: spyImpl });
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ orgId: ORG_ID, dryRun: true, journalScrub: false });
    expect(out.requested).toBe('preview');
  });

  it('WITH --confirm + --reason the seam is asked for a real erasure, carrying the reason', async () => {
    const out = await runTenantErase(
      ['--org-id', ORG_ID, '--confirm', ORG_ID, '--reason', REASON],
      { eraseImpl: spyImpl },
    );
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ orgId: ORG_ID, dryRun: false, reason: REASON });
    expect(out.requested).toBe('erase');
  });

  it('--journal-scrub reaches the seam', async () => {
    await runTenantErase(['--org-id', ORG_ID, '--journal-scrub'], { eraseImpl: spyImpl });
    expect(state.calls[0]).toMatchObject({ journalScrub: true });
  });
});

describe('the outcome is the seam’s, never the flags’', () => {
  it('a confirmed erasure the GATE refused is ok:false / exit 1, naming the gate', async () => {
    // The fake answers the shipped gate-disabled shape. A command that concluded "erase was
    // requested, therefore erase happened" passes nothing here.
    const code = await main([
      'tenant',
      'erase',
      '--org-id',
      ORG_ID,
      '--confirm',
      ORG_ID,
      '--reason',
      REASON,
    ]);
    expect(code).toBe(1);
    const parsed = JSON.parse(outChunks.join('')) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.dryRunReason).toBe('gate-disabled');
    expect(parsed.gate).toBe(false);
    expect(JSON.stringify(parsed.errors)).toContain('RAYSPEC_ERASURE_ENABLED');
  });

  it('a PREVIEW that came back as a dry run is ok:true / exit 0 — it did what was asked', async () => {
    state.reply = leakyReport({
      result: {
        mode: 'dry-run',
        dryRunReason: 'dry-run-requested',
        tables: {},
        totalRows: 0,
        coreTables: { runs: 3 },
        coreTotalRows: 3,
        blobs: 'no-backend',
      },
    });
    const code = await main(['tenant', 'erase', '--org-id', ORG_ID]);
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join('')) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.requested).toBe('preview');
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.dryRunReason).toBe('dry-run-requested');
  });

  it('a real deletion is ok:true / exit 0 with the counts passed through verbatim', async () => {
    state.reply = leakyReport({
      gate: true,
      result: {
        mode: 'deleted',
        tables: { notes: 4 },
        totalRows: 4,
        coreTables: { runs: 3, run_events: 12 },
        coreTotalRows: 15,
        blobs: 'deleted',
      },
    });
    const code = await main([
      'tenant',
      'erase',
      '--org-id',
      ORG_ID,
      '--confirm',
      ORG_ID,
      '--reason',
      REASON,
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(outChunks.join('')) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('deleted');
    expect(parsed.gate).toBe(true);
    expect(parsed.tables).toEqual({ notes: 4 });
    expect(parsed.coreTables).toEqual({ runs: 3, run_events: 12 });
    expect(parsed.totalRows).toBe(4);
    expect(parsed.coreTotalRows).toBe(15);
    expect(parsed.blobs).toBe('deleted');
    expect(parsed).not.toHaveProperty('dryRunReason');
  });
});

/**
 * The flags of the ONE irreversible command the CLI has, checked against both places that describe
 * them. Nothing regenerates either, so without this a flag added to the parser reaches `--help`
 * (assembled from the command's own block) while the reference stays silent — and for THIS command a
 * flag nobody documents is a safety nobody knows to use. Both directions are checked, because the
 * opposite drift (a documented flag the parser does not take) is what sends an operator down a path
 * that exits 2. Names are matched whole-token, so `--reason` is never satisfied by a longer spelling.
 */
describe('the tenant erase surface vs its documentation', () => {
  const FLAGS = ['org-id', 'confirm', 'reason', 'journal-scrub'] as const;
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const wholeToken = (text: string, flag: string): boolean =>
    new RegExp(`--${flag}(?![\\w-])`).test(text);

  /** The synopsis fence under the `tenant erase` heading in docs/cli-reference.md. */
  function synopsisFence(): string {
    const doc = read('../../../../../docs/cli-reference.md');
    const heading = doc.indexOf('## `tenant erase`');
    expect(heading, 'the tenant erase heading moved or was reworded').toBeGreaterThan(-1);
    const section = doc.slice(heading, doc.indexOf('\n## ', heading + 1));
    const fence = /```\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(fence, 'no synopsis fence under the tenant erase heading').toBeDefined();
    return fence as string;
  }

  /** The `tenant erase` help block in the CLI's own usage text. */
  function helpBlock(): string {
    const source = read('../index.ts');
    const at = source.indexOf('rayspec tenant erase --org-id');
    expect(at, 'the tenant erase help block moved').toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('`,', at));
  }

  it('the declared set really is the set the parser accepts (invented flags refused)', async () => {
    // The accept control: without it the list below could name a flag the parser never took, and
    // every documentation arm would be checking a fiction. A flag either takes a value or does not,
    // so both spellings are tried; what disqualifies a name is the parser calling it UNKNOWN, not a
    // later semantic refusal (`--confirm <id>` without `--reason` is a legal parse and a usage error).
    const parserRejects = async (argv: readonly string[]): Promise<boolean> => {
      try {
        await runTenantErase(argv, { eraseImpl: spyImpl });
        return false;
      } catch (e) {
        return /invalid arguments/i.test(e instanceof Error ? e.message : String(e));
      }
    };
    for (const flag of FLAGS) {
      const valued = await parserRejects(['--org-id', ORG_ID, `--${flag}`, ORG_ID]);
      const bare = await parserRejects(['--org-id', ORG_ID, `--${flag}`]);
      expect(valued && bare, `--${flag} is not a flag the tenant erase parser takes`).toBe(false);
    }
    expect(await parserRejects(['--org-id', ORG_ID, '--force'])).toBe(true);
    expect(await parserRejects(['--org-id', ORG_ID, '--force', 'yes'])).toBe(true);
  });

  it('every flag the parser declares is in the cli-reference synopsis AND the built-in help', () => {
    const fence = synopsisFence();
    const help = helpBlock();
    for (const flag of FLAGS) {
      expect(wholeToken(fence, flag), `--${flag} missing from the cli-reference synopsis`).toBe(
        true,
      );
      expect(wholeToken(help, flag), `--${flag} missing from the built-in help block`).toBe(true);
    }
  });

  it('every flag the synopsis advertises is one the parser declares', () => {
    const advertised = [...synopsisFence().matchAll(/--([a-z-]+)/g)].map((m) => m[1] as string);
    expect(advertised.length).toBeGreaterThan(0);
    for (const flag of advertised) {
      expect(
        (FLAGS as readonly string[]).includes(flag),
        `the synopsis advertises --${flag}, which the tenant erase parser does not declare`,
      ).toBe(true);
    }
  });

  it('both documents state the exact-string gate, so neither can drift into "truthy"', () => {
    // The one sentence an operator must not read a paraphrase of.
    expect(synopsisSection()).toContain('RAYSPEC_ERASURE_ENABLED');
    expect(helpBlock()).toContain('RAYSPEC_ERASURE_ENABLED');
    expect(helpBlock()).toContain('EXACTLY the string "true"');
  });

  /** The whole `tenant erase` section, for prose assertions rather than flag names. */
  function synopsisSection(): string {
    const doc = read('../../../../../docs/cli-reference.md');
    const heading = doc.indexOf('## `tenant erase`');
    return doc.slice(heading, doc.indexOf('\n## ', heading + 1));
  }
});

describe('nothing the seam hands back can leak onto a stream', () => {
  it('emits ONE object whose key set is the allowlist, with no connection string anywhere', async () => {
    const code = await main([
      'tenant',
      'erase',
      '--org-id',
      ORG_ID,
      '--confirm',
      ORG_ID,
      '--reason',
      REASON,
    ]);
    expect(code).toBe(1); // the fake's default is the gate-disabled shape
    const stdout = outChunks.join('');
    // The premise, asserted rather than assumed: the layer under test really was handed the secret.
    expect(leakyReport().databaseUrl).toBe(DB_URL);
    expect(stdout).not.toContain(DB_URL);
    expect(stdout).not.toContain('erase-pass');
    expect(errChunks.join('')).not.toContain('erase-pass');

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'auditRequestId',
        'blobs',
        'command',
        'coreTables',
        'coreTotalRows',
        'dryRunReason',
        'errors',
        'gate',
        'mode',
        'ok',
        'orgId',
        'requested',
        'tables',
        'totalRows',
      ].sort(),
    );
    expect(parsed.command).toBe('tenant erase');
    expect(parsed.orgId).toBe(ORG_ID);
  });
});
