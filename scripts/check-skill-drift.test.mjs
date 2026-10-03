#!/usr/bin/env node
/**
 * Regression test for the command half of the skill-drift gate (`check-skill-drift.mjs`): the CLI
 * help, the CLI reference and the authoring skill must name the same commands.
 *
 *   - the commands are read from the help text with their subcommands, and a placeholder or a flag
 *     after a command is not taken for a subcommand;
 *   - a command the help prints with no section heading in the reference is a problem, naming it;
 *   - a command the skill names in code that the help does not print (a removed verb, a removed
 *     subcommand of a group) is a problem, naming it, while the same words in prose are not;
 *   - the gate passes on this repository's built help, reference and skill, and fails, naming the
 *     command, when the reference loses a section, also when it is started through a path that
 *     holds a symbolic link.
 *
 * Needs `pnpm build` (the gate reads the built CLI's help). Standalone: `node <thisfile>`; exit 0 =
 * pass.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  codeOf,
  commandDrift,
  commandGroups,
  helpCommands,
  referenceHeadings,
  SKILL,
  skillCommands,
} from './check-skill-drift.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `rayspec — RaySpec CLI

GET STARTED:
  rayspec init [dir] [--force]  Scaffold a project.
  rayspec doctor <spec.yaml>   Validate.
  rayspec plan   <spec.yaml> [--against <old-spec>]
  rayspec bundle inspect <file.ray> [--json]
  rayspec bundle verify <file.ray>
  rayspec deploy --dry-run <spec.yaml>
  rayspec --version | -v        Print the version.
`;

const REFERENCE = `# CLI reference

## \`init\`
## \`doctor\`
## \`plan\`
### \`bundle inspect\`
## \`bundle verify\`
## \`deploy\` — boot and serve
`;

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

check('the help text gives each command with its subcommand, never a placeholder or flag', () => {
  assert.deepEqual(
    [...helpCommands(HELP)],
    ['init', 'doctor', 'plan', 'bundle inspect', 'bundle verify', 'deploy'],
  );
  assert.deepEqual([...commandGroups(helpCommands(HELP))], ['bundle']);
  assert.deepEqual(
    [...referenceHeadings(REFERENCE)],
    ['init', 'doctor', 'plan', 'bundle inspect', 'bundle verify', 'deploy'],
  );
});

check('a help command without a reference section is named', () => {
  const reference = REFERENCE.replace('### `bundle inspect`\n', '');
  assert.deepEqual(commandDrift({ help: HELP, reference, skill: '' }).problems, [
    '`rayspec bundle inspect` is in the CLI help but has no section in docs/cli-reference.md',
  ]);
});

check('a removed verb or subcommand in the skill is named; prose is not code', () => {
  const skill = [
    'Run `rayspec doctor ./rayspec.yaml`, then sign it:',
    '',
    '```bash',
    'npx rayspec bundle sign app.ray --key-file key.pem',
    'node packages/app/cli/dist/index.js publish app.ray',
    'rayspec deploy app.ray',
    '```',
    '',
    'The rayspec release tooling signs it; a rayspec project is a directory.',
  ].join('\n');
  assert.equal(codeOf(skill).length, 2);
  const groups = commandGroups(helpCommands(HELP));
  assert.deepEqual([...skillCommands(skill, groups)].sort(), [
    'bundle sign',
    'deploy',
    'doctor',
    'publish',
  ]);
  assert.deepEqual(commandDrift({ help: HELP, reference: REFERENCE, skill }).problems, [
    'the skill names `rayspec bundle sign`, which the CLI help does not list',
    'the skill names `rayspec publish`, which the CLI help does not list',
  ]);
});

check('an empty help text is itself a problem', () => {
  assert.deepEqual(commandDrift({ help: '', reference: REFERENCE, skill: '' }).problems, [
    'the CLI help text lists no command',
  ]);
});

check('the gate passes on this repository and fails when the reference loses a section', () => {
  const gate = (root) =>
    spawnSync(process.execPath, [join(root, 'scripts', 'check-skill-drift.mjs')], {
      encoding: 'utf8',
    });
  const real = gate(REPO);
  assert.equal(real.status, 0, real.stderr);
  // A copy of exactly what the gate reads, with the `init` section removed from the reference.
  const scratch = mkdtempSync(join(tmpdir(), 'rayspec-skill-drift-'));
  try {
    for (const rel of [
      'scripts/check-skill-drift.mjs',
      'scripts/lib/entry.mjs',
      SKILL,
      'packages/kernel/spec/src/grammar.ts',
      'docs/cli-reference.md',
    ]) {
      mkdirSync(dirname(join(scratch, rel)), { recursive: true });
      cpSync(join(REPO, rel), join(scratch, rel));
    }
    for (const p of ['examples', 'packages/app/cli']) {
      mkdirSync(join(scratch, dirname(p)), { recursive: true });
      symlinkSync(join(REPO, p), join(scratch, p));
    }
    const reference = readFileSync(join(scratch, 'docs/cli-reference.md'), 'utf8');
    const without = reference.replace('## `init`', '## Starting a project');
    assert.notEqual(without, reference);
    writeFileSync(join(scratch, 'docs/cli-reference.md'), without);
    const failed = gate(scratch);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /`rayspec init` is in the CLI help but has no section/);
    // Started through a path that holds a symbolic link, the gate still runs and still fails.
    const link = join(mkdtempSync(join(tmpdir(), 'rayspec-skill-drift-link-')), 'repo');
    symlinkSync(scratch, link);
    try {
      assert.notEqual(realpathSync(link), link);
      const throughLink = gate(link);
      assert.equal(throughLink.status, 1, throughLink.stdout);
      assert.match(throughLink.stderr, /`rayspec init` is in the CLI help but has no section/);
    } finally {
      rmSync(dirname(link), { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

console.log(`ALL CASES PASSED (${passed})`);
