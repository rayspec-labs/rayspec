/**
 * The CLI's EXPERIMENTAL banner, pinned — behaviour AND documentation.
 *
 * `emitExperimentalBanner` (index.ts) already printed a genuinely unmissable stderr banner whenever
 * `doctor` or `plan` reported an enabled experimental section. NOTHING asserted it: `git grep
 * "EXPERIMENTAL: this document declares"` returned the source line and nothing else, so the banner
 * could have been deleted in a refactor and no lane would have noticed. Meanwhile
 * `docs/cli-reference.md` — the page an operator reads instead of the source — contained the word
 * "experimental" zero times.
 *
 * This file closes both. It drives the REAL entry point (`main`), not the banner function, because
 * the property that matters is composite: the banner fires, it lands on **stderr**, and stdout
 * stays exactly one JSON object (the documented CLI contract — a banner on stdout would corrupt
 * every `| jq` in existence).
 *
 * THE FLAG IS SET ON `process.env` INSIDE EACH TEST AND RESTORED IN A `finally`. It must NEVER be
 * exported into the shell around a test run: `workforce-flag.test.ts` asserts the flag-UNSET
 * refusal by reading the ambient environment, and an exported flag would make that suite pass for
 * the wrong reason. Same discipline `index.test.ts` uses for `SHADOW_DATABASE_URL`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const readRepo = (rel: string): string => readFileSync(resolve(here, `../../../../${rel}`), 'utf8');

const FLAG = 'RAYSPEC_EXPERIMENTAL_WORKFORCE';

/** The banner's load-bearing sentences — the ones an operator has to actually see. */
const BANNER_HEADLINE = 'EXPERIMENTAL: this document declares';
const BANNER_FLAG_LINE = `Enabled by ${FLAG}`;
const BANNER_NO_STABILITY = 'Not a stability surface';

const WORKFORCE_SPEC = `
version: '1.0'
metadata:
  name: banner-test
deployment:
  durableWorker: true
agents:
  - id: lead_agent
    name: lead_agent
    backend: openai
    model: gpt-4o-mini
    instructions: Coordinate.
workforce:
  id: helpdesk
  name: Helpdesk
  orchestrator: lead
  employees:
    - id: lead
      agent: lead_agent
      title: Lead
      role: orchestrator
`;

const PLAIN_SPEC = `
version: '1.0'
metadata:
  name: plain
`;

let dir: string;
let prevCwd: string;
let outChunks: string[];
let errChunks: string[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rayspec-exp-banner-'));
  writeFileSync(join(dir, 'workforce.yaml'), WORKFORCE_SPEC, 'utf8');
  writeFileSync(join(dir, 'plain.yaml'), PLAIN_SPEC, 'utf8');
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  outChunks = [];
  errChunks = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    outChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown, cb?: unknown): boolean => {
    errChunks.push(String(chunk));
    if (typeof cb === 'function') (cb as (e?: Error) => void)();
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Run `main` with the experimental flag set for exactly the duration of the call. Restores the
 * previous value — including ABSENCE, which must be restored by `delete` and not by assigning
 * `undefined` (that writes the literal string "undefined", which the truthiness rule reads as OFF
 * but which is not the same environment).
 */
async function withFlag(args: readonly string[]): Promise<number> {
  const prev = process.env[FLAG];
  process.env[FLAG] = '1';
  try {
    return await main(args);
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

describe('the CLI banner tells an operator the section is experimental', () => {
  it('doctor over a workforce document prints the banner to STDERR', async () => {
    const code = await withFlag(['doctor', 'workforce.yaml']);
    expect(code).toBe(0);
    const err = errChunks.join('');
    expect(err).toContain(BANNER_HEADLINE);
    expect(err).toContain("'workforce:'");
    expect(err).toContain(BANNER_FLAG_LINE);
    expect(err).toContain(BANNER_NO_STABILITY);
  });

  it('…and stdout stays EXACTLY one JSON object (the documented CLI contract)', async () => {
    await withFlag(['doctor', 'workforce.yaml']);
    const out = outChunks.join('');
    expect(out).not.toContain(BANNER_HEADLINE);
    const parsed = JSON.parse(out) as { ok: boolean; experimental?: readonly string[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.experimental).toEqual(['workforce']);
  });

  it('plan over a workforce document prints it too', async () => {
    const prevShadow = process.env.SHADOW_DATABASE_URL;
    delete process.env.SHADOW_DATABASE_URL;
    try {
      const code = await withFlag(['plan', 'workforce.yaml']);
      expect(code).toBe(0);
      expect(errChunks.join('')).toContain(BANNER_HEADLINE);
    } finally {
      if (prevShadow === undefined) delete process.env.SHADOW_DATABASE_URL;
      else process.env.SHADOW_DATABASE_URL = prevShadow;
    }
  });

  it('NEGATIVE CONTROL: a workforce-free document under the SAME flag prints nothing on stderr', async () => {
    const code = await withFlag(['doctor', 'plain.yaml']);
    expect(code).toBe(0);
    expect(errChunks.join('')).toBe('');
  });

  it('NEGATIVE CONTROL: with the flag unset the document is REFUSED, not silently banner-less', async () => {
    const prev = process.env[FLAG];
    delete process.env[FLAG];
    try {
      const code = await main(['doctor', 'workforce.yaml']);
      expect(code).toBe(1);
      const parsed = JSON.parse(outChunks.join('')) as {
        ok: boolean;
        errors: Array<{ code: string }>;
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.errors.map((e) => e.code)).toContain('experimental_section_disabled');
      expect(errChunks.join('')).toBe('');
    } finally {
      if (prev !== undefined) process.env[FLAG] = prev;
    }
  });
});

describe('docs/cli-reference.md tells the same operator the same thing', () => {
  it('the workforce command group is marked experimental and names the flag', () => {
    const page = readRepo('docs/cli-reference.md');
    const heading = page.indexOf('## `workforce` — operate the durable task engine');
    expect(heading, 'the workforce heading moved or was reworded').toBeGreaterThan(-1);
    const nextHeading = page.indexOf('\n## ', heading + 1);
    const section = page.slice(heading, nextHeading === -1 ? undefined : nextHeading);
    expect(section).toContain('EXPERIMENTAL');
    expect(section).toContain(FLAG);
    expect(section).toContain('workforce-compatibility.md');
  });

  it('the doctor/plan pages document the stderr banner those commands actually print', () => {
    const page = readRepo('docs/cli-reference.md');
    expect(page).toContain(BANNER_HEADLINE);
    // Documented as STDERR, because the whole point is that stdout stays parseable.
    const at = page.indexOf(BANNER_HEADLINE);
    expect(page.slice(Math.max(0, at - 600), at + 600)).toContain('stderr');
  });
});

describe('the forward-compatibility page pins the CLI row', () => {
  it('quotes the banner headline the CLI actually prints', () => {
    expect(readRepo('docs/workforce-compatibility.md')).toContain(BANNER_HEADLINE);
  });
});
