/**
 * `rayspec` CLI entrypoint — exit-code + argv contract + drain-safe stdout.
 *
 * `main(args)` is the testable CLI body: it RETURNS a numeric exit code (0 ok · 1 not-ok spec/plan)
 * and THROWS a `CliError` for a usage/argument problem (which the top-level maps to exit 2). We drive
 * it in-process with an EXPLICIT arg vector and capture stdout/stderr:
 *  - a valid spec → 0, the ok:true JSON on stdout (not stderr);
 *  - an invalid spec → 1, the ok:false JSON on STDOUT (it is the command's normal output, exit 1);
 *  - a missing command → throws CliError (exit 2), nothing on stdout;
 *  - an unknown command → throws CliError (exit 2);
 *  - an unknown `--flag` → throws CliError (exit 2) (strict parseArgs);
 *  - the top-level `--version`/`-v` → 0, the version JSON on stdout, nothing on stderr;
 *  - `--help`/`-h`, at every level → 0, the help text on stdout, nothing on stderr.
 *
 * emit uses a drain callback, so a large payload is flushed before exit — we assert the JSON is
 * COMPLETE (parses + closing brace present), not truncated.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEPLOY_ARG_OPTIONS, parseDeployArgs } from './deploy.js';
import { main, run } from './index.js';

const VALID_SPEC = `
version: '1.0'
metadata:
  name: index-test
stores:
  - name: things
    columns:
      - { name: title, type: text }
`;

let dir: string;
let prevCwd: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-index-'));
  writeFileSync(join(dir, 'rayspec.yaml'), VALID_SPEC, 'utf8');
  writeFileSync(join(dir, 'bad.yaml'), "version: '1.0'\nmetadata: { name: x }\nbogus: 1\n", 'utf8');
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

let outChunks: string[];
let errChunks: string[];

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  // Capture stdout/stderr. Our writes use the (string, callback) form (drain-safe) — invoke the cb.
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
});

describe('main — exit codes + stream routing', () => {
  it('valid spec (doctor) → 0, complete JSON on stdout, nothing on stderr', async () => {
    const code = await main(['doctor', 'rayspec.yaml']);
    expect(code).toBe(0);
    const out = outChunks.join('');
    expect(errChunks.join('')).toBe('');
    // Complete (not truncated) JSON.
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
  });

  it('valid spec (plan, no shadow) → 0', async () => {
    // Force no-shadow by DELETING the env for this call (the run path reads process.env; assigning
    // `undefined` would set the literal string "undefined"). A no-shadow plan needs no DB.
    const prev = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL;
    try {
      const code = await main(['plan', 'rayspec.yaml']);
      expect(code).toBe(0);
      expect(JSON.parse(outChunks.join('')).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prev;
    }
  });

  it('invalid spec → 1, the ok:false JSON on STDOUT (not stderr)', async () => {
    const code = await main(['doctor', 'bad.yaml']);
    expect(code).toBe(1);
    const parsed = JSON.parse(outChunks.join(''));
    expect(parsed.ok).toBe(false);
    expect(errChunks.join('')).toBe('');
  });

  it('missing command → throws CliError (→ exit 2), nothing on stdout', async () => {
    await expect(main([])).rejects.toThrow(/missing command/i);
    expect(outChunks.join('')).toBe('');
  });

  it('unknown command → throws CliError (→ exit 2)', async () => {
    await expect(main(['frobnicate', 'rayspec.yaml'])).rejects.toThrow(/unknown command/i);
    expect(outChunks.join('')).toBe('');
  });

  it('unknown --flag → throws CliError (→ exit 2)', async () => {
    await expect(main(['doctor', '--nope', 'rayspec.yaml'])).rejects.toThrow(/invalid arguments/i);
    expect(outChunks.join('')).toBe('');
  });
});

describe('run — CliError → exit 2 mapping (IDX-EXIT2-1)', () => {
  // `run()` is the top-level runner: it sets process.exitCode (2 for a CliError, else main's 0/1) and
  // routes the error to stderr. Save/restore exitCode so an assertion never leaks into the runner.
  let prevExit: number | string | undefined;
  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = prevExit;
  });

  it('a missing command → exit 2, the cliError JSON on STDERR (not stdout)', async () => {
    await run([]);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toBe('');
    const err = errChunks.join('');
    expect(JSON.parse(err.split('\n')[0] as string).ok).toBe(false);
    expect(err).toMatch(/missing command/i);
  });

  it('an unknown command → exit 2', async () => {
    await run(['frobnicate', 'rayspec.yaml']);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toBe('');
    expect(errChunks.join('')).toMatch(/unknown command/i);
  });

  it('an unknown --flag → exit 2', async () => {
    await run(['doctor', '--nope', 'rayspec.yaml']);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toMatch(/^$/);
    expect(errChunks.join('')).toMatch(/invalid arguments/i);
  });

  it('a valid spec → exit 0 via run()', async () => {
    await run(['doctor', 'rayspec.yaml']);
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(outChunks.join('')).ok).toBe(true);
  });

  it('a not-ok spec → exit 1 via run() (the ok:false JSON on stdout)', async () => {
    await run(['doctor', 'bad.yaml']);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(outChunks.join('')).ok).toBe(false);
    expect(errChunks.join('')).toBe('');
  });
});

describe('run — the top-level --version flag', () => {
  // The version the CLI must report, read from ITS OWN manifest rather than pinned as a literal, so a
  // release version bump cannot leave this assertion asserting a stale string. Resolved relative to
  // this file (one directory below the package root) and NOT against the cwd — these tests run with
  // the cwd moved into a scratch directory, which is exactly the situation an installed CLI is in.
  const manifestVersion = (
    JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: unknown;
    }
  ).version;

  let prevExit: number | string | undefined;
  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = prevExit;
  });

  it('the manifest under test actually carries a version (the fixture itself)', () => {
    expect(typeof manifestVersion).toBe('string');
    expect(manifestVersion).not.toBe('');
  });

  for (const flag of ['--version', '-v'] as const) {
    it(`\`${flag}\` → exit 0, exactly one JSON object on stdout, NOTHING on stderr`, async () => {
      await run([flag]);
      expect(process.exitCode).toBe(0);
      // The two streams are measured separately: the version goes to stdout, stderr stays silent.
      expect(errChunks.join('')).toBe('');
      const out = outChunks.join('');
      // Parsing the WHOLE of stdout is the "exactly one object" assertion: a second object appended
      // to the first is not a valid JSON document, so this fails if anything else is written.
      expect(JSON.parse(out)).toEqual({ ok: true, version: manifestVersion });
      expect(out.endsWith('}\n')).toBe(true);
    });
  }

  // The accept/reject control: answering `--version` must not turn the leading-dash check into a
  // catch-all that swallows a genuine usage error. Both halves of the exit-2 contract stay pinned.
  it('an unknown leading flag → exit 2, the usage envelope on stderr, nothing on stdout', async () => {
    await run(['--nope']);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toBe('');
    const err = errChunks.join('');
    expect(JSON.parse(err.split('\n')[0] as string)).toMatchObject({ ok: false });
    expect(err).toMatch(/expected a subcommand/i);
    expect(err).toContain('got --nope');
    expect(err).toContain('rayspec — RaySpec CLI');
  });

  // `--version` is answered before the leading-dash check, so it must not become a hole in the
  // grammar the exit-2 row describes: a token after it is refused rather than silently ignored.
  for (const extra of ['--nope', 'extra'] as const) {
    it(`\`--version ${extra}\` → exit 2, nothing on stdout`, async () => {
      await run(['--version', extra]);
      expect(process.exitCode).toBe(2);
      expect(outChunks.join('')).toBe('');
      const err = errChunks.join('');
      expect(JSON.parse(err.split('\n')[0] as string)).toMatchObject({ ok: false });
      expect(err).toContain('rayspec — RaySpec CLI');
    });
  }

  it('an unknown subcommand → exit 2, the usage envelope on stderr, nothing on stdout', async () => {
    await run(['frobnicate']);
    expect(process.exitCode).toBe(2);
    expect(outChunks.join('')).toBe('');
    const err = errChunks.join('');
    expect(JSON.parse(err.split('\n')[0] as string)).toMatchObject({ ok: false });
    expect(err).toMatch(/unknown command/i);
    expect(err).toContain('rayspec — RaySpec CLI');
  });
});

/**
 * `--help`/`-h` is a HELP REQUEST, not a usage error.
 *
 * Three separate code paths used to reject it — the top-level leading-dash check, each subcommand's
 * strict `parseArgs`, and the `tenant`/`dev` group dispatchers — so every spelling is measured on BOTH
 * halves of the observable contract: the exit code AND which stream carried the bytes. The accept
 * control lives alongside: a genuine usage error must still be exit 2 with the `cliError` envelope on
 * stderr, or a catch-all "answer help" would pass these arms while breaking the grammar.
 */
describe('run — `--help`/`-h` at every level', () => {
  let prevExit: number | string | undefined;
  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = prevExit;
  });

  // Every spelling the CLI must answer: the two top-level ones, each subcommand, both groups, and the
  // group MEMBERS (`dev db`, `tenant ensure`) — the sub-subcommand level a group dispatcher owns.
  const SPELLINGS: readonly (readonly string[])[] = [
    ['--help'],
    ['-h'],
    ['init', '--help'],
    ['doctor', '--help'],
    ['plan', '--help'],
    ['openapi', '--help'],
    ['gen-handler', '--help'],
    ['deploy', '--help'],
    ['deploy', '-h'],
    ['tenant', '--help'],
    ['dev', '--help'],
    ['tenant', 'ensure', '--help'],
    ['dev', 'gen-secrets', '--help'],
    ['dev', 'db', '--help'],
    ['dev', 'db', '-h'],
    ['dev', 'bootstrap-tenant', '--help'],
  ];

  for (const args of SPELLINGS) {
    it(`\`rayspec ${args.join(' ')}\` → exit 0, help on STDOUT, nothing on stderr`, async () => {
      await run([...args]);
      expect(process.exitCode).toBe(0);
      expect(errChunks.join('')).toBe('');
      const out = outChunks.join('');
      // stdout is non-empty and is the help text — not a JSON envelope.
      expect(out.length).toBeGreaterThan(0);
      expect(out.startsWith('rayspec')).toBe(true);
      expect(out).toContain('RaySpec CLI');
    });
  }

  it('`deploy --help` is SCOPED to deploy: its own flags, not the general manual', async () => {
    await run(['deploy', '--help']);
    const out = outChunks.join('');
    for (const flag of [
      '--dry-run',
      '--check-env',
      '--port',
      '--host',
      '--apply-migration',
      '--allowlist',
    ]) {
      expect(out, `deploy's help must name ${flag}`).toContain(flag);
    }
    // The whole manual would carry these; deploy's own block does not.
    expect(out).not.toContain('GET STARTED:');
    expect(out).not.toContain('rayspec dev gen-secrets');
    expect(out).not.toContain('rayspec tenant ensure --org-id');
  });

  it('a GROUP answers for its members; a member answers for itself alone', async () => {
    await run(['dev', '--help']);
    const group = outChunks.join('');
    for (const member of ['dev gen-secrets', 'dev db', 'dev bootstrap-tenant']) {
      expect(group).toContain(`rayspec ${member}`);
    }

    outChunks.length = 0;
    process.exitCode = undefined;
    await run(['dev', 'db', '--help']);
    const one = outChunks.join('');
    expect(one).toContain('rayspec dev db [--database-url <url>]');
    expect(one).not.toContain('rayspec dev gen-secrets');
    expect(one).not.toContain('rayspec dev bootstrap-tenant');
  });

  // The composition property the per-command split exists for: each command is described in ONE
  // block, and the general usage is that same block re-composed. An edit to a command's entry
  // therefore reaches both surfaces, and neither can drift from the other.
  it('the general usage CONTAINS, verbatim, the block each scoped help prints', async () => {
    await run(['--help']);
    const general = outChunks.join('');
    const commands = [
      'init',
      'doctor',
      'plan',
      'openapi',
      'gen-handler',
      'deploy',
      'tenant ensure',
      'dev gen-secrets',
      'dev db',
      'dev bootstrap-tenant',
    ];
    for (const command of commands) {
      outChunks.length = 0;
      process.exitCode = undefined;
      await run([...command.split(' '), '--help']);
      // Strip the scoped header (title, blank, section heading) and the footer (blank, the two
      // output-contract lines, the "run --help" pointer, the trailing newline) — what is left is the
      // command's block.
      const block = outChunks.join('').split('\n').slice(3, -5).join('\n');
      expect(block.length, `${command} has an empty help block`).toBeGreaterThan(0);
      expect(general, `the general usage lost ${command}'s block`).toContain(block);
    }
  });

  // ACCEPT CONTROL — answering help must not become a catch-all that swallows a genuine usage error.
  const USAGE_ERRORS: readonly (readonly string[])[] = [
    ['frobnicate'], // an unknown subcommand
    ['doctor', '--nope'], // a genuinely unknown option
    ['dev', 'frobnicate'], // an unknown sub-subcommand in a group
    ['frobnicate', '--help'], // help NAMED on something that does not exist
    ['doctor', '--help', '--nope'], // a token after the help flag is refused, like `--version`
  ];

  for (const args of USAGE_ERRORS) {
    it(`\`rayspec ${args.join(' ')}\` is still exit 2 with the cliError envelope on stderr`, async () => {
      await run([...args]);
      expect(process.exitCode).toBe(2);
      expect(outChunks.join('')).toBe('');
      const err = errChunks.join('');
      expect(JSON.parse(err.split('\n')[0] as string)).toMatchObject({ ok: false });
      expect(err).toContain('rayspec — RaySpec CLI');
    });
  }

  // Past the command path, the top level hands the vector over unparsed — so a `-h` there is still
  // the command's own token and still resolves through the command's own strict parser, unchanged.
  it('a `-h` past the command path is left to the command that owns it', async () => {
    await expect(main(['plan', 'rayspec.yaml', '--against', '-h'])).rejects.toThrow(
      /invalid arguments/i,
    );
    expect(outChunks.join('')).toBe('');
  });
});

describe('main — plan update-mode flags (--against / --allowlist) through the real arg parser', () => {
  const OLD = `
version: '1.0'
metadata: { name: index-update }
stores:
  - name: things
    columns:
      - { name: title, type: text }
      - { name: note, type: text }
`;
  const NEW_DROP = `
version: '1.0'
metadata: { name: index-update }
stores:
  - name: things
    columns:
      - { name: title, type: text }
`;

  beforeAll(() => {
    writeFileSync(join(dir, 'upd-old.yaml'), OLD, 'utf8');
    writeFileSync(join(dir, 'upd-new.yaml'), NEW_DROP, 'utf8');
  });

  it('a destructive --against delta is BLOCKED (exit 1); feeding --allowlist the proposal makes it pass (exit 0)', async () => {
    const prev = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL; // no shadow ⇒ no DB needed
    try {
      // 1) BLOCKED without an allowlist — the flags parsed + dispatched to update mode.
      const blocked = await main(['plan', 'upd-new.yaml', '--against', 'upd-old.yaml']);
      expect(blocked).toBe(1);
      const blockedJson = JSON.parse(outChunks.join(''));
      expect(blockedJson.ok).toBe(false);
      expect(blockedJson.updateMode).toBe(true);
      expect(blockedJson.breakingChangeBlocked).toBe(true);

      // 2) Write the machine-proposed allowlist to a file, feed it via --allowlist → PASSES (exit 0).
      writeFileSync(join(dir, 'al.json'), JSON.stringify(blockedJson.proposedAllowlist), 'utf8');
      outChunks.length = 0;
      const passed = await main([
        'plan',
        'upd-new.yaml',
        '--against',
        'upd-old.yaml',
        '--allowlist',
        'al.json',
      ]);
      expect(passed).toBe(0);
      expect(JSON.parse(outChunks.join('')).ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prev;
    }
  });

  it('an unknown flag on plan is still a strict usage error (exit 2 via CliError)', async () => {
    await expect(main(['plan', 'upd-new.yaml', '--bogus'])).rejects.toThrow(/invalid arguments/i);
  });
});

describe('main — drain-safe stdout (no truncation)', () => {
  it('emits a complete, parseable JSON payload (closing brace present)', async () => {
    const prev = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL;
    try {
      await main(['plan', 'rayspec.yaml']);
      const out = outChunks.join('');
      expect(out.trimEnd().endsWith('}')).toBe(true);
      expect(() => JSON.parse(out)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prev;
    }
  });
});

/**
 * The `tenant` group's DISPATCH — the top level routes `tenant` to its own group and maps a usage
 * problem inside it to exit 2, exactly as it does for `dev`. The group is PRODUCTION-MUTATING, so it
 * sits at the top level rather than under `dev` (which is documented as local-dev only); these arms
 * pin that it is reachable and that the top level's enumerations name it, without reaching a database.
 */
describe('main — the tenant command group is dispatched from the top level', () => {
  it('a bare `tenant` is a usage error naming the group (exit 2), and nothing is emitted', async () => {
    await expect(main(['tenant'])).rejects.toThrow(/missing tenant subcommand/i);
    expect(outChunks.join('')).toBe('');
  });

  it('an unknown tenant subcommand is a usage error naming the group', async () => {
    await expect(main(['tenant', 'frobnicate'])).rejects.toThrow(/unknown tenant subcommand/i);
    expect(outChunks.join('')).toBe('');
  });

  it('the top-level enumerations name `tenant` on both the missing and the unknown path', async () => {
    await expect(main([])).rejects.toThrow(/`tenant`/);
    await expect(main(['frobnicate'])).rejects.toThrow(/`tenant`/);
  });
});

describe('docs/cli-reference.md — the --version example does not go stale', () => {
  it("the version in the reference's example equals the CLI's own manifest version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const doc = readFileSync(new URL('../../../../docs/cli-reference.md', import.meta.url), 'utf8');
    // The reference prints one worked example of the envelope. Nothing regenerates it, so without
    // this lock a release bump leaves the document naming a version the CLI no longer reports.
    const shown = /\{\s*"ok":\s*true,\s*"version":\s*"([^"]+)"\s*\}/.exec(doc);
    expect(shown, 'the --version example was not found in docs/cli-reference.md').not.toBeNull();
    expect((shown as RegExpExecArray)[1]).toBe(manifest.version);
  });
});

/**
 * `deploy`'s DOCUMENTED flags, checked against the flags it actually takes.
 *
 * The reference describes deploy's flags as prose — a synopsis block and a `Flags:` summary sentence —
 * and nothing regenerates either, so a flag added to the parser reaches `--help` (which is assembled
 * from the command's own block) while the document stays silent. `--host` shipped that way. The
 * option set is IMPORTED from the one place the grammar is declared, `DEPLOY_ARG_OPTIONS`
 * (`deploy.ts`).
 *
 * Two opposite drifts can put a flag outside these arms, and each needs its own guard. A name in the
 * set that the parser does NOT take is caught by re-proving every name against the live parser, with
 * an invented flag as the accept control. A flag the parser DOES take that the set never yields is
 * invisible to that loop — it is the one that would quietly shrink the coverage — so the pass-through
 * the set relies on is asserted directly: `parseDeployArgs`'s `parseArgs` call must hand
 * `DEPLOY_ARG_OPTIONS` over by name, with nothing merged into it. That plus `strict: true` is what
 * makes the declared set the set deploy accepts.
 *
 * The NAMES come from the declaration rather than from the file's source text, which is what makes
 * these arms independent of how `deploy.ts` is written. They previously recovered the names with a
 * regular expression over that source, so a comment written next to an option — or a key placed
 * before `type` — dropped a flag from the set and turned a formatting choice in the parser into a
 * failure of a documentation check. The pass-through assertion still reads that source, but only for
 * the one token that hands the declaration to `parseArgs`; it never looks at the option entries.
 *
 * What these arms pin is each flag's PRESENCE in the synopsis and in the summary. The per-flag bullets
 * are deliberately not covered: `--port` and `--allowlist` carry none, so demanding a bullet per flag
 * would fail on the document as written.
 */
describe("docs/cli-reference.md — deploy's documented flags do not go stale", () => {
  const declaredFlags = Object.keys(DEPLOY_ARG_OPTIONS).map((name) => `--${name}`);
  const deploySrc = readFileSync(new URL('./deploy.ts', import.meta.url), 'utf8');
  const parseArgsCall = /parseArgs\(\{[\s\S]*?\n\s*\}\);/.exec(deploySrc)?.[0] ?? '';

  const doc = readFileSync(new URL('../../../../docs/cli-reference.md', import.meta.url), 'utf8');
  const heading = doc.indexOf('## `deploy` — boot and serve a declared product');
  const section = heading < 0 ? '' : doc.slice(heading, doc.indexOf('\n## ', heading + 1));
  const synopsis = /```\n([\s\S]*?)\n```/.exec(section)?.[1] ?? '';
  const flagsSummary = /\n- \*\*Flags:\*\*([\s\S]*?)\n- \*\*/.exec(section)?.[1] ?? '';

  // A flag counts as named only where the WHOLE token appears — `--host` must not be satisfied by a
  // longer `--host…` spelling that happens to start with it.
  const names = (text: string, flag: string): boolean => new RegExp(`${flag}(?![\\w-])`).test(text);

  it('the parser takes the declaration WHOLE — nothing is merged into it at the call', () => {
    expect(parseArgsCall, "parseDeployArgs's parseArgs call was not found in deploy.ts").not.toBe(
      '',
    );
    // The names below are the declaration's keys, so they are the flags deploy accepts only while
    // the parser is handed that declaration and nothing else. An option merged in here — `{
    // ...DEPLOY_ARG_OPTIONS, extra: … }` — would be a flag the parser takes that the set never
    // yields, and the per-name loop below cannot see it: the arms would simply check one flag less.
    expect(parseArgsCall).toMatch(/options:\s*DEPLOY_ARG_OPTIONS\s*[,}]/);
  });

  it('every name the declared set yields is a flag deploy accepts', () => {
    expect(declaredFlags.length).toBeGreaterThan(0);
    // The parser is strict, so acceptance is the proof a name is a real flag. A flag either takes a
    // value or does not; try both spellings before concluding it is rejected.
    const accepts = (flag: string): boolean =>
      [[flag], [flag, 'v']].some((argv) => {
        try {
          parseDeployArgs(argv);
          return true;
        } catch {
          return false;
        }
      });
    for (const flag of declaredFlags) expect(accepts(flag), `${flag} must parse`).toBe(true);
    // The accept control: without it, a parser that accepted anything would pass every arm above.
    expect(accepts('--frobnicate')).toBe(false);
  });

  it('`deploy --help` names every flag the parser accepts', async () => {
    expect(await main(['deploy', '--help'])).toBe(0);
    const out = outChunks.join('');
    for (const flag of declaredFlags) {
      expect(names(out, flag), `deploy's help must name ${flag}`).toBe(true);
    }
  });

  it("the reference's deploy synopsis names every flag the parser accepts", () => {
    expect(synopsis, 'the deploy synopsis block was not found in docs/cli-reference.md').not.toBe(
      '',
    );
    for (const flag of declaredFlags) {
      expect(names(synopsis, flag), `the deploy synopsis must name ${flag}`).toBe(true);
    }
  });

  it("the reference's deploy `Flags:` summary names every flag the parser accepts", () => {
    expect(
      flagsSummary,
      'the deploy `Flags:` summary was not found in docs/cli-reference.md',
    ).not.toBe('');
    for (const flag of declaredFlags) {
      expect(names(flagsSummary, flag), `the deploy \`Flags:\` summary must name ${flag}`).toBe(
        true,
      );
    }
  });
});
