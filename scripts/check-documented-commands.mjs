#!/usr/bin/env node
/**
 * Documented-command gate — a command a document tells a reader to RUN does what the document says.
 *
 * This is the third finding of that class in two releases, and each time the cause was the same:
 * nothing executed the instructions. `check-example-documents.mjs` beside this one closes the
 * neighbouring hole — every shipped *document* still answers the read-only floor — and this gate is
 * deliberately NOT part of it. The two ask different questions of different corpora: that one walks
 * `examples/**` YAML and judges a DOCUMENT, this one walks shipped MARKDOWN and judges a COMMAND
 * LINE, in a real shell, with its own idea of what "cannot run here" means. Folding them together
 * would make one script answer two questions, which is the shape that produced the defect this repo
 * spent a release unpicking.
 *
 * FOUR CHECKS, each over the same walked corpus:
 *
 *   A. SHELL SHORTCUTS RESOLVE, in `bash` AND `zsh`. A document that defines a shortcut for the CLI
 *      (a function, or the `NAME="node …"` variable form) must produce a working command in both.
 *      The variable form does not: `zsh` — the default macOS login shell — never word-splits an
 *      unquoted expansion, so `$RAYSPEC doctor …` looks for one executable whose NAME contains a
 *      space and dies `exit 127`. It was the first thing the guide asked a reader to do.
 *
 *   B. EVERY DOCUMENTED CLI COMMAND OVER A PATH THAT EXISTS actually runs — again in both shells,
 *      with the defining document's own shortcut block in front of it, exactly as a reader has it.
 *
 *   C. A DOCUMENTED `deploy` SETS THE ENVIRONMENT ITS OWN `doctor` DEMANDS. `doctor` is a pure
 *      read-only pass, so this needs no database: it is run over the very spec the command names,
 *      and any warning that says a variable must be set at boot must be answered by the documented
 *      command line. The recipe that shipped without `RAYSPEC_CRON_TENANT_ID` aborted AFTER
 *      committing product-store DDL, so a reader's first attempt left state behind — and `doctor`
 *      had been predicting it by name the whole time.
 *
 *   D. A PRINTED "real output" BLOCK STILL HAS THE COMMAND'S KEYS. A ```jsonc fence whose first line
 *      is `// <the command that produced it>` is run for real and compared on its TOP-LEVEL KEY SET.
 *      Values and nesting are not compared — a document may abridge, and this gate is about drift,
 *      not about prose. `init`'s block had lost two keys the command emits.
 *
 * A SKIP IS LOUD. Where a command genuinely cannot run here — it needs a database, a port, a live
 * model, or a placeholder only the reader can fill — the gate COUNTS it, GROUPS it by reason, and
 * PRINTS it. A skip that prints nothing is how a false green ships; this repository has the receipt.
 *
 * EVERY ZERO NAMES ITS INPUT. The pass line carries the corpus size at each stage, and a walk that
 * finds no document, no command block or no runnable command is a FAILURE, not a pass.
 *
 * ITS OWN ACCEPT CONTROL: `--self-test` writes a throwaway document carrying one command of each
 * defect class (a `zsh`-hostile shortcut, a command over a missing path, a `deploy` missing the
 * variable its `doctor` demands, an output block with a dropped key), runs the whole gate over that
 * directory alone, and requires all four to be caught. It is not a mock: it is this file's own
 * checks over a real document, so a detector that stops firing fails here rather than going quiet.
 *
 * HERMETIC: every child runs with the `.env` auto-loader off and no database URL, so it reads the
 * same on a developer's machine as in CI and touches no database.
 *
 * NEEDS THE BUILD: it drives the CLI's built entrypoint, so it runs after `pnpm build`. A missing
 * build is exit 2 — the gate refuses rather than reporting a pass it never measured.
 *
 * Usage: node scripts/check-documented-commands.mjs [--self-test]
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(repoRoot, 'packages', 'app', 'cli', 'dist', 'index.js');
/** Directories that ship no authored prose (installed packages, build output, VCS). */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
/** The shells a reader actually has. `zsh` is the macOS login shell; `bash` is everywhere else. */
const SHELLS = ['bash', 'zsh'];

if (!existsSync(CLI)) {
  console.error(
    `documented-commands gate: the built CLI is not at ${relative(repoRoot, CLI)} — run ` +
      '`pnpm build` first. The gate refuses rather than reporting a pass over commands it never ran.',
  );
  process.exit(2);
}

/** Every markdown file under `root`, walked (never listed here), repo-relative. */
function walkMarkdown(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walkMarkdown(join(root, entry.name)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(relative(repoRoot, join(root, entry.name)));
    }
  }
  return found.sort();
}

/** Fenced blocks of one document: `{ lang, body }`, in document order. */
function fencedBlocks(markdown) {
  const blocks = [];
  const re = /^```([a-z]*)\n([\s\S]*?)^```/gm;
  let m = re.exec(markdown);
  while (m !== null) {
    blocks.push({ lang: m[1], body: m[2] });
    m = re.exec(markdown);
  }
  return blocks;
}

/**
 * The logical command lines of one shell block: comments and blank lines dropped, a `\` continuation
 * joined into the line it continues, and a `console`-style `$ ` prompt stripped. Output lines of a
 * `console` transcript (anything not behind a prompt, once the block has shown one) are dropped.
 */
function commandLines(body, lang) {
  const out = [];
  let pending = '';
  let sawPrompt = false;
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (pending === '' && line.trim() === '') continue;
    if (pending === '' && line.trim().startsWith('#')) continue;
    let text = line;
    if (pending === '') {
      if (text.trimStart().startsWith('$ ')) {
        sawPrompt = true;
        text = text.trimStart().slice(2);
      } else if (lang === 'console' && sawPrompt) {
        continue; // transcript output, not a command
      }
    }
    if (text.endsWith('\\')) {
      pending += `${text.slice(0, -1)} `;
      continue;
    }
    out.push(`${pending}${text}`.trim());
    pending = '';
  }
  if (pending.trim() !== '') out.push(pending.trim());
  return out.filter((l) => l !== '');
}

/**
 * The shell PRELUDE a document establishes for its own later commands: the blocks that only DEFINE
 * things (a function, or an assignment) and run nothing. A reader has these in the shell by the time
 * they reach a later block, so the gate must too — and running them is check A.
 */
const DEFINES_FUNCTION = /^([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{/;
const DEFINES_VARIABLE = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function preludeOf(blocks) {
  const parts = [];
  /** `{ name, kind: 'function' | 'variable' }` — the kind decides how the shortcut is PROBED. */
  const shortcuts = [];
  for (const block of blocks) {
    if (!['bash', 'sh'].includes(block.lang)) continue;
    const lines = commandLines(block.body, block.lang);
    if (lines.length === 0) continue;
    // "Definitions only" means the line RUNS NOTHING. An env-PREFIXED command
    // (`FOO=1 BAR=2 pnpm serve`) starts with an assignment too, and taking it for a definition put a
    // running server into the prelude of every later command on the page — the gate booting the very
    // things it declines to run. A variable line qualifies only when nothing remains after its
    // assignments.
    const defsOnly = lines.every(
      (l) => DEFINES_FUNCTION.test(l) || (DEFINES_VARIABLE.test(l) && stripEnvPrefix(l) === ''),
    );
    if (!defsOnly) continue;
    for (const l of lines) {
      const fn = DEFINES_FUNCTION.exec(l);
      if (fn) shortcuts.push({ name: fn[1], kind: 'function' });
      const v = DEFINES_VARIABLE.exec(l);
      // The variable form is a shortcut only when it holds a command; a plain value is just a value.
      if (v && /=("|')?node\s/.test(l)) shortcuts.push({ name: v[1], kind: 'variable' });
    }
    parts.push(block.body);
  }
  return { script: parts.join('\n'), shortcuts, names: shortcuts.map((s) => s.name) };
}

/**
 * A `rayspec` on the PATH for the duration of a probe, pointing at the CLI THIS TREE BUILDS.
 *
 * An example README writes `rayspec doctor <spec>` — the command of a published install, which is a
 * legitimate thing for a document to assume and not a defect to report. Without this the gate would
 * only ever measure whether the machine running it happens to have the package installed globally,
 * which is not a fact about the documentation. Shimming it measures what the issue actually asks:
 * that the documented command line, with its arguments, does what the document says. A reader with a
 * global install runs the same line against the same CLI.
 */
const SHIM_DIR = mkdtempSync(join(tmpdir(), 'rayspec-doccmd-bin-'));
writeFileSync(join(SHIM_DIR, 'rayspec'), `#!/bin/sh\nexec node ${JSON.stringify(CLI)} "$@"\n`, {
  mode: 0o755,
});

/** Run one script in one shell from the repo root; never throws. Hermetic (no `.env`, no DB). */
async function runShell(shell, script, cwd = repoRoot) {
  const env = { ...process.env, RAYSPEC_SKIP_DOTENV: '1' };
  env.PATH = `${SHIM_DIR}:${env.PATH ?? ''}`;
  delete env.DATABASE_URL;
  delete env.SHADOW_DATABASE_URL;
  try {
    const { stdout, stderr } = await execFileAsync(shell, ['-c', script], {
      cwd,
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { code: e.code ?? 1, out: `${String(e.stdout ?? '')}${String(e.stderr ?? '')}` };
  }
}

/** The CLI subcommands that read and print, touching no database and no port. */
const READ_ONLY_SUBCOMMANDS = new Set(['doctor', 'plan', 'openapi', 'init']);
/** A token a reader is expected to REPLACE — the gate cannot know what it becomes. */
const PLACEHOLDER = /<[^>]+>|\.\.\.|…|sk-…|sk-\.\.\./;

/**
 * The command a line really invokes, when it is written through a shortcut the document defined:
 * `$RAYSPEC` and `${RAYSPEC}` both name `RAYSPEC`. Without this the checks below simply did not see
 * a page that uses the variable form throughout — which is the very page that shipped a `deploy`
 * missing the variable its own `doctor` demands.
 */
function resolveHead(head, shortcutNames) {
  const bare = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(head);
  if (bare !== null && shortcutNames.includes(bare[1])) return bare[1];
  return head;
}

/**
 * How one command line is judged: `{ verdict: 'run' }`, or `{ verdict: 'skip', reason }`. Every skip
 * carries a reason, and the reasons are a closed, printed set — a command this cannot classify is a
 * skip with the honest reason that it could not, and it is counted like any other.
 */
function classify(line, shortcutNames) {
  const invocation = stripEnvPrefix(line);
  const argv = shellWords(invocation);
  const head = resolveHead(argv[0] ?? '', shortcutNames);
  const isCli =
    shortcutNames.includes(head) ||
    head === 'rayspec' ||
    (head === 'npx' && invocation.includes(' rayspec '));
  if (!isCli) return { verdict: 'skip', reason: 'not a CLI command (shell, curl, psql, node, …)' };
  if (head === 'npx') return { verdict: 'skip', reason: 'installs from the registry (npx)' };

  const sub = argv.slice(1).find((a) => !a.startsWith('-')) ?? '';
  if (sub === '') {
    // `rayspec-serve`, with or without an environment prefix: the boot server itself. It takes no
    // subcommand, opens a port and a database, and is never run here.
    return {
      verdict: 'skip',
      reason: 'boots a server (no subcommand — it opens a port and a database)',
    };
  }
  if (!READ_ONLY_SUBCOMMANDS.has(sub)) {
    return { verdict: 'skip', reason: `needs a database, a port or a live model (\`${sub}\`)` };
  }
  if (sub === 'init')
    return { verdict: 'skip', reason: '`init` writes into the working directory' };
  if (PLACEHOLDER.test(invocation)) {
    return { verdict: 'skip', reason: 'carries a placeholder only the reader can fill' };
  }
  if (envPrefixOf(line).length > 0) {
    return { verdict: 'skip', reason: 'carries an environment prefix this gate does not supply' };
  }
  const paths = argv.slice(1).filter((a) => /\.(ya?ml|json)$/.test(a));
  if (paths.length === 0) return { verdict: 'skip', reason: 'names no document to read' };
  for (const p of paths) {
    if (!existsSync(resolve(repoRoot, p))) {
      return { verdict: 'skip', reason: `names a path the reader creates (\`${p}\`)` };
    }
  }
  return { verdict: 'run' };
}

/**
 * Split a shell line into words the way a shell does — quotes hold a word together, so
 * `RAYSPEC="node /a/b.js"` is ONE word and not two. A naive `split(/\s+/)` read the quoted value as a
 * second word, which made every assignment carrying a space look like an assignment followed by a
 * command; a trailing `# comment` did the same. Both misreadings put running commands into the
 * prelude and hid the shortcuts this gate exists to probe.
 */
function shellWords(line) {
  const words = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== '') {
      word += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word += ch;
      started = true;
      continue;
    }
    // A `#` that opens a word, outside quotes, starts a comment: the rest of the line is prose.
    if (ch === '#' && word === '') break;
    if (/\s/.test(ch)) {
      if (word !== '') words.push(word);
      word = '';
      continue;
    }
    word += ch;
    started = true;
  }
  if (word !== '') words.push(word);
  return started || words.length > 0 ? words : [];
}

/** `A=1 B="two words" cmd …` → the `['A=1','B="two words"']` prefix. */
function envPrefixOf(line) {
  const prefix = [];
  for (const token of shellWords(line)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) prefix.push(token);
    else break;
  }
  return prefix;
}
function stripEnvPrefix(line) {
  return shellWords(line).slice(envPrefixOf(line).length).join(' ');
}

/** Every `<name>=` a documented command line sets, including via an `export` on an earlier line. */
function variablesSetBy(line) {
  return new Set(envPrefixOf(line).map((t) => t.split('=')[0]));
}

/**
 * The environment variables a document's own `doctor` says the named spec REQUIRES at boot. Read off
 * the warning text, which names them: this gate asserts the documented command answers what the
 * shipped tool already reports, and never carries a list of variables of its own.
 */
const REQUIRED_VAR =
  /\b(RAYSPEC_[A-Z0-9_]+)\b[^.]{0,80}?\b(is not set|needs|must be set|set to)\b/g;
async function requiredVarsFor(specPath) {
  const { out } = await runShell(
    'bash',
    `node ${JSON.stringify(CLI)} doctor ${JSON.stringify(specPath)}`,
  );
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch {
    return { vars: new Set(), readable: false };
  }
  const vars = new Set();
  for (const w of parsed.warnings ?? []) {
    const text = `${w.message ?? ''}`;
    let m = REQUIRED_VAR.exec(text);
    while (m !== null) {
      vars.add(m[1]);
      m = REQUIRED_VAR.exec(text);
    }
    REQUIRED_VAR.lastIndex = 0;
  }
  return { vars, readable: true };
}

// ── the walk ──────────────────────────────────────────────────────────────────────────────────────

async function gate(rootDir, { quiet = false } = {}) {
  const violations = [];
  const skips = new Map();
  const noteSkip = (reason) => skips.set(reason, (skips.get(reason) ?? 0) + 1);
  const documents = walkMarkdown(rootDir);
  let blockCount = 0;
  let commandCount = 0;
  let ranCount = 0;
  let shortcutCount = 0;
  let deployChecked = 0;
  let outputChecked = 0;

  for (const docRel of documents) {
    const markdown = readFileSync(join(repoRoot, docRel), 'utf8');
    const blocks = fencedBlocks(markdown);
    const shellBlocks = blocks.filter((b) => ['bash', 'sh', 'console'].includes(b.lang));
    blockCount += shellBlocks.length;
    const prelude = preludeOf(blocks);

    // ── A. the shortcuts a document defines RESOLVE, in every shell a reader has ────────────────
    // Resolution only — nothing is executed. `command -v` asks the shell what the first word of the
    // invocation names, which IS the defect: the variable form is probed exactly as the document
    // writes it (`$NAME`, unquoted), so `bash` word-splits it to `node` and resolves, while `zsh`
    // does not split and looks for one executable whose name contains a space. Running the target
    // instead would boot whatever it points at — `rayspec-serve --version` starts a server.
    for (const shortcut of prelude.shortcuts) {
      shortcutCount += 1;
      const probe =
        shortcut.kind === 'function'
          ? `command -v ${shortcut.name}`
          : `command -v $${shortcut.name}`;
      for (const shell of SHELLS) {
        const { code, out } = await runShell(shell, `${prelude.script}\n${probe} >/dev/null`);
        if (code !== 0) {
          violations.push(
            `${docRel}: the shortcut \`${shortcut.name}\` this document defines does not resolve to ` +
              `a runnable command under \`${shell}\` (exit ${code}) — a reader on that shell cannot ` +
              `follow this page at all. ${
                shortcut.kind === 'variable'
                  ? 'A `NAME="node …"` variable is one word to a shell that does not split an ' +
                    'unquoted expansion (zsh, the default macOS login shell); define a function ' +
                    'instead, which both shells split correctly.'
                  : ''
              } ${out.trim().split('\n')[0]}`.trim(),
          );
        }
      }
    }

    for (const block of shellBlocks) {
      for (const line of commandLines(block.body, block.lang)) {
        commandCount += 1;
        const verdict = classify(line, prelude.names);
        if (verdict.verdict === 'skip') {
          noteSkip(verdict.reason);
        } else {
          // ── B. a documented command over a path that exists runs, in every shell ────────────
          ranCount += 1;
          for (const shell of SHELLS) {
            const { code, out } = await runShell(shell, `${prelude.script}\n${line}`);
            if (code !== 0) {
              violations.push(
                `${docRel}: \`${line}\` FAILED under \`${shell}\` (exit ${code}) as committed. ` +
                  `Output: ${out.trim().split('\n').slice(0, 3).join(' ')}`,
              );
            }
          }
        }

        // ── C. a documented deploy answers the environment its own doctor demands ─────────────
        const argv = shellWords(stripEnvPrefix(line));
        const head = resolveHead(argv[0] ?? '', prelude.names);
        const isDeploy =
          (prelude.names.includes(head) || head === 'rayspec') && argv.includes('deploy');
        const spec = argv.find((a) => /\.ya?ml$/.test(a));
        if (isDeploy && spec !== undefined && !PLACEHOLDER.test(spec)) {
          if (!existsSync(resolve(repoRoot, spec))) {
            noteSkip('a `deploy` over a path the reader creates');
          } else {
            deployChecked += 1;
            const { vars, readable } = await requiredVarsFor(spec);
            if (!readable) {
              noteSkip('a `deploy` whose spec `doctor` could not report on');
            } else {
              const set = variablesSetBy(line);
              for (const required of vars) {
                if (!set.has(required)) {
                  violations.push(
                    `${docRel}: the documented \`${line}\` does not set \`${required}\`, which ` +
                      `\`doctor ${spec}\` says this document requires at boot. The boot refuses — ` +
                      'and for a spec with stores it refuses AFTER the product-store DDL has been ' +
                      "committed, so the reader's first attempt leaves state behind.",
                  );
                }
              }
            }
          }
        }
      }
    }

    // ── D. a printed "real output" block still has the command's top-level keys ────────────────
    for (const block of blocks) {
      if (block.lang !== 'jsonc' && block.lang !== 'json') continue;
      for (const chunk of splitLabelledOutputs(block.body)) {
        // The label names how a READER invokes it (`npx -y rayspec …`), which is not how this gate
        // has to run it: the JSON being compared is the CLI's own output either way, so the local
        // build answers the question. `init` writes a file, so it runs in a throwaway directory; a
        // path the reader creates is resolved the same way. Judging the label by `classify` — which
        // exists to decide what may be EXECUTED as an instruction — skipped all three of README's
        // output blocks, and the gate reported "0 compared" while a key was missing from one.
        const runnable = outputCommandVerdict(chunk.command);
        if (runnable.verdict === 'skip') {
          noteSkip(`a printed output whose command cannot run here (${runnable.reason})`);
          continue;
        }
        const real = await realOutputOf(chunk.command);
        if (real === undefined) {
          noteSkip('a printed output whose command produced no readable JSON');
          continue;
        }
        const printed = parseLooseJson(chunk.json);
        if (printed === undefined) {
          noteSkip('a printed output this gate could not parse');
          continue;
        }
        // Counted only once a comparison is actually MADE. Incrementing before the parse let the
        // pass line report an output as "compared" that the gate had in fact skipped — the exact
        // shape of claim this gate exists to catch, in the gate's own summary.
        outputChecked += 1;
        const missing = Object.keys(real).filter((k) => !(k in printed));
        const extra = Object.keys(printed).filter((k) => !(k in real));
        if (missing.length > 0 || extra.length > 0) {
          violations.push(
            `${docRel}: the printed output for \`${chunk.command}\` has drifted from what the ` +
              `command emits — ${missing.length > 0 ? `missing ${missing.map((k) => `\`${k}\``).join(', ')}` : ''}` +
              `${missing.length > 0 && extra.length > 0 ? '; ' : ''}` +
              `${extra.length > 0 ? `no longer emitted: ${extra.map((k) => `\`${k}\``).join(', ')}` : ''}.`,
          );
        }
      }
    }
  }

  if (!quiet) {
    reportSkips(skips);
  }
  return {
    violations,
    documents: documents.length,
    blockCount,
    commandCount,
    ranCount,
    shortcutCount,
    deployChecked,
    outputChecked,
    skips,
  };
}

/**
 * Whether a LABELLED OUTPUT's command can be re-run here to compare its keys. This is a different
 * question from {@link classify}, which decides what may be executed as an INSTRUCTION: an `npx -y`
 * label is not a registry install to be avoided, it is just how the document spells the CLI, and a
 * spec the reader creates is one `init` makes in the same throwaway directory.
 */
function outputCommandVerdict(command) {
  const argv = shellWords(stripEnvPrefix(command));
  const withoutNpx = argv[0] === 'npx' ? argv.slice(argv.indexOf('rayspec')) : argv;
  const sub = withoutNpx.slice(1).find((a) => !a.startsWith('-')) ?? '';
  if (withoutNpx[0] !== 'rayspec') return { verdict: 'skip', reason: 'not a CLI command' };
  if (!READ_ONLY_SUBCOMMANDS.has(sub)) {
    return { verdict: 'skip', reason: `needs a database, a port or a live model (\`${sub}\`)` };
  }
  if (PLACEHOLDER.test(withoutNpx.join(' '))) {
    return { verdict: 'skip', reason: 'carries a placeholder only the reader can fill' };
  }
  return { verdict: 'run', argv: withoutNpx, sub };
}

/** `// <command>` followed by its JSON, repeated — the shape the README's output blocks use. */
function splitLabelledOutputs(body) {
  const chunks = [];
  let current;
  for (const raw of body.split('\n')) {
    const label = /^\s*\/\/\s*(.+?)\s*(?:\(exit \d+\))?\s*$/.exec(raw);
    if (label && /(^|\s)(npx -y )?rayspec\s/.test(label[1])) {
      if (current) chunks.push(current);
      current = { command: label[1].trim(), json: '' };
      continue;
    }
    if (current) current.json += `${raw}\n`;
  }
  if (current) chunks.push(current);
  return chunks.filter((c) => c.json.trim() !== '');
}

/**
 * Run the labelled command for real and return its parsed top-level object, or `undefined`.
 *
 * A command that WRITES (`init`), or that reads a document the reader is told to create first, runs
 * in a throwaway directory where `init` has just made one — which is exactly the state the README
 * puts the reader in three lines earlier. Nothing is ever written into the tree.
 */
async function realOutputOf(command) {
  const verdict = outputCommandVerdict(command);
  if (verdict.verdict !== 'run') return undefined;
  const rest = verdict.argv.slice(1);
  const specArg = rest.find((a) => /\.ya?ml$/.test(a));
  const needsScratch =
    verdict.sub === 'init' || (specArg !== undefined && !existsSync(resolve(repoRoot, specArg)));
  const cwd = needsScratch ? mkdtempSync(join(tmpdir(), 'rayspec-doccmd-')) : repoRoot;
  try {
    const seed =
      needsScratch && verdict.sub !== 'init' ? `node ${JSON.stringify(CLI)} init >/dev/null\n` : '';
    const { out } = await runShell(
      'bash',
      `${seed}node ${JSON.stringify(CLI)} ${rest.join(' ')}`,
      cwd,
    );
    return parseLooseJson(out);
  } finally {
    if (needsScratch) rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * Strip `//` comments that are OUTSIDE a string — the `jsonc` these blocks are fenced as allows one
 * at the end of a line, and a line-based filter both missed those and would have cut a `https://` in
 * half. Scans with string state, exactly like {@link shellWords}.
 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Parse JSON that may carry `//` comments, a trailing `…`, or an abridging ellipsis. */
function parseLooseJson(text) {
  const stripped = stripJsonComments(text)
    .replace(/,\s*(…|\.\.\.)\s*(?=[\]}])/g, '')
    .replace(/(\[|,)\s*(…|\.\.\.)\s*(?=,|\])/g, '$1')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) return undefined;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function reportSkips(skips) {
  const total = [...skips.values()].reduce((a, b) => a + b, 0);
  console.log(`documented-commands gate: ${total} command(s) NOT run here, by reason:`);
  for (const [reason, n] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  · ${String(n).padStart(3)} — ${reason}`);
  }
  if (total === 0) console.log('  (none)');
}

// ── the accept control ────────────────────────────────────────────────────────────────────────────

/**
 * Prove every detector fires, over a REAL document rather than a mock: one throwaway markdown file
 * carrying one command of each defect class, put through the same `gate()` the tree gets.
 */
async function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'rayspec-doccmd-selftest-'));
  const spec = walkMarkdown(join(repoRoot, 'examples')).length >= 0 ? findCronSpec() : undefined;
  const doc = [
    '# a document with one of each defect',
    '',
    '```bash',
    'RAYSPEC_BROKEN="node ' + join(repoRoot, 'packages/app/cli/dist/index.js') + '"',
    '```',
    '',
    '```bash',
    '$RAYSPEC_BROKEN doctor examples/lead-qualifier/lead-qualifier.rayspec.yaml',
    '```',
    '',
    '```bash',
    'rayspec doctor examples/no-such-example/nope.rayspec.yaml',
    '```',
    '',
    ...(spec ? ['```bash', `rayspec deploy ${spec}`, '```', ''] : []),
    '```jsonc',
    '// rayspec init',
    '{ "ok": true }',
    '```',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'defects.md'), doc);

  const expected = [
    { name: 'a zsh-hostile shortcut', match: /does not resolve to a runnable command under `zsh`/ },
    { name: 'a printed output that dropped keys', match: /printed output for .* has drifted/ },
  ];
  if (spec) {
    expected.push({
      name: 'a deploy missing a required variable',
      match: /does not set `RAYSPEC_/,
    });
  }

  const result = await gate(dir, { quiet: true });
  console.log(`documented-commands gate SELF-TEST over 1 synthetic document:`);
  let failed = 0;
  for (const e of expected) {
    const caught = result.violations.some((v) => e.match.test(v));
    console.log(`  ${caught ? 'CAUGHT ' : 'MISSED '} ${e.name}`);
    if (!caught) failed += 1;
  }
  // The missing-path command must be SKIPPED with a reason, never silently dropped and never run.
  const skipped = [...result.skips.keys()].some((r) => /names a path the reader creates/.test(r));
  console.log(
    `  ${skipped ? 'CAUGHT ' : 'MISSED '} a command over a path that does not exist (skipped, with a reason)`,
  );
  if (!skipped) failed += 1;

  rmSync(dir, { recursive: true, force: true });
  if (failed > 0) {
    console.error(
      `\ndocumented-commands gate SELF-TEST FAILED: ${failed} detector(s) did not fire. Every green ` +
        'verdict this gate prints rests on these firing, so a silent detector is the one failure ' +
        'that makes all the others meaningless.',
    );
    process.exit(1);
  }
  console.log('documented-commands gate SELF-TEST PASSED: every detector fires.');
}

/** A shipped spec whose `doctor` demands an environment variable — the self-test's deploy subject. */
function findCronSpec() {
  const candidates = walkYaml(join(repoRoot, 'examples'));
  for (const rel of candidates) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    if (/^\s*triggers:/m.test(text) && /kind:\s*cron/.test(text)) return rel;
  }
  return undefined;
}
function walkYaml(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walkYaml(join(dir, entry.name)));
    } else if (entry.isFile() && /\.ya?ml$/.test(entry.name) && !/\.invalid\./.test(entry.name)) {
      found.push(relative(repoRoot, join(dir, entry.name)));
    }
  }
  return found.sort();
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes('--self-test')) {
  await selfTest();
  process.exit(0);
}

const result = await gate(repoRoot);

// THE ZERO GUARDS. Each stage names its input size, because a zero that means "nothing to check" and
// a zero that means "the walk moved" print the same green line otherwise.
const zeroes = [];
if (result.documents === 0) zeroes.push('no markdown document');
if (result.blockCount === 0) zeroes.push('no shell block');
if (result.commandCount === 0) zeroes.push('no command line');
if (result.ranCount === 0) zeroes.push('no runnable command');
if (result.shortcutCount === 0) zeroes.push('no documented shell shortcut');
if (zeroes.length > 0) {
  console.error(
    `documented-commands gate FAILED: the walk of ${relative(repoRoot, repoRoot) || '.'} found ` +
      `${zeroes.join(', ')}. Zero is a failure, never a pass: the documents cannot have gone away, ` +
      'so the walk is reading the wrong place or the extractor stopped extracting.',
  );
  process.exit(1);
}

if (result.violations.length > 0) {
  console.error('documented-commands gate FAILED:');
  for (const v of result.violations) console.error(`  - ${v}`);
  console.error(
    '\nA command a document tells a reader to run has to do what the document says. A reader ' +
      'follows these literally, on the shell they already have, and an instruction that cannot ' +
      'succeed costs them the page — or, where the failure lands after DDL is committed, leaves ' +
      'state behind on their first attempt.',
  );
  process.exit(1);
}

console.log(
  `documented-commands gate PASSED: ${result.documents} markdown document(s), ` +
    `${result.blockCount} shell block(s), ${result.commandCount} command line(s) — ` +
    `${result.shortcutCount} documented shortcut(s) resolved under ${SHELLS.join(' + ')}, ` +
    `${result.ranCount} command(s) RUN in each shell, ${result.deployChecked} documented deploy(s) ` +
    `checked against their own doctor, ${result.outputChecked} printed output(s) compared. ` +
    'Skips are listed above with their reasons.',
);
