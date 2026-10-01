/**
 * Build the document-intake seed: 50 documents (40 plain-text, 10 text-layer PDF) under
 * `seed/documents/`, and `seed/manifest.json` naming each document's file id, content type, size,
 * SHA-256 and the record the application is expected to persist for it, plus the inventory the whole
 * seed adds up to.
 *
 * Everything is derived from the document index, so the output is the same bytes on every run and
 * on every machine: no clock, no randomness. The committed seed is this script's output; the test
 * suite rebuilds it into a temporary directory and compares byte for byte.
 *
 * Run: `node examples/document-intake/seed/build-seed.mjs` (or `--out=<dir>` to write elsewhere).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outArg = process.argv
  .slice(2)
  .find((a) => a.startsWith('--out='))
  ?.slice('--out='.length);
const outDir = outArg ? (isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg)) : here;

export const DOCUMENT_COUNT = 50;
export const PDF_EVERY = 5; // every fifth document is a PDF: 10 of 50

const TITLES = [
  'Shelf inventory',
  'Workshop supplies',
  'Größe M uniforms',
  'Café corner restock',
  'Garden tools',
  'Archive boxes',
  'Résumé folders',
  'Window cleaning kit',
  'Spare cables',
  'Paint samples',
];
const CATEGORIES = ['storage', 'workshop', 'office', null, 'garden'];
const ITEMS = ['bolts', 'brackets', 'labels', 'folders', 'tape', 'gloves', 'clips', 'hooks'];

/** The record document `n` (1-based) carries. PDFs stay ASCII: the minimal PDF font is Latin-1. */
export function recordFor(n) {
  const pdf = n % PDF_EVERY === 0;
  const baseTitle = TITLES[(n - 1) % TITLES.length];
  const title = pdf ? baseTitle.normalize('NFKD').replace(/[^\x20-\x7e]/g, '') : baseTitle;
  const lineCount = n % 4;
  const lines = [];
  for (let i = 0; i < lineCount; i += 1) {
    lines.push({
      description: ITEMS[(n + i) % ITEMS.length],
      count: (n + i) % 3 === 0 ? null : ((n * 7 + i * 3) % 40) + 1,
    });
  }
  const day = String(((n - 1) % 28) + 1).padStart(2, '0');
  return {
    reference: `REF-${String(n).padStart(4, '0')}`,
    title: `${title} ${n}`,
    category: CATEGORIES[n % CATEGORIES.length],
    quantity: (n * 13) % 97,
    received_on: n % 6 === 0 ? null : `2026-0${(n % 9) + 1}-${day}`,
    lines,
  };
}

/** The labelled lines a document renders its record as. */
export function labelledLines(record) {
  const out = [`Reference: ${record.reference}`, `Title: ${record.title}`];
  if (record.category !== null) out.push(`Category: ${record.category}`);
  out.push(`Quantity: ${record.quantity}`);
  if (record.received_on !== null) out.push(`Received on: ${record.received_on}`);
  for (const line of record.lines) {
    out.push(`Lines: ${line.description} | ${line.count === null ? '' : line.count}`);
  }
  return out;
}

/** A minimal, valid single-xref PDF with one text-layer page per line (Latin-1 text only). */
export function buildPdf(pageTexts) {
  const objects = [];
  objects.push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  const kids = pageTexts.map((_, i) => `${4 + 2 * i} 0 R`).join(' ');
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>\nendobj\n`);
  objects.push('3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n');
  pageTexts.forEach((text, i) => {
    const pageNum = 4 + 2 * i;
    const contentNum = 5 + 2 * i;
    objects.push(
      `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`,
    );
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([\\()])/g, '\\$1')}) Tj ET`;
    objects.push(
      `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  });
  let body = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(body.length);
    body += obj;
  }
  const xrefStart = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, 'latin1');
}

/** Every seed document: its manifest entry and its bytes. */
export function seedDocuments() {
  const documents = [];
  for (let n = 1; n <= DOCUMENT_COUNT; n += 1) {
    const record = recordFor(n);
    const pdf = n % PDF_EVERY === 0;
    const lines = labelledLines(record);
    const bytes = pdf ? buildPdf(lines) : Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    const fileId = `doc-${String(n).padStart(3, '0')}`;
    documents.push({
      entry: {
        file_id: fileId,
        file: `documents/${fileId}.${pdf ? 'pdf' : 'txt'}`,
        content_type: pdf ? 'application/pdf' : 'text/plain',
        size_bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        expected: record,
      },
      bytes,
    });
  }
  return documents;
}

/** The inventory the seed adds up to, which a deployment holding it must reproduce. */
export function inventoryOf(entries) {
  return {
    documents: entries.length,
    text: entries.filter((e) => e.content_type === 'text/plain').length,
    pdf: entries.filter((e) => e.content_type === 'application/pdf').length,
    total_quantity: entries.reduce((sum, e) => sum + e.expected.quantity, 0),
    total_lines: entries.reduce((sum, e) => sum + e.expected.lines.length, 0),
    without_category: entries.filter((e) => e.expected.category === null).length,
    without_received_on: entries.filter((e) => e.expected.received_on === null).length,
  };
}

/** Write the seed under `dir`. */
export function writeSeed(dir) {
  const documents = seedDocuments();
  rmSync(join(dir, 'documents'), { recursive: true, force: true });
  mkdirSync(join(dir, 'documents'), { recursive: true });
  for (const { entry, bytes } of documents) writeFileSync(join(dir, entry.file), bytes);
  const entries = documents.map((d) => d.entry);
  const manifest = { seedFormatVersion: 1, inventory: inventoryOf(entries), documents: entries };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = writeSeed(outDir);
  console.log(
    `document-intake seed: ${manifest.inventory.documents} documents -> ${join(outDir, 'documents')}`,
  );
}
