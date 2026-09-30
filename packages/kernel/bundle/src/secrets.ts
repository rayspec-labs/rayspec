/**
 * The secret scan of the bundle contract. pack and verify run this one rule set, so the two never
 * disagree on a verdict:
 *
 *   - a payload path whose last segment is `.env`, starts with `.env.`, or is `id_rsa`,
 *     `id_ecdsa`, `id_ed25519` or `.pgpass`;
 *   - a payload file containing a PEM private-key header: `-----BEGIN `, optional words of
 *     uppercase letters and digits (`RSA`, `SM2`, `X25519`) each followed by a space, then
 *     `PRIVATE KEY-----`.
 *
 * A finding names the path and the rule, never the content. The content rule runs as a small
 * automaton over the bytes as they stream, so a header split across two reads is still found and
 * no file is held in memory.
 */

export type SecretRule = 'secret-path' | 'private-key';

export interface SecretFinding {
  /** The inventory path of the file. */
  path: string;
  rule: SecretRule;
}

const SECRET_FILE_NAMES = new Set(['.env', 'id_rsa', 'id_ecdsa', 'id_ed25519', '.pgpass']);

/** Whether a payload path is refused by name alone. */
export function isSecretPath(path: string): boolean {
  const last = path.slice(path.lastIndexOf('/') + 1);
  return SECRET_FILE_NAMES.has(last) || last.startsWith('.env.');
}

// ─── private-key header ────────────────────────────────────────────────────────────────────────

const PREFIX = Buffer.from('-----BEGIN ', 'ascii');
const SUFFIX = Buffer.from('PRIVATE KEY-----', 'ascii');

// States of the non-deterministic automaton, one bit each:
//   bits 0..10   PREFIX matched up to that length (bit 0: nothing matched; always active);
//   bit 11       at the start of a word, right after the prefix or after a word and its space;
//   bit 12       inside a word;
//   bits 13..28  SUFFIX matched up to length 1..16; bit 28 is the accepting state.
const WORD_START = 11;
const IN_WORD = 12;
const SUFFIX_BASE = 12;
const ACCEPT = SUFFIX_BASE + SUFFIX.length;

/** A byte a word of the header may hold: A to Z or 0 to 9. */
const isWordByte = (b: number) => (b >= 0x41 && b <= 0x5a) || (b >= 0x30 && b <= 0x39);

function step(states: number, byte: number): number {
  let next = 1; // the scan may start anywhere
  for (let i = 0; i < PREFIX.length; i++) {
    if (states & (1 << i) && PREFIX[i] === byte) {
      next |= 1 << (i + 1 === PREFIX.length ? WORD_START : i + 1);
    }
  }
  if (states & (1 << WORD_START)) {
    if (isWordByte(byte)) next |= 1 << IN_WORD;
    if (byte === SUFFIX[0]) next |= 1 << (SUFFIX_BASE + 1);
  }
  if (states & (1 << IN_WORD)) {
    if (isWordByte(byte)) next |= 1 << IN_WORD;
    if (byte === 0x20) next |= 1 << WORD_START;
  }
  for (let j = 1; j < SUFFIX.length; j++) {
    if (states & (1 << (SUFFIX_BASE + j)) && SUFFIX[j] === byte) next |= 1 << (SUFFIX_BASE + j + 1);
  }
  return next;
}

/** The deterministic transitions, built as state sets are reached and shared by every scanner. */
const transitions = new Map<number, Int32Array>();

function next(states: number, byte: number): number {
  let row = transitions.get(states);
  if (row === undefined) {
    row = new Int32Array(256).fill(-1);
    transitions.set(states, row);
  }
  let to = row[byte]!;
  if (to < 0) {
    to = step(states, byte);
    row[byte] = to;
  }
  return to;
}

const INITIAL = 1;
const DASH = 0x2d;

/** Scans one file's bytes, fed in any number of chunks, for a PEM private-key header. */
export class PrivateKeyScanner {
  private states = INITIAL;
  private matched = false;

  update(chunk: Uint8Array): void {
    if (this.matched) return;
    let states = this.states;
    let i = 0;
    while (i < chunk.length) {
      if (states === INITIAL) {
        // Only a dash leaves the initial state, so skip straight to the next one.
        const at = chunk.indexOf(DASH, i);
        if (at < 0) break;
        i = at;
      }
      states = next(states, chunk[i]!);
      i++;
      if (states & (1 << ACCEPT)) {
        this.matched = true;
        return;
      }
    }
    this.states = states;
  }

  /** Whether a header has been seen in the bytes fed so far. */
  get found(): boolean {
    return this.matched;
  }
}
