#!/usr/bin/env node
/**
 * Behaviour test for the advisory→issue sync (`sync-advisory-issues.mjs`).
 *
 * The sync script is the only part of the scheduled dependency-advisory workflow that carries
 * logic, and the thing it does — writing to the repository's issue tracker — is exactly the thing
 * that must not be discovered to be wrong in production. So it is driven here end-to-end with the
 * `gh` boundary MOCKED: a stub executable named `gh` is placed FIRST on the child's PATH, records
 * every invocation (argv plus the contents of any `--body-file`), and answers `label list` /
 * `issue list` from the case's fixture. No test-only flag or seam exists in the script itself.
 *
 * The properties that matter, each a real failure mode:
 *
 *   (D) DEDUPLICATION — one advisory that hits TWO packages is ONE issue, not two, and the single
 *       body names both packages. A per-package filer would open an issue storm for one advisory.
 *   (M) THE BODY IS WELL-FORMED MARKDOWN — the blank lines that separate the lead sentence, the
 *       bullet list, the affected-package table, the `### What to do` heading and the footer are
 *       load-bearing: without them markdown swallows the table and the footer into the preceding
 *       list item as lazy continuation and prints them as raw pipes. Asserting that a package name
 *       appears SOMEWHERE in the body does not catch that, so the block structure is pinned here —
 *       for a full advisory and for a bare one, where absent optional bullets are dropped.
 *   (U) UPDATE, NEVER DUPLICATE — with an open issue already carrying the advisory's title, the run
 *       EDITS it and creates nothing. Re-filing weekly is how a tracker becomes unusable.
 *   (Q) A CLEAN RUN IS SILENT — a scanner report with no matches performs ZERO `gh` calls: no
 *       issue, no comment, not even a read. A routine that reports every week is ignored by the
 *       second week.
 *   (L) THE LABEL IS ENSURED, AND IS NEVER A SINGLE POINT OF FAILURE — the label is created when it
 *       is missing, and when the label operation is refused outright the finding is STILL filed
 *       (unlabeled) and the run still exits 0. A finding must never be lost to label bookkeeping.
 *
 * Plus (S) SHELL SAFETY: advisory text is untrusted input from a public database. A summary full of
 * `$(…)`, backticks and quotes must reach the issue body VERBATIM and execute nothing — the script
 * passes argv vectors (never a shell string) and hands long text over via a file.
 *
 * Standalone (no test framework is wired for the repo scripts): `node <thisfile>`; exit 0 = pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'sync-advisory-issues.mjs');
const REPO = 'rayspec-labs/rayspec';
const ADVISORY = 'GHSA-9999-test-0000';
const TITLE = `Dependency advisory: ${ADVISORY}`;

// ── the `gh` test double ────────────────────────────────────────────────────────────────────────
// Logs one JSON line per invocation, then answers the two read commands from the environment.
// `label list` also reports labels created earlier in the SAME run, so the script's create→re-read
// ensure is exercised against a store that actually changes.
const FAKE_GH = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const LOG = process.env.FAKE_GH_LOG;
const refuse = (process.env.FAKE_GH_REFUSE ?? '').split(',').filter(Boolean);

const bodyAt = argv.indexOf('--body-file');
const body = bodyAt >= 0 && argv[bodyAt + 1] ? readFileSync(argv[bodyAt + 1], 'utf8') : null;
appendFileSync(LOG, JSON.stringify({ argv, body }) + '\\n');

const readLog = () =>
  (existsSync(LOG) ? readFileSync(LOG, 'utf8') : '').split('\\n').filter(Boolean).map(JSON.parse);

const [group, verb] = argv;
if (refuse.includes(group)) {
  process.stderr.write('fake gh: ' + group + ' refused\\n');
  process.exit(1);
}
if (group === 'label' && verb === 'list') {
  const seeded = JSON.parse(process.env.FAKE_GH_LABELS ?? '[]');
  const created = readLog()
    .filter((e) => e.argv[0] === 'label' && e.argv[1] === 'create')
    .map((e) => ({ name: e.argv[2] }));
  process.stdout.write(JSON.stringify([...seeded, ...created]));
  process.exit(0);
}
if (group === 'issue' && verb === 'list') {
  process.stdout.write(process.env.FAKE_GH_ISSUES ?? '[]');
  process.exit(0);
}
if (group === 'label' && verb === 'create') process.exit(0);
if (group === 'issue' && (verb === 'create' || verb === 'edit')) {
  process.stdout.write('https://github.test/issues/1\\n');
  process.exit(0);
}
process.stderr.write('fake gh: unexpected invocation: ' + argv.join(' ') + '\\n');
process.exit(64);
`;

const workspaces = [];

/** Fresh throwaway workspace holding the scanner report, the `gh` double and the call log. */
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-advisory-sync-'));
  workspaces.push(dir);
  const ghPath = join(dir, 'gh');
  writeFileSync(ghPath, FAKE_GH);
  chmodSync(ghPath, 0o755);
  return dir;
}

/** Drive the REAL script with `gh` shadowed on PATH; return exit code, streams and the call log. */
function runSync(report, { labels = ['dependencies'], issues = [], refuse = [] } = {}) {
  const dir = workspace();
  const input = join(dir, 'osv-advisories.json');
  const log = join(dir, 'gh-calls.log');
  writeFileSync(input, JSON.stringify(report));
  writeFileSync(log, '');
  const res = spawnSync('node', [SCRIPT, '--input', input, '--repo', REPO], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      FAKE_GH_LOG: log,
      FAKE_GH_LABELS: JSON.stringify(labels.map((name) => ({ name }))),
      FAKE_GH_ISSUES: JSON.stringify(issues),
      FAKE_GH_REFUSE: refuse.join(','),
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return { dir, code: res.status, out: res.stdout ?? '', err: res.stderr ?? '', calls };
}

/** Calls matching a `gh` sub-command, e.g. verbs('issue', 'create'). */
const verbs = (calls, group, verb) =>
  calls.filter((c) => c.argv[0] === group && c.argv[1] === verb);

/** A scanner report where ONE advisory matches TWO distinct lockfile packages. */
function reportOneAdvisoryTwoPackages(summary = 'Prototype pollution in the affected versions.') {
  const vuln = {
    id: ADVISORY,
    aliases: ['CVE-9999-00000'],
    summary,
    database_specific: { severity: 'HIGH' },
  };
  const pkg = (name, version) => ({
    package: { name, version, ecosystem: 'npm' },
    vulnerabilities: [vuln],
    groups: [{ ids: [ADVISORY], max_severity: '7.5' }],
  });
  return {
    results: [
      {
        source: { path: 'pnpm-lock.yaml', type: 'lockfile' },
        packages: [pkg('left-pad', '1.0.0'), pkg('right-pad', '2.0.0')],
      },
    ],
  };
}

/** A scanner report carrying an advisory with NO aliases, severity or summary — the case where the
 *  optional bullets are dropped and could take the structural blank lines with them. */
function reportBareAdvisory() {
  return {
    results: [
      {
        source: { path: 'pnpm-lock.yaml', type: 'lockfile' },
        packages: [
          {
            package: { name: 'left-pad', version: '1.0.0', ecosystem: 'npm' },
            vulnerabilities: [{ id: ADVISORY }],
          },
        ],
      },
    ],
  };
}

/** Assert the issue body's block structure: every separator that markdown needs is present. */
function assertWellFormedBody(body, label) {
  assert.match(
    body,
    /lockfile\.\n\n- \*\*Advisory:\*\* /,
    `${label} the bullet list must start its own block, or it joins the lead paragraph`,
  );
  assert.match(
    body,
    /\n\n\| Package \| Version \| Ecosystem \| Source \|\n\| --- \| --- \| --- \| --- \|\n/,
    `${label} the table must be preceded by a blank line and its own header row, or GFM renders it as raw pipes inside the last bullet`,
  );
  assert.match(
    body,
    /\n\n### What to do\n\n1\. /,
    `${label} the heading must be isolated by blank lines on both sides`,
  );
  assert.match(
    body,
    /\n\n_Last observed: /,
    `${label} the footer must be its own block, not a continuation of the numbered list`,
  );
}

try {
  // ── (M) the body is well-formed markdown, with and without the optional bullets ────────────────
  {
    const full = runSync(reportOneAdvisoryTwoPackages());
    assert.equal(
      full.code,
      0,
      `(M) the sync must exit 0 on a finding; got ${full.code}: ${full.err}`,
    );
    const [fullCall] = verbs(full.calls, 'issue', 'create');
    assert.ok(fullCall, '(M) the advisory must be filed');
    assertWellFormedBody(fullCall.body, '(M/full)');

    const bare = runSync(reportBareAdvisory());
    assert.equal(bare.code, 0, `(M) a bare advisory must exit 0; got ${bare.code}: ${bare.err}`);
    const [bareCall] = verbs(bare.calls, 'issue', 'create');
    assert.ok(bareCall, '(M) the bare advisory must be filed');
    assertWellFormedBody(bareCall.body, '(M/bare)');
    assert.doesNotMatch(
      bareCall.body,
      /^- \*\*(Aliases|Severity|Summary)/m,
      '(M) an absent optional field must leave no bullet behind',
    );
    assert.doesNotMatch(
      bareCall.body,
      /\n\n\n/,
      '(M) a dropped optional bullet must not leave a double blank line',
    );
    console.log('ok (M) — the issue body keeps its markdown block structure, bullets or not');
  }

  // ── (D) one advisory across two packages → exactly ONE issue, naming both packages ─────────────
  {
    const r = runSync(reportOneAdvisoryTwoPackages());
    assert.equal(r.code, 0, `(D) the sync must exit 0 on a finding; got ${r.code}: ${r.err}`);
    const created = verbs(r.calls, 'issue', 'create');
    assert.equal(
      created.length,
      1,
      `(D) one advisory must file exactly ONE issue, got ${created.length}: ${r.err}`,
    );
    assert.equal(verbs(r.calls, 'issue', 'edit').length, 0, '(D) nothing to edit on a first sight');
    const [call] = created;
    assert.ok(call.argv.includes(TITLE), `(D) the title must key on the advisory id: ${call.argv}`);
    assert.ok(call.argv.includes('dependencies'), '(D) the issue must carry the label');
    assert.match(call.body, /left-pad/, '(D) the body must name the first affected package');
    assert.match(call.body, /right-pad/, '(D) the body must name the second affected package');
    console.log('ok (D) — one advisory across two packages files exactly one issue');
  }

  // ── (U) an open issue for the same advisory → EDIT, never a second issue ───────────────────────
  {
    const open = [
      { number: 42, title: TITLE },
      { number: 7, title: 'Something else entirely' },
    ];
    const r = runSync(reportOneAdvisoryTwoPackages(), { issues: open });
    assert.equal(r.code, 0, `(U) the sync must exit 0; got ${r.code}: ${r.err}`);
    assert.equal(
      verbs(r.calls, 'issue', 'create').length,
      0,
      `(U) an advisory with an open issue must NEVER be filed twice: ${r.err}`,
    );
    const edited = verbs(r.calls, 'issue', 'edit');
    assert.equal(
      edited.length,
      1,
      `(U) the open issue must be refreshed once, got ${edited.length}`,
    );
    assert.ok(
      edited[0].argv.includes('42'),
      `(U) the existing issue must be the target: ${edited[0].argv}`,
    );
    console.log('ok (U) — an existing open issue is refreshed, not duplicated');
  }

  // ── (Q) a clean report → not a single `gh` call ────────────────────────────────────────────────
  {
    const r = runSync({ results: [{ source: { path: 'pnpm-lock.yaml' }, packages: [] }] });
    assert.equal(r.code, 0, `(Q) a clean run must exit 0; got ${r.code}: ${r.err}`);
    assert.equal(
      r.calls.length,
      0,
      `(Q) a clean run must be completely silent, got ${r.calls.length} gh call(s): ${JSON.stringify(r.calls)}`,
    );
    console.log('ok (Q) — a clean run performs zero gh calls');
  }

  // ── (L) the label does not exist yet → it is created once, and the issue still gets it ─────────
  {
    const r = runSync(reportOneAdvisoryTwoPackages(), { labels: ['bug', 'enhancement'] });
    assert.equal(r.code, 0, `(L) a missing label must not fail the run; got ${r.code}: ${r.err}`);
    const madeLabel = verbs(r.calls, 'label', 'create');
    assert.equal(
      madeLabel.length,
      1,
      `(L) the missing label must be created once, got ${madeLabel.length}`,
    );
    assert.ok(
      madeLabel[0].argv.includes('dependencies'),
      '(L) the created label must be `dependencies`',
    );
    const created = verbs(r.calls, 'issue', 'create');
    assert.equal(created.length, 1, '(L) the finding must still be filed');
    assert.ok(created[0].argv.includes('dependencies'), '(L) the filed issue must carry the label');
    console.log('ok (L) — a missing label is created, and the finding is filed with it');
  }

  // ── (L2) the label operation is refused outright → the finding is STILL filed, unlabeled ───────
  {
    const r = runSync(reportOneAdvisoryTwoPackages(), { labels: [], refuse: ['label'] });
    assert.equal(r.code, 0, `(L2) a refused label must not fail the run; got ${r.code}: ${r.err}`);
    const created = verbs(r.calls, 'issue', 'create');
    assert.equal(created.length, 1, `(L2) the finding must still be filed, got ${created.length}`);
    assert.equal(
      created[0].argv.includes('--label'),
      false,
      `(L2) an unavailable label must be dropped, not passed: ${created[0].argv}`,
    );
    console.log(
      'ok (L2) — a refused label degrades to an unlabeled issue, never to a lost finding',
    );
  }

  // ── (S) untrusted advisory text is inert: it reaches the body verbatim and executes nothing ────
  {
    const dirProbe = 'advisory-sync-probe';
    const hostile = `Broken "quoting" $(touch /tmp/${dirProbe}); \`touch /tmp/${dirProbe}\`; rm -rf .`;
    const r = runSync(reportOneAdvisoryTwoPackages(hostile));
    assert.equal(
      r.code,
      0,
      `(S) hostile advisory text must not fail the run; got ${r.code}: ${r.err}`,
    );
    assert.equal(
      existsSync(join('/tmp', dirProbe)),
      false,
      '(S) advisory text must never be interpreted by a shell',
    );
    const [call] = verbs(r.calls, 'issue', 'create');
    assert.ok(call, '(S) the advisory must still be filed');
    assert.ok(call.body.includes('$(touch'), '(S) the text must reach the body verbatim');
    console.log('ok (S) — untrusted advisory text is carried as data, never as a command');
  }

  console.log('\nadvisory→issue sync: ALL CASES PASSED');
} finally {
  for (const d of workspaces) rmSync(d, { recursive: true, force: true });
}
