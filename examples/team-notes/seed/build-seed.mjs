/**
 * Build the team-notes seed: 100 notes split between two users, written to `seed/notes.json`
 * together with the inventory a deployment holding exactly those notes must reproduce.
 *
 * Each note has a stable `key` (sent as the create's Idempotency-Key, so loading the seed twice
 * creates nothing new), the user that creates it (`first` or `second`), a title and content. Some
 * titles and contents are non-ASCII. Everything is derived from the note index: the same bytes on
 * every run, no clock, no randomness.
 *
 * The inventory: the note count, the count per user, and `digest` — the SHA-256 of the JSON array
 * of `[title, content]` pairs sorted by title, then content (code-point order). Counts alone would
 * not notice a changed or swapped value; the digest does.
 *
 * Run: `node examples/team-notes/seed/build-seed.mjs` (or `--out=<file>`).
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const NOTE_COUNT = 100;

const SUBJECTS = [
  'Weekly planning',
  'Release checklist',
  'Ideas for the café wall',
  'Übergabe an das Team',
  'Reading list',
  'Onboarding steps',
  'Kitchen rota',
  'Notes from the 東京 office',
  'Hardware inventory',
  'Résumé review',
];

/** The note with 1-based index `n`. */
export function noteFor(n) {
  const subject = SUBJECTS[(n - 1) % SUBJECTS.length];
  return {
    key: `note-${String(n).padStart(3, '0')}`,
    author: n % 2 === 1 ? 'first' : 'second',
    title: `${subject} #${n}`,
    content:
      n % 7 === 0
        ? `Mehrzeilig — Zeile 1\nZeile 2 für Notiz ${n} ✓`
        : `Note ${n}: ${'detail '.repeat((n % 5) + 1).trim()}.`,
  };
}

/** Code-point order, the order the digest sorts by. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The inventory of a list of notes (any objects with `title` and `content`). */
export function inventoryOf(notes, authorOf = (note) => note.author) {
  const pairs = notes
    .map((note) => [note.title, note.content])
    .sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  const byAuthor = {};
  for (const note of notes) byAuthor[authorOf(note)] = (byAuthor[authorOf(note)] ?? 0) + 1;
  return {
    notes: notes.length,
    byAuthor: Object.fromEntries(Object.entries(byAuthor).sort((a, b) => compare(a[0], b[0]))),
    digest: createHash('sha256').update(JSON.stringify(pairs)).digest('hex'),
  };
}

export function seedNotes() {
  const notes = [];
  for (let n = 1; n <= NOTE_COUNT; n += 1) notes.push(noteFor(n));
  return notes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outArg = process.argv
    .slice(2)
    .find((a) => a.startsWith('--out='))
    ?.slice('--out='.length);
  const out = outArg
    ? isAbsolute(outArg)
      ? outArg
      : resolve(process.cwd(), outArg)
    : join(here, 'notes.json');
  const notes = seedNotes();
  const seed = { seedFormatVersion: 1, inventory: inventoryOf(notes), notes };
  writeFileSync(out, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`team-notes seed: ${notes.length} notes -> ${out}`);
}
