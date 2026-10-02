/**
 * Load the team-notes seed into a running deployment through its API, as the two users, and read
 * the whole store back page by page to check the inventory.
 *
 *   node examples/team-notes/seed/load-seed.mjs --base=<url> --first-token-file=<f> --second-token-file=<f>
 *
 * Each token file holds an organization-scoped access token of one of the two users (see the
 * README). Each create carries the note's `key` as its Idempotency-Key, so running the load again
 * replays the existing rows instead of adding new ones. Exit 0 when the store's inventory equals the
 * seed's, 1 otherwise. Needs Node only.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryOf } from './build-seed.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Create every seed note as its user. Returns the number of rows created (not replayed). */
export async function loadSeed(base, tokens, seed) {
  let created = 0;
  for (const note of seed.notes) {
    const res = await fetch(new URL('/api/notes', base), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens[note.author]}`,
        'content-type': 'application/json',
        'idempotency-key': note.key,
      },
      body: JSON.stringify({ title: note.title, content: note.content }),
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`creating ${note.key} answered ${res.status}`);
    }
    if (res.status === 201) created += 1;
  }
  return created;
}

/** Every note of the tenant, read by keyset pages of `limit`. */
export async function readAll(base, token, limit = 30) {
  const notes = [];
  let after = null;
  for (;;) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (after !== null) query.set('after', after);
    const res = await fetch(new URL(`/api/notes?${query}`, base), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`listing notes answered ${res.status}`);
    const page = await res.json();
    notes.push(...page);
    if (page.length < limit) return notes;
    after = res.headers.get('x-next-cursor');
    if (after === null) throw new Error('a full page carried no X-Next-Cursor');
  }
}

function arg(name) {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
}

// Run as a script, also through a symlinked path (macOS /tmp, /var/folders): the module's own path is
// the real one, so the argument is compared as its real path too.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const base = arg('base');
  const firstFile = arg('first-token-file');
  const secondFile = arg('second-token-file');
  if (!base || !firstFile || !secondFile) {
    console.error(
      'usage: node load-seed.mjs --base=<url> --first-token-file=<f> --second-token-file=<f>',
    );
    process.exit(2);
  }
  const seed = JSON.parse(readFileSync(join(here, 'notes.json'), 'utf8'));
  const tokens = {
    first: readFileSync(firstFile, 'utf8').trim(),
    second: readFileSync(secondFile, 'utf8').trim(),
  };
  const created = await loadSeed(base, tokens, seed);
  const stored = await readAll(base, tokens.first);
  const actual = inventoryOf(stored, (note) => note.created_by);
  const ok = actual.notes === seed.inventory.notes && actual.digest === seed.inventory.digest;
  console.log(JSON.stringify({ created, expected: seed.inventory, actual, ok }, null, 2));
  process.exit(ok ? 0 : 1);
}
