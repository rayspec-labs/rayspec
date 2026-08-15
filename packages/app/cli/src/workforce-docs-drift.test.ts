/**
 * The workforce CLI surface is DRIFT-LOCKED three ways against its documentation: every flag the
 * group's parsers declare appears in docs/cli-reference.md's synopsis fence AND in the built-in
 * help block; every `--flag` the synopsis advertises is one the parsers declare; and the parser
 * itself re-proves the extraction (a declared flag parses, an invented one is refused as usage —
 * the accept control that keeps the extraction honest). Names are matched whole-token, so
 * `--root` is never satisfied by a longer spelling that happens to start with it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runWorkforce } from './workforce.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, rel), 'utf8');

const TRANSPORT_FLAGS = new Set(['url', 'api-key', 'deployment', 'tenant']);

/**
 * Every option name workforce.ts declares — matched by the DESCRIPTOR shape
 * (`<key>: { type: 'string' | 'boolean' }`), which is what `parseArgs` options are and nothing
 * else in the module looks like. Transport flags land in the set too; the assertions treat them
 * as documented once, under "[transport flags]".
 */
function declaredFlags(): Set<string> {
  const source = read('./workforce.ts');
  const flags = new Set<string>();
  for (const match of source.matchAll(
    /(?:'([a-z-]+)'|\b([a-z]+)):\s*\{\s*type:\s*'(?:string|boolean)'\s*\}/g,
  )) {
    flags.add((match[1] ?? match[2]) as string);
  }
  return flags;
}

/** The synopsis fence under the workforce heading in docs/cli-reference.md. */
function synopsisFence(): string {
  const doc = read('../../../../docs/cli-reference.md');
  const heading = doc.indexOf('## `workforce` — operate the durable task engine');
  expect(heading, 'the workforce heading moved or was reworded').toBeGreaterThan(-1);
  const section = doc.slice(heading, doc.indexOf('\n## ', heading + 1));
  const fence = /```\n([\s\S]*?)\n```/.exec(section)?.[1];
  expect(fence, 'no synopsis fence under the workforce heading').toBeDefined();
  return fence as string;
}

/** The workforce help block in the CLI's own usage text. */
function helpBlock(): string {
  const source = read('./index.ts');
  const at = source.indexOf('rayspec workforce <status|');
  expect(at, 'the workforce help block moved').toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('`,', at));
}

const wholeToken = (text: string, flag: string): boolean =>
  new RegExp(`--${flag}(?![\\w-])`).test(text);

describe('the workforce CLI surface vs its documentation', () => {
  it('every declared flag is documented in the synopsis AND the built-in help', () => {
    const fence = synopsisFence();
    const help = helpBlock();
    const flags = declaredFlags();
    expect(flags.size).toBeGreaterThanOrEqual(10); // the extraction found the real tables
    for (const flag of flags) {
      if (TRANSPORT_FLAGS.has(flag)) continue; // documented once, as "[transport flags]"
      expect(wholeToken(fence, flag), `--${flag} missing from the cli-reference synopsis`).toBe(
        true,
      );
      expect(wholeToken(help, flag), `--${flag} missing from the built-in help block`).toBe(true);
    }
  });

  it('every flag the synopsis advertises is one the parsers declare', () => {
    const flags = declaredFlags();
    const advertised = [...synopsisFence().matchAll(/--([a-z-]+)/g)].map((m) => m[1] as string);
    for (const flag of advertised) {
      expect(
        flags.has(flag) || TRANSPORT_FLAGS.has(flag),
        `the synopsis advertises --${flag}, which no workforce parser declares`,
      ).toBe(true);
    }
  });

  it('the live parser re-proves the extraction: declared flags parse, invented ones are usage', async () => {
    // A DECLARED flag fails past argument parsing (at transport resolution, a different error).
    await expect(runWorkforce(['tasks', '--status', 'queued'])).rejects.not.toThrow(
      /invalid arguments/,
    );
    // The accept control: an invented flag is refused AS ARGUMENTS — proof the strict parser is
    // what the extraction above described.
    await expect(runWorkforce(['tasks', '--frobnicate'])).rejects.toThrow(/invalid arguments/);
  });
});
