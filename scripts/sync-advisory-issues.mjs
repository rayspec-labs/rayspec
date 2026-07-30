#!/usr/bin/env node
/**
 * sync-advisory-issues.mjs — turn an osv-scanner report into exactly one tracked issue per advisory.
 *
 * WHY THIS EXISTS. The dependency audit in ci.yml answers a question about a COMMIT: does the tree
 * being pushed carry a known-vulnerable dependency? OSV.dev, however, is a live database — an
 * advisory published today lands against a lockfile that has not changed in weeks, and between two
 * pushes nobody asks. The scheduled round in .github/workflows/dependency-advisories.yml asks on a
 * timer instead; this script is what turns its answer into something a human will actually see. An
 * e-mail notification leaves no trace in the repository and is skimmed past; an issue is a durable,
 * assignable, closable record.
 *
 * WHAT IT GUARANTEES.
 *   • ONE issue per advisory id, not one per affected package — a single advisory that matches five
 *     transitive copies is one issue whose body lists all five.
 *   • NEVER a duplicate. The issue title is `Dependency advisory: <id>`, and that title is the
 *     dedup key: an open issue already carrying it is EDITED (body refreshed to the current scan,
 *     label re-asserted) instead of a second one being opened. Do not rename these titles by hand —
 *     a renamed issue is invisible to the next run and will be re-filed.
 *   • SILENCE WHEN CLEAN. A report with no matches performs no GitHub call at all: no issue, no
 *     comment, no read. A routine that reports every week is ignored by the second week.
 *   • THE LABEL IS NEVER A SINGLE POINT OF FAILURE. The `dependencies` label is ensured
 *     idempotently (read, create if absent, re-read); if that fails for any reason the finding is
 *     still filed, unlabeled, with a warning. Losing a security finding to label bookkeeping would
 *     be absurd.
 *
 * UNTRUSTED INPUT. Advisory ids, summaries and package names come from a public database and are
 * treated as data throughout: every GitHub call is an argv vector handed to `execFileSync` (no
 * shell, so no interpolation and nothing to quote), issue bodies travel via `--body-file` rather
 * than an argument, control characters are stripped, fields are length-clamped, and an advisory id
 * that is not a plain identifier is skipped rather than sent onward — the id is the only untrusted
 * value that reaches an issue TITLE.
 *
 *   node scripts/sync-advisory-issues.mjs --input <osv-report.json> [--repo <owner/name>]
 *
 * `--repo` defaults to $GITHUB_REPOSITORY. Requires the `gh` CLI on PATH, authenticated with issue
 * write scope ($GH_TOKEN in CI). Exit 0 = the tracker matches the report (including "nothing to
 * do"); exit 1 = the sync itself could not be completed, which is a real CI failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LABEL = 'dependencies';
const LABEL_COLOR = '0366d6';
const LABEL_DESCRIPTION = 'Dependency advisories and dependency maintenance';
const TITLE_PREFIX = 'Dependency advisory: ';
// The advisory id becomes an issue title and the dedup key; accept only plain identifier shapes
// (GHSA-…, CVE-…, PYSEC-…, OSV-…) and refuse anything else rather than pass it on.
const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// gh paginates up to the limit; both reads are a single, generous page for a repo of this size.
const LIST_LIMIT = '500';
// The workflow environment, read in ONE place so this script's whole environment contract is
// visible at a glance: the repository default, and the run identity that links a filed issue back
// to the round that filed it. All three are absent in a local run, and all three are optional.
const env = process.env;

/** Print the failure and exit non-zero. A sync that could not run must never look like silence. */
function fail(message) {
  console.error(`advisory-issue sync FAILED: ${message}`);
  process.exit(1);
}

/** Read `--flag value` out of argv. */
function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** Strip control characters, collapse whitespace, clamp length. Applied to every scanner-supplied
 *  string before it reaches an issue. */
function clean(value, max) {
  return (
    String(value ?? '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  );
}

/** Escape the markdown characters that would break a table row. The backslash MUST be escaped
 *  first: escaping only the pipe turns an advisory's literal `\|` into `\\|`, where the `\\` is
 *  itself a complete escape and the pipe is left bare to split the row. */
const cell = (value) => value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

/** Run `gh` with an argv VECTOR — never a shell string, so untrusted text cannot become a command. */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// ── read the scanner report ─────────────────────────────────────────────────────────────────────
const input = flag('input');
if (!input) fail('missing --input <osv-report.json> (osv-scanner --format=json output).');

const repo = flag('repo') ?? env.GITHUB_REPOSITORY;
if (!repo) fail('missing --repo <owner/name> and no $GITHUB_REPOSITORY in the environment.');

let report;
try {
  report = JSON.parse(readFileSync(input, 'utf8'));
} catch (err) {
  // Fail closed: an unreadable report is NOT a clean scan, and must not be reported as one.
  fail(`cannot read/parse the scanner report at '${input}' (${err?.message ?? err}).`);
}

// ── collapse the per-package report into one entry per advisory ─────────────────────────────────
// osv-scanner reports findings package-first (results[].packages[].vulnerabilities[]); the same
// advisory therefore appears once per affected package. The tracker wants the opposite shape.
const byAdvisory = new Map();
const skipped = [];
for (const result of report?.results ?? []) {
  const source = clean(result?.source?.path ?? 'unknown', 200);
  for (const pkg of result?.packages ?? []) {
    const name = clean(pkg?.package?.name ?? 'unknown', 200);
    const version = clean(pkg?.package?.version ?? 'unknown', 100);
    const ecosystem = clean(pkg?.package?.ecosystem ?? 'unknown', 100);
    // Grouped severity, when the scanner computed one, is keyed by advisory id.
    const scores = new Map();
    for (const group of pkg?.groups ?? []) {
      for (const id of group?.ids ?? []) {
        if (group?.max_severity) scores.set(String(id), clean(group.max_severity, 20));
      }
    }
    for (const vuln of pkg?.vulnerabilities ?? []) {
      const id = String(vuln?.id ?? '');
      if (!ADVISORY_ID.test(id)) {
        skipped.push(clean(id, 80) || '(empty id)');
        continue;
      }
      let entry = byAdvisory.get(id);
      if (!entry) {
        entry = { id, summary: '', aliases: [], severity: '', packages: new Map() };
        byAdvisory.set(id, entry);
      }
      if (!entry.summary) entry.summary = clean(vuln?.summary, 400);
      if (!entry.severity) {
        entry.severity = clean(vuln?.database_specific?.severity ?? scores.get(id) ?? '', 40);
      }
      for (const alias of vuln?.aliases ?? []) {
        const a = clean(alias, 80);
        if (a && !entry.aliases.includes(a)) entry.aliases.push(a);
      }
      entry.packages.set(`${name}@${version}|${source}`, { name, version, ecosystem, source });
    }
  }
}

const advisories = [...byAdvisory.values()].sort((a, b) => a.id.localeCompare(b.id));

if (skipped.length > 0) {
  // Loud, but not fatal: the other advisories still deserve their issues.
  console.warn(
    `advisory-issue sync: skipped ${skipped.length} malformed advisory id(s): ${skipped.join(', ')}`,
  );
}

// A clean scan ends here, before any GitHub call. This is the "no news is no noise" contract.
if (advisories.length === 0) {
  console.log('advisory-issue sync: no advisories in the report — nothing to file.');
  process.exit(0);
}

// ── issue body ──────────────────────────────────────────────────────────────────────────────────
const observed = new Date().toISOString().slice(0, 10);
const runUrl =
  env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL
    ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
    : '';

function bodyFor(entry) {
  const rows = [...entry.packages.values()]
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map(
      (p) =>
        `| \`${cell(p.name)}\` | \`${cell(p.version)}\` | ${cell(p.ecosystem)} | \`${cell(p.source)}\` |`,
    );
  // `''` is a DELIBERATE blank line — markdown needs one to end a list and start a table, a heading
  // or a paragraph, or the block is swallowed as lazy continuation of the preceding list item. An
  // absent optional bullet is `null` instead, so that dropping it cannot drop a separator with it.
  return [
    `The scheduled dependency-advisory round matched **${entry.id}** against the committed lockfile.`,
    '',
    `- **Advisory:** https://osv.dev/vulnerability/${entry.id}`,
    entry.aliases.length > 0 ? `- **Aliases:** ${cell(entry.aliases.join(', '))}` : null,
    entry.severity ? `- **Severity (as reported by the scanner):** ${cell(entry.severity)}` : null,
    entry.summary ? `- **Summary:** ${cell(entry.summary)}` : null,
    '',
    '| Package | Version | Ecosystem | Source |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '### What to do',
    '',
    '1. Confirm the advisory applies: is the vulnerable code path actually reachable from this',
    '   project, and on the platform it runs on?',
    '2. If it applies, raise the dependency — a direct bump, or a `pnpm.overrides` pin when the',
    '   affected copy is transitive — then regenerate the dependency SBOM',
    '   (`pnpm install --frozen-lockfile && pnpm gen:dependency-sbom`) and note it under',
    '   **Security** in `CHANGELOG.md`.',
    '3. If it does not apply, record a scoped `[[IgnoredVulns]]` entry in `osv-scanner.toml` with a',
    '   `reason` and an `ignoreUntil` expiry — a precise, auditable exception rather than a lowered',
    '   threshold.',
    '4. Close this issue once the lockfile no longer matches the advisory. A later round re-files it',
    '   if it comes back.',
    '',
    `_Last observed: ${observed}${runUrl ? ` — [run log](${runUrl})` : ''}. This body is rewritten by each round; the title is the deduplication key, so do not rename it._`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

// ── the GitHub side ─────────────────────────────────────────────────────────────────────────────
/** True when the label exists on the repo. */
function labelExists() {
  const raw = gh(['label', 'list', '--repo', repo, '--json', 'name', '--limit', LIST_LIMIT]);
  return (JSON.parse(raw || '[]') ?? []).some((l) => l?.name === LABEL);
}

/** Ensure the label exists. Never throws: a label problem must not swallow a finding. */
function ensureLabel() {
  try {
    if (labelExists()) return true;
    try {
      gh([
        'label',
        'create',
        LABEL,
        '--repo',
        repo,
        '--description',
        LABEL_DESCRIPTION,
        '--color',
        LABEL_COLOR,
      ]);
    } catch {
      // Someone (or a concurrent round) may have created it in the meantime — settle it by re-reading.
    }
    return labelExists();
  } catch (err) {
    console.warn(
      `advisory-issue sync: cannot ensure the '${LABEL}' label (${err?.message ?? err}); filing unlabeled.`,
    );
    return false;
  }
}

const labelled = ensureLabel();

// Match on the title across ALL open issues rather than filtering by label: an issue whose label was
// removed by hand must still count as "already filed", or the round would open a second one.
let openIssues;
try {
  const raw = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--json',
    'number,title',
    '--limit',
    LIST_LIMIT,
  ]);
  openIssues = JSON.parse(raw || '[]') ?? [];
} catch (err) {
  fail(`cannot list the open issues of '${repo}' (${err?.message ?? err}).`);
}
const existing = new Map(openIssues.map((i) => [String(i?.title ?? ''), i?.number]));

const scratch = mkdtempSync(join(tmpdir(), 'advisory-issue-'));
const failures = [];
try {
  for (const entry of advisories) {
    const title = `${TITLE_PREFIX}${entry.id}`;
    const bodyFile = join(scratch, `${entry.id}.md`);
    writeFileSync(bodyFile, `${bodyFor(entry)}\n`);
    const number = existing.get(title);
    try {
      if (number === undefined) {
        const args = ['issue', 'create', '--repo', repo, '--title', title, '--body-file', bodyFile];
        if (labelled) args.push('--label', LABEL);
        gh(args);
        console.log(`advisory-issue sync: filed ${entry.id} (${entry.packages.size} package(s)).`);
      } else {
        const args = ['issue', 'edit', String(number), '--repo', repo, '--body-file', bodyFile];
        if (labelled) args.push('--add-label', LABEL);
        gh(args);
        console.log(`advisory-issue sync: refreshed #${number} for ${entry.id}.`);
      }
    } catch (err) {
      failures.push(`${entry.id}: ${err?.stderr || err?.message || err}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0)
  fail(`could not sync ${failures.length} advisory issue(s):\n  ${failures.join('\n  ')}`);
