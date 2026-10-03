#!/usr/bin/env node
/**
 * Regression test for the shape of the release workflow (`.github/workflows/release.yml`), the only
 * workflow that publishes. It cannot run outside GitHub, so what keeps it safe is held here:
 *
 *   - it runs only on a manual dispatch, with the version and the typed confirmation required, and
 *     the approver's signature and the run it signs optional and given together;
 *   - every other job waits for the guard, and the guard checks that the `release` environment
 *     requires a reviewer before any job of the run starts;
 *   - the only job in the `release` environment publishes only on a dispatch with a signature, and
 *     its first step is the reviewer check, before any step that reads a secret or a variable;
 *   - no signing key reaches the workflow: no secret but the npm token is read, and nothing signs;
 *   - the publish job takes every artifact from the run the approver signed, and verifies the
 *     signature against the approver's public key before the npm publish and the image push.
 *
 * Needs `pnpm install` (the YAML parser of the workspace). Standalone: `node <thisfile>`; exit 0 =
 * pass.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { parse } = createRequire(join(REPO, 'packages', 'kernel', 'spec', 'package.json'))('yaml');
const WORKFLOW = join(REPO, '.github', 'workflows', 'release.yml');

let passed = 0;
const check = (label, fn) => {
  fn();
  passed += 1;
  console.log(`ok   ${label}`);
};

/** The checks of the release workflow, on its parsed form and its text; returns the problems. */
export function releaseWorkflowProblems(doc, text) {
  const problems = [];
  const triggers = Object.keys(doc.on ?? {});
  if (triggers.length !== 1 || triggers[0] !== 'workflow_dispatch') {
    problems.push(`it runs on ${triggers.join(', ')}, not only on a manual dispatch`);
  }
  const inputs = doc.on?.workflow_dispatch?.inputs ?? {};
  for (const name of ['version', 'confirm']) {
    if (inputs[name]?.required !== true) problems.push(`the input ${name} is not required`);
  }
  for (const name of ['signature', 'build_run']) {
    if (inputs[name] === undefined || inputs[name].required === true) {
      problems.push(`the input ${name} is not an optional input`);
    }
  }
  const jobs = doc.jobs ?? {};
  const guard = jobs.guard;
  if (guard === undefined) return [...problems, 'there is no guard job'];
  const isReviewerCheck = (step) =>
    typeof step?.run === 'string' &&
    step.run.includes('/environments/release') &&
    step.run.includes('required_reviewers');
  if (!(guard.steps ?? []).some(isReviewerCheck)) {
    problems.push('the guard does not check that the release environment requires a reviewer');
  }
  const needs = (job) => (Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []);
  const waitsForGuard = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    const deps = needs(jobs[name] ?? {});
    return deps.includes('guard') || deps.some((d) => waitsForGuard(d, seen));
  };
  for (const name of Object.keys(jobs).filter((n) => n !== 'guard')) {
    if (!waitsForGuard(name)) problems.push(`the job ${name} does not wait for the guard`);
  }
  const inEnvironment = Object.entries(jobs).filter(([, job]) => job.environment !== undefined);
  for (const [name, job] of inEnvironment) {
    const env = typeof job.environment === 'string' ? job.environment : job.environment?.name;
    if (env !== 'release') problems.push(`the job ${name} runs in the environment ${env}`);
    if (!needs(job).includes('guard') || !/needs\.guard\.outputs\.publish == 'true'/.test(job.if)) {
      problems.push(`the job ${name} does not run only on a dispatch with a signature`);
    }
    const steps = job.steps ?? [];
    if (!isReviewerCheck(steps[0])) {
      problems.push(`the first step of ${name} is not the reviewer check`);
    }
    const reads = steps.findIndex((s) => /\b(?:secrets|vars)\./.test(JSON.stringify(s)));
    const reviewer = steps.findIndex(isReviewerCheck);
    if (reads >= 0 && (reviewer < 0 || reviewer > reads)) {
      problems.push(`${name} reads a secret or a variable before the reviewer check`);
    }
  }
  for (const [name, job] of Object.entries(jobs)) {
    const publishes = (job.steps ?? []).some(
      (s) =>
        typeof s.run === 'string' &&
        /publish\.mjs --publish|skopeo copy|gh release create/.test(s.run),
    );
    if (publishes && job.environment !== 'release') {
      problems.push(`the job ${name} publishes outside the release environment`);
    }
  }
  const secrets = [...new Set(text.match(/secrets\.[A-Za-z0-9_]+/g) ?? [])];
  for (const secret of secrets) {
    if (secret !== 'secrets.NPM_TOKEN') problems.push(`the workflow reads ${secret}`);
  }
  const scripts = Object.values(jobs).flatMap((job) => (job.steps ?? []).map((s) => s.run ?? ''));
  if (scripts.some((run) => /release-manifest\.mjs sign\b|--key-file/.test(run))) {
    problems.push('the workflow signs: the release key belongs to the approver alone');
  }
  const publish = jobs.publish;
  if (publish === undefined) return [...problems, 'there is no publish job'];
  const steps = publish.steps ?? [];
  for (const step of steps.filter((s) =>
    String(s.uses ?? '').startsWith('actions/download-artifact@'),
  )) {
    if (!/^\$\{\{\s*inputs\.build_run\s*\}\}$/.test(String(step.with?.['run-id']))) {
      problems.push(
        `the publish job downloads ${step.with?.name ?? step.with?.pattern} from another run`,
      );
    }
  }
  const verify = steps.findIndex(
    (s) =>
      typeof s.run === 'string' &&
      /release-manifest\.mjs verify[\s\S]*--signature[\s\S]*--trusted-key/.test(s.run) &&
      /vars\.RAYSPEC_RELEASE_PUBLIC_KEY/.test(JSON.stringify(s.env ?? {})),
  );
  const first = steps.findIndex(
    (s) => typeof s.run === 'string' && /publish\.mjs --publish|skopeo copy/.test(s.run),
  );
  if (verify < 0 || first < 0 || verify > first) {
    problems.push(
      'the signature is not verified against the public key before anything is published',
    );
  }
  return problems;
}

const text = readFileSync(WORKFLOW, 'utf8');
const doc = parse(text);

check('the release workflow holds every rule', () => {
  assert.deepEqual(releaseWorkflowProblems(doc, text), []);
});

check('each rule fails on a workflow that breaks it', () => {
  const broken = (change) => {
    const copy = structuredClone(doc);
    change(copy);
    return releaseWorkflowProblems(copy, text);
  };
  assert.deepEqual(
    broken((d) => {
      d.on.push = { tags: ['v*'] };
    }),
    ['it runs on workflow_dispatch, push, not only on a manual dispatch'],
  );
  assert.deepEqual(
    broken((d) => {
      d.jobs.guard.steps = d.jobs.guard.steps.filter(
        (s) => !String(s.run).includes('required_reviewers'),
      );
    }),
    ['the guard does not check that the release environment requires a reviewer'],
  );
  assert.deepEqual(
    broken((d) => {
      d.jobs.publish.steps.push(d.jobs.publish.steps.shift());
    }),
    [
      'the first step of publish is not the reviewer check',
      'publish reads a secret or a variable before the reviewer check',
    ],
  );
  assert.deepEqual(
    broken((d) => {
      const [reviewer, ...rest] = d.jobs.publish.steps;
      const at = rest.findIndex((s) => /secrets\./.test(JSON.stringify(s)));
      d.jobs.publish.steps = [
        { run: 'echo first' },
        ...rest.slice(0, at + 1),
        reviewer,
        ...rest.slice(at + 1),
      ];
    }),
    [
      'the first step of publish is not the reviewer check',
      'publish reads a secret or a variable before the reviewer check',
    ],
  );
  assert.deepEqual(
    broken((d) => {
      d.jobs.publish.if = 'always()';
    }),
    ['the job publish does not run only on a dispatch with a signature'],
  );
  assert.deepEqual(
    broken((d) => {
      d.jobs.certification.needs = [];
    }),
    ['the job certification does not wait for the guard'],
  );
  assert.deepEqual(
    broken((d) => {
      const step = d.jobs.publish.steps.find((s) =>
        String(s.uses).startsWith('actions/download-artifact@'),
      );
      delete step.with['run-id'];
    }),
    ['the publish job downloads release-candidate from another run'],
  );
  assert.deepEqual(
    broken((d) => {
      d.jobs.publish.steps = d.jobs.publish.steps.filter(
        (s) => !/--signature/.test(String(s.run)) || /evidence/.test(String(s.run)),
      );
    }),
    ['the signature is not verified against the public key before anything is published'],
  );
  assert.deepEqual(
    broken((d) => {
      d.jobs.manifest.steps.push({
        run: 'node scripts/publish.mjs --publish --yes-really-publish',
      });
    }),
    ['the job manifest publishes outside the release environment'],
  );
  const signing = structuredClone(doc);
  signing.jobs.manifest.steps.push({
    run: 'node scripts/release-manifest.mjs sign --manifest m.json --key-file key.pem',
  });
  const withKey = `${text}\n# secrets.RAYSPEC_RELEASE_SIGNING_KEY\n`;
  assert.deepEqual(releaseWorkflowProblems(signing, withKey), [
    'the workflow reads secrets.RAYSPEC_RELEASE_SIGNING_KEY',
    'the workflow signs: the release key belongs to the approver alone',
  ]);
});

console.log(`ALL CASES PASSED (${passed})`);
