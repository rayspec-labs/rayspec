/**
 * THROWAWAY parity fixture-capture (doc-first, real shapes).
 *
 * Runs the SHARED parity scenarios on every backend whose credential is present and writes ONE
 * committed fixture per backend (the REAL neutral RunResult/journal/events). The deterministic
 * parity suite (parity.test.ts) asserts SHAPE parity on these REAL captures — never an imagined
 * shape. CI has no creds, so CI runs the suite on the committed fixtures; capture is a local action.
 *
 * Run locally (loads repo-root .env automatically):
 *   pnpm --filter '@rayspec/*' build && pnpm tsx packages/test/parity/scripts/capture-parity.mts
 *   (OPENAI_API_KEY -> openai + pi ; CLAUDE_CODE_OAUTH_TOKEN -> anthropic)
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnthropicAdapter } from '@rayspec/adapter-anthropic';
import { CodexAdapter } from '@rayspec/adapter-codex';
import { OpenAIAdapter } from '@rayspec/adapter-openai';
import { PiAdapter } from '@rayspec/adapter-pi';
import type { Backend } from '@rayspec/core';
import { config } from 'dotenv';
import { captureRun } from '../src/harness.js';
import type { CapturedRun } from '../src/index.js';
import { scenariosForModel } from '../src/scenarios.js';
import { captureSdkVersions, installedSdkVersion } from '../src/sdk-versions.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const envPath = join(repoRoot, '.env');
if (existsSync(envPath)) config({ path: envPath });

const fixturesDir = join(here, '..', 'src', '__fixtures__');
mkdirSync(fixturesDir, { recursive: true });

async function captureBackend(
  backend: Backend,
  model: string,
  fixtureName: string,
  sdkBackend: 'openai' | 'anthropic' | 'pi' | 'codex',
): Promise<void> {
  const runs: CapturedRun[] = [];
  for (const scenario of scenariosForModel(model)) {
    process.stdout.write(`  [${backend.id}] ${scenario.name} ... `);
    try {
      const run = await captureRun(backend, scenario);
      runs.push(run);
      console.log(
        `status=${run.result.status} steps=${run.result.stepCount} ` +
          `parts=${run.result.conversation.flatMap((t) => t.parts).length} events=${run.events.length}`,
      );
    } catch (err) {
      console.log(`THREW (captured as error scenario): ${String(err).slice(0, 80)}`);
    }
  }
  const out = join(fixturesDir, fixtureName);
  // STAMP the installed pinned SDK version this fixture was recorded against: the
  // version-bump-re-record RULE asserts this equals the INSTALLED version, so a bump without a
  // re-record fails CI. `sdkVersions` carries every backend's version (the cross-backend gate reads
  // all three); `sdkVersion` is THIS backend's, for a precise per-fixture assertion.
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        sdkVersion: installedSdkVersion(sdkBackend),
        // The cross-backend stamp carries EVERY backend's installed version (now four).
        sdkVersions: captureSdkVersions(),
        runs,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${out} (${runs.length} scenarios)`);
}

const openaiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

if (openaiKey) {
  console.log('== OpenAI ==');
  await captureBackend(
    new OpenAIAdapter({ apiKey: openaiKey }),
    openaiModel,
    'openai-parity.json',
    'openai',
  );
  console.log('== Pi (OpenAI key) ==');
  await captureBackend(new PiAdapter({ apiKey: openaiKey }), openaiModel, 'pi-parity.json', 'pi');
} else {
  console.log('OPENAI_API_KEY absent -> skipping openai + pi capture');
}

if (oauthToken) {
  console.log('== Anthropic (subscription official-harness) ==');
  const configRoot = mkdtempSync(join(tmpdir(), 'rayspec-parity-anth-'));
  await captureBackend(
    new AnthropicAdapter({ configRoot }),
    'claude-haiku-4-5',
    'anthropic-parity.json',
    'anthropic',
  );
} else {
  console.log('CLAUDE_CODE_OAUTH_TOKEN absent -> skipping anthropic capture');
}

// Codex runs on the ChatGPT OAuth SUBSCRIPTION (no key) — capture iff ~/.codex/auth.json is a live
// OAuth session. The codex subscription model is gpt-5.5 (the config.toml default). resolveAuth() is the
// gate: an absent/api-key auth.json yields 'unauthenticated', so we probe it before spending.
const codexModel = process.env.CODEX_MODEL || 'gpt-5.5';
{
  const codex = new CodexAdapter();
  const codexAuth = await codex.resolveAuth();
  if (codexAuth === 'codex-subscription-oauth') {
    console.log('== Codex (ChatGPT OAuth subscription) ==');
    await captureBackend(codex, codexModel, 'codex-parity.json', 'codex');
  } else {
    console.log(`codex OAuth session absent (resolveAuth=${codexAuth}) -> skipping codex capture`);
  }
}

console.log('done.');
