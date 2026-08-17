#!/usr/bin/env node
/**
 * THE SHIPPED-SCRIPT GATE — a script that answers zero must have measured something.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SECOND GATE AND NOT AN ARM OF THE FIRST.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `check-documented-commands.mjs` walks the shipped MARKDOWN and judges a COMMAND LINE in a real
 * shell. This walks the shipped SCRIPTS and judges an EXIT CODE. Different corpus, different subject,
 * different execution model — folding them together would make one script answer two questions, which
 * is the reason that gate sits beside the example-documents gate rather than inside it.
 *
 * The defect being gated is one this repository has produced TWICE: a check that exits 0 having
 * measured nothing. Once in a shipped smoke, which answered 0 when the key it needed was absent from
 * the calling shell — while its precondition was about the SERVER's environment. Once in a gate's own
 * self-test, where a skip assertion had been listed as the accept control for the arm that runs
 * commands. Both times the artifact reported success for work it had not done.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WALKS the tree for shipped shell scripts — never a list kept here, so a new or renamed script is
 * covered the moment it lands — CLASSIFIES each by the precondition it actually depends on, and RUNS
 * it with that precondition DELIBERATELY UNMET. Each must exit NON-ZERO. A script that answers 0
 * under those conditions has told its caller it measured something it did not.
 *
 * UNMETTING A PRECONDITION IS ITSELF A MEASUREMENT, and getting it wrong is how this gate would
 * become the thing it exists to catch. Two traps, both hit while building it:
 *
 *   • A SERVER precondition is unmet by pointing `BASE` at a port NOTHING IS LISTENING ON — and the
 *     port is proven closed BEFORE the run. A probe against a port that happens to be occupied is not
 *     a probe of an absent server, and would let a script pass this gate for the wrong reason.
 *   • A DATABASE precondition is NOT unmet by unsetting `DATABASE_URL`. Measured: with both URLs
 *     unset, both database gate scripts here exit **0** — they fall back to a default DSN, and on a
 *     machine with a local Postgres that default ANSWERS. The precondition was met, just not through
 *     the environment. So the database class is unmet with an UNREACHABLE DSN instead, which is the
 *     only form of "no database" the script cannot route around.
 *
 * A SCRIPT THAT BOOTS A SERVER WHILE BEING PROBED IS A FAILURE, not an inconvenience: the probe port
 * is re-checked after every run, and a listener that was not there before means the script started
 * one rather than failing against its absence. (A sibling gate did exactly that, and it was caught
 * only by watching for listeners.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT MAKES A ZERO MEAN SOMETHING.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The input size is PRINTED beside the verdict, and a walk that finds NO scripts FAILS rather than
 * passes — a gate that measured nothing must not read as a pass, which is the whole defect. Every
 * script the walk finds is either RUN or LISTED WITH ITS REASON; there is no silent skip, because the
 * reason is the artifact.
 *
 * ITS OWN ACCEPT CONTROL: `--self-test` plants two throwaway scripts in the walked tree — one that
 * exits 0 having done nothing (the defect), one that correctly exits non-zero — and requires the gate
 * to go RED on the first and to have PASSED the second. Requiring both is what stops the self-test
 * being satisfied by a gate that simply fails everything, which is the shape a broken detector takes.
 *
 * Runs in a plain checkout: no build, no database, no network, no server.
 *
 * Usage: node scripts/check-shipped-scripts.mjs [--self-test]
 */
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.turbo', 'coverage', 'build']);
/** A script that has not answered in this long has not answered. */
const RUN_TIMEOUT_MS = 90_000;

/** Walk for shipped shell scripts. The corpus is the DISK, never a list kept in this file. */
function shellScripts(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) shellScripts(p, out);
    else if (name.endsWith('.sh')) out.push(p);
  }
  return out;
}

/**
 * WHICH PRECONDITION a script depends on, read off its own text.
 *
 * `server` — it drives a deployment over HTTP (`$BASE`, curl). Unmet = a closed port.
 * `database` — it needs a Postgres (`DATABASE_URL` / `SHADOW_DATABASE_URL` / psql). Unmet = a DSN
 *   pointing at a closed port; see the header for why unsetting the variable is not enough.
 * `unclassified` — neither marker is present. NOT a skip: it is reported with its reason and fails
 *   the gate, because a shipped script this gate cannot characterise is a gap in the gate, and a gap
 *   that passes silently is the defect one level up.
 */
function preconditionOf(text) {
  const server = /\bBASE=|\$\{?BASE\b|\bcurl\b/.test(text);
  const database = /DATABASE_URL|SHADOW_DATABASE_URL|\bpsql\b|drizzle-kit/.test(text);
  // A script that talks to a deployment over HTTP is probed as a server script even when it also
  // mentions a database: the server is the precondition its own first statement depends on.
  if (server) return 'server';
  if (database) return 'database';
  return 'unclassified';
}

/** A TCP port nothing is listening on — bound, released, then PROVEN closed before it is used. */
async function closedPort() {
  const port = await new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => res(p));
    });
  });
  if (await isListening(port)) {
    throw new Error(
      `the probe port ${port} is occupied — a probe of an absent server needs an absent server`,
    );
  }
  return port;
}

/** True when something accepts a TCP connection on `port`. */
function isListening(port) {
  return new Promise((res) => {
    const sock = connect({ port, host: '127.0.0.1' });
    const done = (answer) => {
      sock.destroy();
      res(answer);
    };
    sock.setTimeout(700);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * Run one script with BOTH preconditions unmet — the server port is closed and the DSN is
 * unreachable, so a script is denied whichever one it depends on without this having to know which.
 * Resolves `{ code, timedOut }`; never throws.
 */
function runUnmet(absolute, port) {
  const env = {
    ...process.env,
    // Neither class may inherit a working precondition from the shell this gate runs in.
    BASE: `http://127.0.0.1:${port}`,
    DATABASE_URL: `postgres://nobody:nobody@127.0.0.1:${port}/no-such-database`,
    SHADOW_DATABASE_URL: `postgres://nobody:nobody@127.0.0.1:${port}/no-such-database`,
    // A script that prompts would hang; a non-interactive shell is part of "unmet", not a courtesy.
    CI: 'true',
  };
  return new Promise((res) => {
    execFile(
      'bash',
      [absolute],
      {
        cwd: REPO_ROOT,
        env,
        timeout: RUN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 32 * 1024 * 1024,
      },
      (err) => {
        if (err?.killed) return res({ code: null, timedOut: true });
        res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: false });
      },
    );
  });
}

/**
 * Judge one script. Returns `{ ok, line }` — `ok:false` for a zero exit, a timeout, a precondition
 * this gate cannot characterise, or a script that opened a listener while being probed.
 */
async function judge(absolute, port) {
  const rel = relative(REPO_ROOT, absolute);
  const text = readFileSync(absolute, 'utf8');
  const precondition = preconditionOf(text);
  if (precondition === 'unclassified') {
    return {
      ok: false,
      line: `${rel}: FAIL — this gate cannot tell which precondition it depends on (no $BASE/curl and no DATABASE_URL/psql marker), so it cannot be run with that precondition unmet. Characterise it, or say in the script why it is not a check.`,
    };
  }
  const { code, timedOut } = await runUnmet(absolute, port);
  if (await isListening(port)) {
    return {
      ok: false,
      line: `${rel}: FAIL — a listener answered on the probe port after the run, so the script BOOTED A SERVER instead of failing against its absence. The probe must not provide the precondition it is withholding.`,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      line: `${rel}: FAIL — no answer within ${RUN_TIMEOUT_MS} ms with its ${precondition} precondition unmet (a check that hangs has not reported a failure).`,
    };
  }
  if (code === 0) {
    return {
      ok: false,
      line: `${rel}: FAIL — exited 0 with its ${precondition} precondition unmet. It reported success for work it could not have done.`,
    };
  }
  return {
    ok: true,
    line: `${rel}: ok — exit ${code} with its ${precondition} precondition unmet`,
  };
}

/**
 * Does a document beside this script declare an AGENT SURFACE?
 *
 * Read off the DOCUMENT rather than out of the script's prose. A regex over the script's comments
 * answered wrongly in both directions when it was tried — it called a database dry-run a live-model
 * script because the word "model" appears in its header, and missed a smoke whose own text never
 * names a key. The deployment's declaration is the fact; the prose is a description of it.
 */
function declaresAgentSurface(dir) {
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .some((f) => /^\s*(agents|extractors)\s*:/m.test(readFileSync(join(dir, f), 'utf8')));
}

/**
 * The scripts this gate does NOT run, each with the reason. Enumerated rather than omitted: the gap
 * is the artifact. Counted and printed, so it cannot quietly grow.
 */
function notRun() {
  const gateScripts = readdirSync(join(REPO_ROOT, 'scripts')).filter((f) => f.endsWith('.mjs'));
  return [
    {
      what: `scripts/*.mjs (${gateScripts.length})`,
      why:
        'these ARE the gate corpus — every one is already run by `pnpm gate` or by its own ' +
        '`*.test.mjs`, and running a gate with a precondition unmet is what its own self-test does. ' +
        'Gating them here would assert the same property twice and make this script the judge of ' +
        'its own family.',
    },
  ];
}

async function main() {
  const scripts = shellScripts(REPO_ROOT);
  const port = await closedPort();

  console.log(
    `SHIPPED-SCRIPT GATE — probe port ${port} (proven closed), timeout ${RUN_TIMEOUT_MS} ms`,
  );
  console.log(`scanned ${scripts.length} shipped shell script(s):`);

  // A walk that finds nothing FAILS. The whole subject of this gate is that a measurement of
  // nothing must not read as a pass, and that applies first of all to this gate.
  if (scripts.length === 0) {
    console.error(
      'SHIPPED-SCRIPT GATE: FAIL — the walk found NO shipped shell scripts. Either the corpus moved ' +
        'or the walk is broken; a gate that measured nothing does not pass.',
    );
    process.exit(1);
  }

  const results = [];
  for (const absolute of scripts) results.push(await judge(absolute, port));
  for (const r of results) console.log(`  ${r.line}`);

  const skipped = notRun();
  console.log(
    `not run by this gate (${skipped.length} group(s)) — listed, never silently skipped:`,
  );
  for (const s of skipped) console.log(`  ${s.what}: ${s.why}`);

  // The RUNNING half only proves a script fails when its precondition is ABSENT. A script whose
  // deployment declares an agent surface additionally needs a LIVE MODEL — and a paid API — to prove
  // it passes when the precondition is MET, which no gate here can supply. Said out loud, with the
  // count, so the gap is visible rather than absent.
  const liveModel = scripts.filter((p) => declaresAgentSurface(dirname(p)));
  console.log(
    `of those, ${liveModel.length} sit beside a document that declares an agent surface, so they ` +
      'additionally need a LIVE MODEL to run to completion: only their precondition-unmet behaviour ' +
      'is gated here, and their success path is exercised by hand.',
  );
  for (const p of liveModel) console.log(`  ${relative(REPO_ROOT, p)}`);

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(
      `SHIPPED-SCRIPT GATE: FAIL — ${failed.length} of ${scripts.length} script(s) did not report a ` +
        'failure when their precondition was unmet.',
    );
    process.exit(1);
  }
  console.log(
    `SHIPPED-SCRIPT GATE: PASS — all ${scripts.length} shipped shell script(s) exit non-zero with ` +
      'their precondition unmet.',
  );
}

/**
 * THE ACCEPT CONTROL. Two planted scripts, and BOTH verdicts are required:
 *   • one that exits 0 having done nothing — the gate must go RED on it;
 *   • one that correctly exits non-zero — the gate must have PASSED it.
 * The second is what stops this self-test being satisfied by a detector that fails everything, which
 * is exactly the shape a broken one takes.
 */
async function selfTest() {
  const planted = join(REPO_ROOT, '.gate-selftest-shipped-scripts');
  rmSync(planted, { recursive: true, force: true });
  mkdirSync(planted, { recursive: true });
  const liar = join(planted, 'measures-nothing.sh');
  const honest = join(planted, 'reports-its-failure.sh');
  // Both planted scripts read `"$BASE"` directly rather than bash's `${BASE:-default}` form: the
  // gate always sets BASE, so the default is dead weight — and writing `${` into a JavaScript string
  // is the one thing here a reader could mistake for an unfinished template literal.
  writeFileSync(
    liar,
    '#!/usr/bin/env bash\n' +
      '# Plants the defect: names $BASE, calls curl, measures nothing, and answers 0.\n' +
      'echo "pretending to check $BASE"\ncurl --version >/dev/null 2>&1 || true\nexit 0\n',
  );
  writeFileSync(
    honest,
    '#!/usr/bin/env bash\nset -euo pipefail\n' +
      'curl -fsS --max-time 3 "$BASE/health" >/dev/null\necho "unreachable"\n',
  );
  try {
    const port = await closedPort();
    const liarVerdict = await judge(liar, port);
    const honestVerdict = await judge(honest, port);
    console.log('SELF-TEST — the planted always-zero script:');
    console.log(`  ${liarVerdict.line}`);
    console.log('SELF-TEST — the planted script that reports its failure:');
    console.log(`  ${honestVerdict.line}`);

    const problems = [];
    if (liarVerdict.ok) {
      problems.push(
        'the always-zero script PASSED — the detector does not catch the defect this gate exists for',
      );
    }
    if (!honestVerdict.ok) {
      problems.push(
        'the correctly-failing script FAILED — the detector rejects everything, so a green run over ' +
          'the real corpus would prove nothing',
      );
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(`SELF-TEST: FAIL — ${p}.`);
      process.exit(2);
    }
    console.log(
      'SELF-TEST: PASS — the gate goes red on a script that exits 0 having measured nothing, and ' +
        'green on one that reports its failure.',
    );
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  await main();
}
