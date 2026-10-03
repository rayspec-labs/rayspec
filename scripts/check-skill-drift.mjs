#!/usr/bin/env node
/**
 * Skill-drift gate — keeps the authoring skill in sync with the code it documents.
 *
 * The authoring skill teaches an agent to write specs against the shipped grammar + CLI. If the grammar
 * version, the CLI entrypoint path, or a cited example spec drifts, the skill silently teaches a stale
 * interface. This gate reads the skill and FAILS the build when:
 *
 *   (a) the current spec VERSION literal (parsed from the grammar source) is ABSENT from the skill, OR
 *       the retired '0.1' version literal is PRESENT (a stale version reference).
 *   (b) a CLI entrypoint path the skill cites does not resolve on disk (neither its built dist nor its
 *       source sibling — so a wrong package path is caught whether or not the tree has been built).
 *   (c) an example spec path the skill cites (a concrete examples/.../*.yaml, never a placeholder) does
 *       not exist on disk.
 *   (d) a command the CLI prints in `rayspec --help` has no section heading in docs/cli-reference.md
 *       (a heading that starts with the command in backticks, such as "## `bundle verify`").
 *   (e) the skill names a command, in code, that the CLI does not print in `rayspec --help`: a
 *       removed or renamed verb (`rayspec <verb>`, `npx rayspec <verb>` or the CLI's dist entrypoint
 *       followed by the verb, with the subcommand of a group such as `bundle`).
 *
 * Text-only, DB-free, secret-free. (d) and (e) read the help text of the built CLI, so the gate
 * needs `pnpm build`; without the build it fails and says so.
 *
 *   node scripts/check-skill-drift.mjs   # exit 1 on any drift
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The commands a help text prints: the word after `rayspec` on an indented usage line, with the
 * next word when it is a subcommand (a bare lowercase word, not a placeholder or a flag).
 */
export function helpCommands(help) {
  const commands = new Set();
  for (const line of help.split('\n')) {
    const m = /^ {2}rayspec ([a-z][a-z-]*)(?: +([a-z][a-z-]*))?(?=\s|$)/.exec(line);
    if (m) commands.add(m[2] === undefined ? m[1] : `${m[1]} ${m[2]}`);
  }
  return commands;
}

/** The groups among `commands`: first words that only appear with a subcommand. */
export function commandGroups(commands) {
  const groups = new Set();
  for (const c of commands) if (c.includes(' ')) groups.add(c.split(' ')[0]);
  return groups;
}

/** The commands docs/cli-reference.md has a section heading for. */
export function referenceHeadings(markdown) {
  const out = new Set();
  for (const m of markdown.matchAll(/^#{2,3} `([a-z][a-z -]*[a-z])`/gm)) out.add(m[1]);
  return out;
}

/** The text of every inline code span and fenced code block of a Markdown document. */
export function codeOf(markdown) {
  const parts = [];
  const fence = /^```[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of markdown.matchAll(fence)) parts.push(m[1]);
  const prose = markdown.replace(fence, '');
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) parts.push(m[1]);
  return parts;
}

/**
 * Every command the skill names in code: `rayspec <cmd>`, `npx rayspec <cmd>`, or a CLI dist
 * entrypoint followed by `<cmd>`, with the next word when `<cmd>` is one of `groups`.
 */
export function skillCommands(markdown, groups) {
  const found = new Set();
  const pattern =
    /(?:^|[\s;&|(`$])(?:rayspec|packages\/app\/cli\/dist\/index\.js) ([a-z][a-z-]*)(?: +([a-z][a-z-]*))?/gm;
  for (const code of codeOf(markdown)) {
    for (const m of code.matchAll(pattern)) {
      found.add(groups.has(m[1]) && m[2] !== undefined ? `${m[1]} ${m[2]}` : m[1]);
    }
  }
  return found;
}

/** The problems of (d) and (e). */
export function commandDrift({ help, reference, skill }) {
  const problems = [];
  const commands = helpCommands(help);
  if (commands.size === 0) problems.push('the CLI help text lists no command');
  const headings = referenceHeadings(reference);
  for (const c of [...commands].sort()) {
    if (!headings.has(c)) {
      problems.push(
        `\`rayspec ${c}\` is in the CLI help but has no section in docs/cli-reference.md`,
      );
    }
  }
  const groups = commandGroups(commands);
  for (const c of [...skillCommands(skill, groups)].sort()) {
    if (!commands.has(c)) {
      problems.push(`the skill names \`rayspec ${c}\`, which the CLI help does not list`);
    }
  }
  return { problems, commands: commands.size };
}

/** The authoring skill this gate guards, relative to the repository root. */
export const SKILL = '.claude/skills/rayspec-author/SKILL.md';

function main() {
  // Resolve the repo root from THIS file via fileURLToPath — a checkout path with a space (or any
  // other percent-encodable character) survives, where `new URL(import.meta.url).pathname` would leave
  // a literal `%20` in the path and break every join below.
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

  const CLI_REFERENCE = 'docs/cli-reference.md';
  const GRAMMAR = 'packages/kernel/spec/src/grammar.ts';
  // The retired backend version literal — it must never reappear in the skill once the language unified.
  const RETIRED_VERSION = '0.1';

  const problems = [];

  // The authoring skill must be present for this gate to mean anything.
  const skillPath = join(repoRoot, SKILL);
  if (!existsSync(skillPath)) {
    console.error(`❌ skill-drift: the authoring skill is missing at ${SKILL}`);
    return 1;
  }
  const skill = readFileSync(skillPath, 'utf8');

  // (a) VERSION — parse the current literal from the grammar source, then assert the skill cites it and
  // does NOT cite the retired one.
  const grammarPath = join(repoRoot, GRAMMAR);
  if (!existsSync(grammarPath)) {
    console.error(`❌ skill-drift: the grammar source is missing at ${GRAMMAR}`);
    return 1;
  }
  const grammar = readFileSync(grammarPath, 'utf8');
  const versionMatch = grammar.match(/SPEC_VERSION\s*=\s*'([^']+)'/);
  if (!versionMatch) {
    console.error(`❌ skill-drift: could not parse SPEC_VERSION from ${GRAMMAR}`);
    return 1;
  }
  const version = versionMatch[1];
  if (!skill.includes(`'${version}'`)) {
    problems.push(
      `the current spec version '${version}' (from ${GRAMMAR}) is not mentioned in the skill`,
    );
  }
  if (skill.includes(`'${RETIRED_VERSION}'`)) {
    problems.push(
      `the retired version literal '${RETIRED_VERSION}' appears in the skill (stale — the version is now '${version}')`,
    );
  }

  // (b) CLI entrypoint paths — every dist entrypoint the skill cites must resolve, either as the built
  // dist OR as its `src/*.ts` sibling (so the gate does not depend on the tree having been built).
  const cliPaths = [...new Set(skill.match(/packages\/[A-Za-z0-9._/-]+\/dist\/index\.js/g) ?? [])];
  for (const p of cliPaths) {
    const distExists = existsSync(join(repoRoot, p));
    const srcExists = existsSync(join(repoRoot, p.replace(/\/dist\/index\.js$/, '/src/index.ts')));
    if (!distExists && !srcExists) {
      problems.push(`the CLI entrypoint '${p}' cited in the skill does not resolve on disk`);
    }
  }

  // (c) Example spec paths — a concrete examples/.../*.yaml the skill cites must exist. The charset stops
  // at a placeholder metacharacter (`<`, `{`, `*`), so a templated `examples/<slug>/rayspec.yaml` is
  // never treated as a real path.
  const examplePaths = [...new Set(skill.match(/examples\/[A-Za-z0-9._/-]+\.ya?ml/g) ?? [])];
  for (const p of examplePaths) {
    if (!existsSync(join(repoRoot, p))) {
      problems.push(`the example spec '${p}' cited in the skill does not exist on disk`);
    }
  }

  // (d) + (e) — the commands of the built CLI's help text, the reference and the skill.
  const cliEntry = join(repoRoot, 'packages/app/cli/dist/index.js');
  const helpRun = existsSync(cliEntry)
    ? spawnSync(process.execPath, [cliEntry, '--help'], { encoding: 'utf8' })
    : null;
  let commandCount = 0;
  if (helpRun === null || helpRun.status !== 0) {
    problems.push(
      'the CLI help text cannot be read: run `pnpm build` so packages/app/cli/dist/index.js exists',
    );
  } else {
    const drift = commandDrift({
      help: helpRun.stdout,
      reference: readFileSync(join(repoRoot, CLI_REFERENCE), 'utf8'),
      skill,
    });
    problems.push(...drift.problems);
    commandCount = drift.commands;
  }

  if (problems.length > 0) {
    console.error('❌ skill-drift: the authoring skill has drifted from the code it documents:');
    for (const pr of problems) console.error(`   - ${pr}`);
    return 1;
  }

  console.log(
    `✅ skill-drift: the authoring skill is in sync (version '${version}', ` +
      `${cliPaths.length} CLI path(s), ${examplePaths.length} example spec(s) verified), and ` +
      `${CLI_REFERENCE} has a section for each of the ${commandCount} commands of the CLI help.`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
