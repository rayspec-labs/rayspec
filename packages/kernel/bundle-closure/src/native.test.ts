/**
 * The addon check reads a binary's header and registration symbol and never loads it.
 */
import { describe, expect, it } from 'vitest';
import { inspectAddon, NODE_22_MODULE_VERSION } from './native.js';
import { elfAddon, machOAddon } from './test-support/app.js';

describe('inspectAddon', () => {
  it('accepts a linux/x64 shared object on Node-API or on the Node 22 ABI', () => {
    expect(inspectAddon(elfAddon())).toEqual({ ok: true });
    expect(inspectAddon(elfAddon({ osAbi: 3 }))).toEqual({ ok: true });
    expect(
      inspectAddon(elfAddon({ symbol: `node_register_module_v${NODE_22_MODULE_VERSION}` })),
    ).toEqual({ ok: true });
  });

  it.each([
    [machOAddon(), 'macOS'],
    [Buffer.from('MZ\0\0'), 'Windows'],
    [elfAddon({ machine: 183 }), 'linux/arm64'],
    [elfAddon({ machine: 3 }), 'linux/x86'],
    [elfAddon({ osAbi: 9 }), 'OS ABI 9'],
    [elfAddon({ symbol: 'node_register_module_v115' }), 'ABI 115'],
    [elfAddon({ symbol: 'something_else' }), 'no Node registration symbol'],
    [Buffer.from('#!/bin/sh\n'), 'an unknown format'],
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2]), 'truncated'],
  ])('refuses %#, naming what it was built for', (bytes, builtFor) => {
    const verdict = inspectAddon(bytes);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.builtFor).toContain(builtFor);
  });

  it('refuses a 32-bit or big-endian linux binary even on x64', () => {
    const bits32 = Buffer.from(elfAddon());
    bits32[4] = 1;
    expect(inspectAddon(bits32).ok).toBe(false);
    const executable = Buffer.from(elfAddon());
    executable.writeUInt16LE(2, 16);
    const verdict = inspectAddon(executable);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.builtFor).toContain('not a shared object');
  });
});
