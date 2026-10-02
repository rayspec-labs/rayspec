#!/usr/bin/env node
/**
 * Fixture-neutrality gate — the forcing function that keeps the neutral open-core reference product
 * (`examples/acme-notes/**`) and the three reference applications (`examples/team-notes/**`,
 * `examples/document-intake/**`, `examples/asset-catalog/**`) free of any product-domain MEANING.
 * The neutral fixtures are what the platform gates/goldens/e2e and the consumer journeys are pinned
 * against; if a domain word ever leaks into one, "reads as ONE product, zero domain semantics" would
 * have no CI guard on the very files that most need it.
 *
 * Scans every YAML/JSON of those trees (their installed `node_modules` and build output excepted) for
 * the forbidden domain vocabulary (word-boundary, case-insensitive) and fails on any hit. In the three
 * reference applications every text file is scanned as well — seed documents, READMEs, the UI, the
 * handlers and the scripts — since all of it ships as the example; the PDFs are generated from the
 * seed script, which is scanned. The allowed vocabulary is the neutral note/session/track
 * vocabulary + the real, product-free STT structural words (mic/system/local/remote) + the real
 * open-core provider name (deepgram — a capability, not a product) and model/provider ids.
 *
 * Fail-closed on coverage: a root that does not exist, or in which nothing is scanned, fails the gate
 * naming it, so a renamed or moved example cannot retire its own check.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
/** Each root, and the file extensions scanned in it. */
const DATA = ['.yaml', '.yml', '.json'];
const TEXT = [...DATA, '.txt', '.md', '.html', '.css', '.js', '.mjs', '.ts'];
const SCAN_ROOTS = [
  ['examples/acme-notes', DATA],
  ['examples/team-notes', TEXT],
  ['examples/document-intake', TEXT],
  ['examples/asset-catalog', TEXT],
];
/** Installed dependencies and build output are not the fixture. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist']);

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

function walk(dir, extensions) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...walk(full, extensions));
    } else if (entry.isFile() && extensions.includes(extname(entry.name))) out.push(full);
  }
  return out;
}

const files = [];
const unscanned = [];
for (const [root, extensions] of SCAN_ROOTS) {
  let found = [];
  try {
    found = walk(join(repoRoot, root), extensions);
  } catch (e) {
    if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') throw e;
  }
  if (found.length === 0) unscanned.push(root);
  files.push(...found);
}
if (unscanned.length > 0) {
  console.error(
    `❌ fixture-neutrality: nothing scanned under ${unscanned.join(', ')} — the root is missing or holds no fixture file`,
  );
  process.exit(1);
}
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
  console.error('❌ fixture-neutrality: forbidden domain word(s) in a neutral example fixture:');
  for (const h of hits) console.error(`   ${h.file}:${h.line}  [${h.word}]  ${h.text}`);
  process.exit(1);
}

console.log(
  `✅ fixture-neutrality: ${files.length} neutral example fixture file(s) carry no forbidden domain vocabulary.`,
);
