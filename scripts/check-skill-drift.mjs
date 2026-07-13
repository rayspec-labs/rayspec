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
 *
 * Text-only, DB-free, secret-free, build-optional.
 *
 *   node scripts/check-skill-drift.mjs   # exit 1 on any drift
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..');

const SKILL = '.claude/skills/rayspec-author/SKILL.md';
const GRAMMAR = 'packages/kernel/spec/src/grammar.ts';
// The retired backend version literal — it must never reappear in the skill once the language unified.
const RETIRED_VERSION = '0.1';

const problems = [];

// The authoring skill must be present for this gate to mean anything.
const skillPath = join(repoRoot, SKILL);
if (!existsSync(skillPath)) {
  console.error(`❌ skill-drift: the authoring skill is missing at ${SKILL}`);
  process.exit(1);
}
const skill = readFileSync(skillPath, 'utf8');

// (a) VERSION — parse the current literal from the grammar source, then assert the skill cites it and
// does NOT cite the retired one.
const grammarPath = join(repoRoot, GRAMMAR);
if (!existsSync(grammarPath)) {
  console.error(`❌ skill-drift: the grammar source is missing at ${GRAMMAR}`);
  process.exit(1);
}
const grammar = readFileSync(grammarPath, 'utf8');
const versionMatch = grammar.match(/SPEC_VERSION\s*=\s*'([^']+)'/);
if (!versionMatch) {
  console.error(`❌ skill-drift: could not parse SPEC_VERSION from ${GRAMMAR}`);
  process.exit(1);
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

if (problems.length > 0) {
  console.error('❌ skill-drift: the authoring skill has drifted from the code it documents:');
  for (const pr of problems) console.error(`   - ${pr}`);
  process.exit(1);
}

console.log(
  `✅ skill-drift: the authoring skill is in sync (version '${version}', ` +
    `${cliPaths.length} CLI path(s), ${examplePaths.length} example spec(s) verified).`,
);
