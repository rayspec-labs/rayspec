/**
 * Every place in the shipped source that opens an outbound connection by itself, held equal to a
 * reviewed list. A new call site fails this test until it is either routed through `guardedFetch`
 * (a URL from a spec, a bundle or a request) or added here with the reason its destination is chosen
 * by the operator. Requests the model SDKs make inside the agent adapters are not visible here; their
 * endpoints come from the operator's environment (`OPENAI_BASE_URL` and the like are reserved
 * operator names that no bundle can set).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../../', import.meta.url));

/** What counts as opening an outbound connection. */
const OUTBOUND_CALLS: readonly RegExp[] = [
  /(?<![.\w])fetch\s*\(/,
  /\bfetchImpl\s*\(/,
  /\b(?:http|https)\.(?:request|get)\s*\(/,
  /import\s*\{[^}]*\b(?:request|get)\b[^}]*\}\s*from\s*'node:https?'/,
  /from\s*'undici'|import\('undici'\)/,
  /\b(?:net|tls)\.(?:connect|createConnection)\s*\(/,
];

/** The reviewed call sites, each with why its destination is not a URL a customer chose. */
const REVIEWED: Readonly<Record<string, string>> = {
  'adapters/deepgram/src/deepgram-adapter.ts':
    'the Deepgram API; the endpoint is the operator-reserved DEEPGRAM_BASE_URL or the fixed default',
  'adapters/openai-tts/src/openai-tts-adapter.ts':
    'the OpenAI speech API; the endpoint is the operator-reserved OPENAI_BASE_URL or the fixed default',
  'app/cli/src/dev/bootstrap-tenant.ts':
    "the operator's own server, named on the operator's command line (local development)",
  'app/server/src/proxy-dispatcher.ts':
    "installs the environment proxy as the process's dispatcher; it makes no request",
  'kernel/platform/src/outbound-guard.ts': 'the guard itself',
};

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'test-support', '__fixtures__'].includes(entry.name)) continue;
      sourceFiles(path, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts') &&
      path.split(sep).includes('src')
    ) {
      out.push(path);
    }
  }
  return out;
}

describe('outbound call sites', () => {
  const found = sourceFiles(PACKAGES)
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return OUTBOUND_CALLS.some((call) => call.test(text));
    })
    .map((file) => relative(PACKAGES, file).split(sep).join('/'))
    .sort();

  it('are exactly the reviewed ones', () => {
    expect(found).toEqual(Object.keys(REVIEWED).sort());
  });

  it('the scan sees a call it should see', () => {
    expect(OUTBOUND_CALLS.some((call) => call.test('const r = await fetch(url);'))).toBe(true);
    expect(OUTBOUND_CALLS.some((call) => call.test('https.request(options)'))).toBe(true);
    expect(OUTBOUND_CALLS.some((call) => call.test('obj.fetch(url)'))).toBe(false);
  });
});
