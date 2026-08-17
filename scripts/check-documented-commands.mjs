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
 *      had been predicting it by name the whole time. That command deploys a COMPILED artifact under
 *      a gitignored `dist/`, which is why the examples are built before the walk and why a spec that
 *      still will not resolve is a FAILURE here rather than a skip: skipping it is exactly how this
 *      check came to cover everything except the command it was written for.
 *
 *   D. A PRINTED "real output" BLOCK STILL HAS THE COMMAND'S KEYS. A ```jsonc fence whose first line
 *      is `// <the command that produced it>` is run for real and compared on its TOP-LEVEL KEY SET.
 *      Values and nesting are not compared — a document may abridge, and this gate is about drift,
 *      not about prose. `init`'s block had lost two keys the command emits.
 *
 * A SKIP IS LOUD. Where a command genuinely cannot run here — it needs a database, a port, a live
 * model, or a placeholder only the reader can fill — the gate COUNTS it, GROUPS it by reason, and
 * PRINTS it. A skip that prints nothing is how a false green ships; this repository has the receipt.
 * That includes a `console` transcript's output lines and a document's own prelude definitions,
 * which used to vanish before the accounting rather than after it.
 *
 * EVERY ZERO NAMES ITS INPUT — all SEVEN stages the pass line reports, not five. `deployChecked` and
 * `outputChecked` were printed on the same line as the word PASSED while reading zero.
 *
 * ITS OWN ACCEPT CONTROL: `--self-test` writes one throwaway document and requires a violation from
 * EACH OF THE FOUR CHECKS — a `zsh`-hostile shortcut (A), a command over a path that exists and
 * fails (B), a `deploy` missing the variable its `doctor` demands (C), an output block with a
 * dropped key (D) — plus, listed separately because they are NOT accept controls, two assertions
 * that a skip stayed loud. Check B had none of its own: a skip assertion stood in for it, and
 * gutting B's violation condition left the self-test green. Check C's subject is chosen from the
 * documents the gate really walks, because proving a detector against a document the corpus never
 * uses is how C stayed green over a command it was silently skipping.
 *
 * HERMETIC: every child runs with the `.env` auto-loader off and no database URL, so it reads the
 * same on a developer's machine as in CI and touches no database.
 *
 * NEEDS THE BUILD, AND BUILDS THE EXAMPLES. It drives the CLI's built entrypoint, so it runs after
 * `pnpm build`; a missing build is exit 2. Unlike its sibling it also needs the EXAMPLES built,
 * because documented commands name compiled artifacts — so it runs every `build.mjs` it finds one
 * level under `examples/` itself, first, and refuses with exit 2 if one fails.
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
const EXAMPLES_DIR = join(repoRoot, 'examples');
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

/**
 * Build every example that ships a build step, BEFORE the walk.
 *
 * The documented deploy this gate exists to check names a COMPILED artifact
 * (`examples/acme-notes-backend/dist/rayspec.yaml`) — `dist/` is gitignored, so on a clean checkout
 * that path does not exist and check C skipped the one command it was written for, reporting a
 * green line over a corpus that no longer contained the defect. The document's own two-line recipe
 * builds it first; so does this. The scripts are WALKED, never listed here, so an example that grows
 * a build step is covered the moment it lands.
 *
 * A build that fails is exit 2 — the same refusal as a missing CLI build. The gate does not report a
 * pass over documents whose subjects it could not produce.
 */
async function buildExamples() {
  const scripts = [];
  for (const entry of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const script = join(EXAMPLES_DIR, entry.name, 'build.mjs');
    if (existsSync(script)) scripts.push(relative(repoRoot, script));
  }
  for (const script of scripts) {
    const { code, out } = await runShell('bash', `node ${JSON.stringify(script)}`);
    if (code !== 0) {
      console.error(
        `documented-commands gate: \`node ${script}\` FAILED (exit ${code}), so the artifacts the ` +
          'documented commands name cannot be produced. The gate refuses rather than reporting a ' +
          `pass over a corpus it could not build. Output: ${out.trim()}`,
      );
      process.exit(2);
    }
  }
  return scripts.length;
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
 * The logical lines of one shell block: `{ lines, dropped }`. Comments and blanks are structure and
 * vanish; a `\` continuation is joined into the line it continues; a `console`-style `$ ` prompt is
 * stripped. A `console` transcript's OUTPUT lines are not commands — but they are RETURNED, in
 * `dropped`, because "a skip is loud" is this gate's own rule and it did not hold here: an
 * un-prompted line disappeared with no count and no reason, which is the one shape a reader of the
 * summary cannot distinguish from a line the extractor failed to see.
 */
function commandLines(body, lang) {
  const out = [];
  const dropped = [];
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
        dropped.push(text.trim()); // transcript output, not a command — counted, not vanished
        continue;
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
  return { lines: out.filter((l) => l !== ''), dropped: dropped.filter((l) => l !== '') };
}

/**
 * The shell PRELUDE a document establishes for its own later commands: the blocks that only DEFINE
 * things and RUN nothing. A reader has these in the shell by the time they reach a later block, so
 * the gate must too — and probing what they define is check A.
 */
const OPENS_FUNCTION = /^([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{/;
const DEFINES_VARIABLE = /^([A-Za-z_][A-Za-z0-9_]*)=/;
/**
 * A value that RUNS something when the assignment is evaluated. `stripEnvPrefix(l) === ''` tests what
 * FOLLOWS an assignment, not what the assignment itself executes — so
 * `LISTENER="$(node server.js)"` read as a pure definition and the prelude opened a listening socket.
 * Command substitution in either spelling, and process substitution, are the ways a value runs code.
 */
const VALUE_RUNS_SOMETHING = /\$\(|`|<\(|>\(/;

/**
 * The command a function body RUNS first — `node` in `rayspec() { node "$ROOT/…" "$@"; }`. Read off
 * the definition rather than out of `type` output, whose format differs per shell. `undefined` when
 * the body opens with something that is not a plain command word (an assignment, a redirect), which
 * simply means check A has nothing extra to resolve for it.
 */
function bodyHead(text) {
  for (const word of shellWords(text)) {
    if (word === '' || word === '{' || word === '}') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return /^[A-Za-z_./][\w./-]*$/.test(word) ? word : undefined;
  }
  return undefined;
}

/** Net `{` minus `}` on a line, counted OUTSIDE quotes — how a multi-line function body is closed. */
function braceDelta(line) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== '') {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') break;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth;
}

/**
 * Read one shell block as a sequence of DEFINITIONS, or report that it is not one.
 *
 * A function is read to its closing brace rather than by its first line: the one-line form
 * `f() { …; }` and the conventional multi-line form are the same definition, and requiring EVERY
 * line to look like a definition silently rejected the multi-line one — dropping the shortcuts of
 * the very page this gate was written for while the summary still said PASSED.
 */
function readDefinitions(lines) {
  const shortcuts = [];
  let depth = 0;
  let open;
  let wraps;
  for (const line of lines) {
    if (depth > 0) {
      wraps ??= bodyHead(line);
      depth += braceDelta(line);
      if (depth <= 0) {
        shortcuts.push({ name: open, kind: 'function', wraps });
        open = undefined;
        wraps = undefined;
        depth = 0;
      }
      continue;
    }
    const fn = OPENS_FUNCTION.exec(line);
    if (fn !== null) {
      const delta = braceDelta(line);
      const head = bodyHead(line.slice(line.indexOf('{') + 1));
      if (delta <= 0) shortcuts.push({ name: fn[1], kind: 'function', wraps: head });
      else {
        open = fn[1];
        wraps = head;
        depth = delta;
      }
      continue;
    }
    const v = DEFINES_VARIABLE.exec(line);
    // Tested on the ASSIGNMENTS, never on the whole line: `RAYSPEC="node …"   # the `rayspec` CLI`
    // carries backticks in its trailing PROSE, and matching those rejected a perfectly good shortcut
    // — the gate then found none at all on the very page it was written for. `shellWords` has
    // already cut the comment, so the prefix is the value and nothing else.
    const assigned = envPrefixOf(line).join(' ');
    if (v !== null && stripEnvPrefix(line) === '' && !VALUE_RUNS_SOMETHING.test(assigned)) {
      // A shortcut only when it holds a command; a plain value is just a value.
      if (/=("|')?node\s/.test(line)) shortcuts.push({ name: v[1], kind: 'variable' });
      continue;
    }
    return { ok: false, shortcuts: [] };
  }
  return { ok: depth === 0, shortcuts };
}

function preludeOf(blocks) {
  const parts = [];
  /** `{ name, kind: 'function' | 'variable' }` — the kind decides how the shortcut is PROBED. */
  const shortcuts = [];
  let preludeLines = 0;
  for (const block of blocks) {
    if (!['bash', 'sh'].includes(block.lang)) continue;
    const { lines } = commandLines(block.body, block.lang);
    if (lines.length === 0) continue;
    const read = readDefinitions(lines);
    if (!read.ok) continue;
    shortcuts.push(...read.shortcuts);
    preludeLines += lines.length;
    parts.push(block.body);
  }
  return {
    script: parts.join('\n'),
    shortcuts,
    names: shortcuts.map((s) => s.name),
    preludeLines,
  };
}

/**
 * Text that LOOKS like a shell-shortcut definition, used as a per-document tripwire on the reader
 * above. A document that plainly defines one but yields none has an extractor problem, and the
 * GLOBAL shortcut count cannot see it: one other document defining one anywhere keeps the total
 * non-zero while this page contributes nothing, which is how a reformat of the two functions here
 * left the guide's own commands unchecked under a PASSED line.
 */
const LOOKS_LIKE_A_SHORTCUT =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_-]*\s*\(\)\s*\{|[A-Za-z_][A-Za-z0-9_]*=["']?node\s)/m;

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
 * The other spelling of "substitute your own": a path written in the `path/to/thing` convention, or
 * one rooted at `your-`/`my-`. It is a placeholder without angle brackets, and check C must treat it
 * as one — a document illustrating a command shape is not naming a file that ought to exist. The
 * distinction matters because check C's unresolved-path case is a FAILURE: without this, an
 * illustration turns a correct page red, which is the mirror of the defect it was tightened for.
 */
const ILLUSTRATIVE_PATH = /(^|\/)path\/to\/|(^|\/)(your|my)-/;

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

/**
 * Every `<name>=` a documented command line sets AS ITS OWN PREFIX. Only the prefix — an `export` on
 * an earlier line is deliberately NOT read: the gate would then have to decide which earlier block a
 * reader still has in their shell, and guessing wrong in that direction turns a correct document
 * red. A recipe that needs a variable states it on the line that needs it.
 */
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

    // The PER-DOCUMENT tripwire on the reader. A global shortcut count cannot see one page's
    // shortcuts disappear while another page's keep the total non-zero — and the page that goes
    // quiet is the one whose commands then stop being checked at all.
    if (
      prelude.shortcuts.length === 0 &&
      shellBlocks.some((b) => LOOKS_LIKE_A_SHORTCUT.test(b.body))
    ) {
      violations.push(
        `${docRel}: a shell block here plainly DEFINES a command shortcut, and the extractor read ` +
          'none — so every command on this page ran without it and check A probed nothing. Fix the ' +
          'reader; this is not a documentation defect.',
      );
    }

    // ── A. the shortcuts a document defines RESOLVE, in every shell a reader has ────────────────
    // Resolution only — nothing is executed. `command -v` asks the shell what the first word of the
    // invocation names, which IS the defect: the variable form is probed exactly as the document
    // writes it (`$NAME`, unquoted), so `bash` word-splits it to `node` and resolves, while `zsh`
    // does not split and looks for one executable whose name contains a space. Running the target
    // instead would boot whatever it points at — `rayspec-serve --version` starts a server.
    for (const shortcut of prelude.shortcuts) {
      shortcutCount += 1;
      // For a FUNCTION, `command -v <name>` resolves the moment the definition is evaluated, which
      // says nothing about whether the definition is any good. The discriminating question is what
      // the function WRAPS, so the probe resolves that too — the wrapped head is read off the
      // definition at parse time (never by parsing `type` output, which differs per shell). Still
      // resolution only: nothing the shortcut points at is executed.
      const probe =
        shortcut.kind === 'function'
          ? `command -v ${shortcut.name} >/dev/null && command -v ${shortcut.wraps ?? shortcut.name}`
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
      const read = commandLines(block.body, block.lang);
      for (const line of read.dropped) {
        commandCount += 1;
        noteSkip('a console transcript line that is output, not a command');
      }
      for (const line of read.lines) {
        commandCount += 1;
        // A prelude line is a DEFINITION a reader evaluates, not an instruction to judge — and it is
        // already run, in front of every command below. Naming it keeps it out of the
        // "not a CLI command" bucket, which it was inflating with things that are not commands.
        if (prelude.script.includes(line)) {
          noteSkip(
            'a shell shortcut definition (run as this document’s prelude, not judged as an instruction)',
          );
          continue;
        }
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
          if (ILLUSTRATIVE_PATH.test(spec)) {
            noteSkip('a `deploy` over an illustrative path (`path/to/…`), not a file in the tree');
          } else if (!existsSync(resolve(repoRoot, spec))) {
            // NOT a skip. A concrete path that will not resolve — after the examples have been built
            // above — means this check silently stopped covering the command it was written for.
            // That is exactly how it happened: the target is a build artifact under a gitignored
            // `dist/`, so on a clean checkout the one deploy carrying the defect was skipped and the
            // gate printed a green line. A placeholder the reader fills is a different thing and is
            // still skipped, loudly, above.
            violations.push(
              `${docRel}: the documented \`${line}\` names \`${spec}\`, which does not exist after ` +
                'the example builds ran — so this check could not read what the document requires ' +
                'at boot. A path this gate cannot resolve is a failure, not a skip: skipping it is ' +
                'how the command this check exists for stopped being covered.',
            );
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
      const labelled = splitLabelledOutputs(block.body);
      if (labelled.length === 0) {
        noteSkip('a JSON block that names no command it is the output of');
        continue;
      }
      for (const chunk of labelled) {
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
  // Check C's subject must be a spec a documented `deploy` in the CORPUS actually names — proving the
  // detector against a document no deploy line uses is how it stayed green while the one command it
  // was written for was being skipped. `deploySubject()` reads the tree's own documents for it.
  const spec = await deploySubject();
  const failing = findNegativeFixture();
  const doc = [
    '# a document with one of each defect',
    '',
    '```bash',
    `RAYSPEC_BROKEN="node ${join(repoRoot, 'packages/app/cli/dist/index.js')}"`,
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
    // Check B's own case: a path that EXISTS, so the command is RUN rather than skipped, over a
    // document the floor refuses. Without it, gutting check B's violation condition left the
    // self-test green — a skip assertion had been standing in for the accept control of the one
    // check that does the running.
    ...(failing ? ['```bash', `rayspec doctor ${failing}`, '```', ''] : []),
    ...(spec ? ['```bash', `rayspec deploy ${spec}`, '```', ''] : []),
    '```jsonc',
    '// rayspec init',
    '{ "ok": true }',
    '```',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'defects.md'), doc);

  const expected = [
    {
      name: 'a zsh-hostile shortcut (check A)',
      match: /does not resolve to a runnable command under `zsh`/,
    },
    {
      name: 'a printed output that dropped keys (check D)',
      match: /printed output for .* has drifted/,
    },
  ];
  if (failing) {
    expected.push(
      {
        name: 'a documented command that FAILS, under bash (check B)',
        match: /FAILED under `bash`/,
      },
      { name: 'a documented command that FAILS, under zsh (check B)', match: /FAILED under `zsh`/ },
    );
  }
  if (spec) {
    expected.push({
      name: 'a deploy missing a required variable (check C)',
      match: /does not set `RAYSPEC_/,
    });
  }

  const result = await gate(dir, { quiet: true });
  console.log('documented-commands gate SELF-TEST over 1 synthetic document:');
  let failed = 0;
  for (const e of expected) {
    const caught = result.violations.some((v) => e.match.test(v));
    console.log(`  ${caught ? 'CAUGHT ' : 'MISSED '} ${e.name}`);
    if (!caught) failed += 1;
  }
  // Two SKIP assertions. They are not accept controls for any check — they prove the loud-skip rule
  // holds — and they are listed apart so neither is mistaken for one again.
  for (const s of [
    { name: 'a command over a path that does not exist', match: /names a path the reader creates/ },
    { name: 'a console transcript line that is output', match: /transcript line that is output/ },
  ]) {
    const seen = [...result.skips.keys()].some((r) => s.match.test(r));
    if (s.match.source.includes('transcript') && !seen) continue; // only if the doc carries one
    console.log(`  ${seen ? 'COUNTED' : 'MISSED '} ${s.name} (skipped, with a reason)`);
    if (!seen) failed += 1;
  }
  // Check C's subject has to be a spec the corpus really deploys, or the detector is proven against
  // a document the gate never judges.
  if (spec === undefined) {
    console.log('  MISSED  check C has no subject: no documented `deploy` names a resolvable spec');
    failed += 1;
  }

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

/**
 * Check C's self-test subject: a spec that a documented `deploy` IN THE REAL CORPUS names, that
 * resolves on disk, and whose `doctor` reports a required variable. All three conditions matter —
 * proving the detector against a spec no deploy line uses is how check C stayed green while the one
 * command it was written for was being skipped for an unresolvable path.
 */
async function deploySubject() {
  for (const docRel of walkMarkdown(repoRoot)) {
    const blocks = fencedBlocks(readFileSync(join(repoRoot, docRel), 'utf8'));
    const prelude = preludeOf(blocks);
    for (const block of blocks.filter((b) => ['bash', 'sh', 'console'].includes(b.lang))) {
      for (const line of commandLines(block.body, block.lang).lines) {
        const argv = shellWords(stripEnvPrefix(line));
        const head = resolveHead(argv[0] ?? '', prelude.names);
        if (!(prelude.names.includes(head) || head === 'rayspec') || !argv.includes('deploy'))
          continue;
        const spec = argv.find((a) => /\.ya?ml$/.test(a));
        if (spec === undefined || PLACEHOLDER.test(spec) || !existsSync(resolve(repoRoot, spec)))
          continue;
        const { vars, readable } = await requiredVarsFor(spec);
        if (readable && vars.size > 0) return spec;
      }
    }
  }
  return undefined;
}

/**
 * Check B's self-test subject: a committed document the read-only floor REFUSES, so a documented
 * command over it is RUN (the path exists) and comes back non-zero. `*.invalid.*` is the tree's own
 * negative-fixture convention, which `check-example-documents.mjs` relies on for the same reason.
 */
function findNegativeFixture() {
  return walkYaml(join(repoRoot, 'examples'), { negativesOnly: true })[0];
}
function walkYaml(dir, { negativesOnly = false } = {}) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walkYaml(join(dir, entry.name), { negativesOnly }));
    } else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
      if (/\.invalid\./.test(entry.name) === negativesOnly) {
        found.push(relative(repoRoot, join(dir, entry.name)));
      }
    }
  }
  return found.sort();
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────────

// The documented commands name COMPILED artifacts, so the corpus is built before it is walked — by
// both entry points, because the self-test's check-C subject is chosen out of that same corpus.
const examplesBuilt = await buildExamples();

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
// Both of these printed their zero on the SAME LINE as the word PASSED. "Every zero names its input"
// has to include the stages that name theirs in the summary, or the sentence is decoration.
if (result.deployChecked === 0) zeroes.push('no documented deploy to check against its own doctor');
if (result.outputChecked === 0) zeroes.push('no printed output block to compare');
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
  `documented-commands gate PASSED: ${examplesBuilt} example build(s) run first, ` +
    `${result.documents} markdown document(s), ` +
    `${result.blockCount} shell block(s), ${result.commandCount} command line(s) — ` +
    `${result.shortcutCount} documented shortcut(s) resolved under ${SHELLS.join(' + ')}, ` +
    `${result.ranCount} command(s) RUN in each shell, ${result.deployChecked} documented deploy(s) ` +
    `checked against their own doctor, ${result.outputChecked} printed output(s) compared. ` +
    'Skips are listed above with their reasons.',
);
