/**
 * Writes the golden fixture corpus into `corpus/`: one file per committed case of
 * `contract/fixtures/EXPECTATIONS.json` (`<id>.ray`, or `<id>.bin` for a raw-bytes case) and one
 * `<id>.ray.sig` per signature case.
 *
 * Usage: tsx scripts/gen-corpus.ts
 *        tsx scripts/gen-corpus.ts --uncommitted <dir>
 *
 * `--uncommitted` writes only the cases that are not committed (generated at test time, such as the
 * 10,005-entry archive) into `<dir>`, under the file names the committed cases use, for a run of
 * the corpus against an installed CLI. `corpus/` is left as it is.
 *
 * Refuses to write when a built case differs from the size and SHA-256 its expectation records,
 * so the corpus on disk always matches the contract. `corpus.test.ts` rebuilds the same bytes and
 * compares them with what is committed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCase,
  buildCorpus,
  caseFileName,
  type Expectations,
} from '../src/test-support/corpus.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const expectations = JSON.parse(
  readFileSync(join(packageRoot, 'contract', 'fixtures', 'EXPECTATIONS.json'), 'utf8'),
) as Expectations;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const mismatches: string[] = [];
for (const c of expectations.cases) {
  const { bytes } = buildCase(expectations, c.construction);
  if (bytes.length !== c.bytes.size || sha256(bytes) !== c.bytes.sha256) {
    mismatches.push(`${c.id}: built ${bytes.length} bytes ${sha256(bytes)}`);
  }
}
const files = buildCorpus(expectations);
for (const c of expectations.cases) {
  if (!c.signatureFile) continue;
  const sig = files.get(`${caseFileName(c)}.sig`);
  if (!sig || sig.length !== c.signatureFile.size || sha256(sig) !== c.signatureFile.sha256) {
    mismatches.push(`${c.id}: signature file differs from its expectation`);
  }
}
if (mismatches.length > 0) {
  console.error('gen:corpus: refusing to write; built bytes differ from EXPECTATIONS.json:');
  for (const m of mismatches) console.error(`  ${m}`);
  process.exit(1);
}

const flag = process.argv.indexOf('--uncommitted');
if (flag >= 0) {
  const dir = process.argv[flag + 1];
  if (dir === undefined || dir.startsWith('--')) {
    console.error('gen:corpus: --uncommitted needs a directory');
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const c of expectations.cases) {
    if (c.bytes.committed) continue;
    writeFileSync(join(dir, caseFileName(c)), buildCase(expectations, c.construction).bytes);
    written++;
  }
  console.log(`gen:corpus: wrote ${written} uncommitted case(s) to ${dir}`);
  process.exit(0);
}

const out = join(packageRoot, 'corpus');
mkdirSync(out, { recursive: true });
for (const name of readdirSync(out)) rmSync(join(out, name));
for (const [name, bytes] of files) writeFileSync(join(out, name), bytes);
console.log(`gen:corpus: wrote ${files.size} files to ${out}`);
