/**
 * release-closure.mjs — which workspace packages a release publishes, read the way
 * `scripts/publish.mjs` reads them.
 *
 * The publish set is the production-dependency closure of the three bin packages: the unscoped
 * `rayspec` launcher, `@rayspec/cli` and `@rayspec/server`. The member manifests are found with
 * `git ls-files`, so an untracked or ignored manifest never joins a release. `publish.mjs` carries
 * its own copy of this walk, because its regression test runs a copy of that one file inside a
 * throwaway repository; `scripts/release-candidate.mjs` refuses a pack whose tarballs are not
 * exactly this set, so the two cannot drift apart unnoticed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The packages the release closure is rooted at. */
export const CLOSURE_ROOTS = ['rayspec', '@rayspec/cli', '@rayspec/server'];

/**
 * Every RaySpec member manifest of the workspace at `repoRoot`, as `Map<name, { dir, json }>`,
 * `dir` relative to the root. The repo-root manifest is also named `rayspec` and is never a member.
 */
export function workspaceMembers(repoRoot) {
  const listed = execFileSync('git', ['ls-files', '*package.json', '**/package.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const members = new Map();
  for (const path of [...new Set(listed.split('\n').filter(Boolean))].sort()) {
    if (path.includes('node_modules/') || path === 'package.json') continue;
    const json = JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
    const scoped = typeof json.name === 'string' && json.name.startsWith('@rayspec/');
    if (!scoped && json.name !== 'rayspec') continue;
    const dir = relative(repoRoot, join(repoRoot, path, '..'));
    members.set(json.name, { dir, json });
  }
  return members;
}

/** The publish set over `members`: names, sorted by code point. */
export function publishSet(members) {
  const seen = new Set();
  const stack = [...CLOSURE_ROOTS];
  while (stack.length > 0) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    for (const dep of Object.keys(members.get(name)?.json.dependencies ?? {})) {
      if (dep.startsWith('@rayspec/') && !seen.has(dep)) stack.push(dep);
    }
  }
  return [...seen].filter((n) => members.has(n)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
