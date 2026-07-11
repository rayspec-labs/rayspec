#!/usr/bin/env node
/**
 * Fixture-neutrality gate — the forcing function that keeps the neutral open-core reference product
 * (`examples/acme-notes/**`) free of any product-domain MEANING. The neutral fixture is what the
 * platform gates/goldens/e2e are pinned against; if a domain word ever leaks into it, "reads as ONE
 * product, zero domain semantics" would have no CI guard on the very files that most need it.
 *
 * Scans every acme-notes YAML/JSON for the forbidden domain vocabulary (word-boundary,
 * case-insensitive) and fails on any hit. The allowed vocabulary is the neutral note/session/track
 * vocabulary + the real, product-free STT structural words (mic/system/local/remote) + the real
 * open-core provider name (deepgram — a capability, not a product) and model/provider ids.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SCAN_ROOT = join(repoRoot, 'examples/acme-notes');

// The forbidden domain-MEANING vocabulary — unambiguous product-domain words the neutral fixture
// must NEVER carry (the meeting/decision/action/intelligence domain + adjacent product domains).
// Deliberately EXCLUDED to avoid false positives on legitimate open-core vocab:
//   - `contract`/`session`/`track`/`transcript`/`span` — grammar / structural keywords;
//   - `deepgram`/`nova`/`openai`/`gpt` — real open-core provider/model ids;
//   - `mic`/`system`/`local`/`remote` — real STT structural enum values;
//   - `recording` — a real audio-session STATUS enum value (a session IS "recording");
//   - `candidate` — standard extraction vocab (the "candidate" model output);
//   - `claim` — generic English (an assertion), distinct from the expense-claim product.
const FORBIDDEN = [
  'meeting',
  'decision',
  'action_item',
  'action item',
  'intelligence',
  'open_question',
  'transcription',
  'invoice',
  'expense',
  'recruiting',
  'screener',
  'chat',
];
const FORBIDDEN_RE = new RegExp(
  `\\b(${FORBIDDEN.map((w) => w.replace(/[_ ]/g, '[_ ]')).join('|')})\\b`,
  'i',
);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (['.yaml', '.yml', '.json'].includes(extname(full))) out.push(full);
  }
  return out;
}

const files = walk(SCAN_ROOT);
const hits = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const m = line.match(FORBIDDEN_RE);
    if (m)
      hits.push({ file: relative(repoRoot, file), line: i + 1, word: m[1], text: line.trim() });
  });
}

if (hits.length > 0) {
  console.error(
    '❌ fixture-neutrality: forbidden domain word(s) in the neutral acme-notes fixture:',
  );
  for (const h of hits) console.error(`   ${h.file}:${h.line}  [${h.word}]  ${h.text}`);
  process.exit(1);
}

console.log(
  `✅ fixture-neutrality: ${files.length} acme-notes fixture file(s) carry no forbidden domain vocabulary.`,
);
