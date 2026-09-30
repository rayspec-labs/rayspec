/**
 * The addon check reads a binary's header and registration symbol and never loads it.
 */
import { describe, expect, it } from 'vitest';
import {
  inspectAddon,
  NODE_22_MODULE_VERSION,
  nativeBinaryPlatform,
  packagePlatformExclusion,
} from './native.js';
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

/** The first bytes of a Windows PE file: the DOS header pointing at the PE signature. */
function peBinary(): Uint8Array {
  const bytes = Buffer.alloc(0x100);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  return bytes;
}

describe('nativeBinaryPlatform', () => {
  it('names the platform of an ELF, Mach-O or PE binary of any kind', () => {
    const executable = Buffer.from(elfAddon());
    executable.writeUInt16LE(2, 16);
    expect(nativeBinaryPlatform(elfAddon())).toBe('linux/x64');
    expect(nativeBinaryPlatform(executable)).toBe('linux/x64');
    expect(nativeBinaryPlatform(elfAddon({ machine: 183 }))).toBe('linux/arm64');
    expect(nativeBinaryPlatform(machOAddon())).toBe('macOS');
    const universal = Buffer.alloc(16);
    universal.writeUInt32BE(0xcafebabe, 0);
    universal.writeUInt32BE(2, 4);
    expect(nativeBinaryPlatform(universal)).toBe('macOS (universal binary)');
    expect(nativeBinaryPlatform(peBinary())).toBe('Windows');
  });

  it('leaves text, a Java class file and an MZ text with no PE header alone', () => {
    expect(nativeBinaryPlatform(Buffer.from('#!/usr/bin/env node\n'))).toBeUndefined();
    const javaClass = Buffer.alloc(16);
    javaClass.writeUInt32BE(0xcafebabe, 0);
    javaClass.writeUInt32BE(52, 4);
    expect(nativeBinaryPlatform(javaClass)).toBeUndefined();
    expect(
      nativeBinaryPlatform(Buffer.from('MZ is how this text starts'.padEnd(128))),
    ).toBeUndefined();
    expect(nativeBinaryPlatform(new Uint8Array())).toBeUndefined();
  });
});

describe('packagePlatformExclusion', () => {
  it.each([
    [{}, undefined],
    [{ os: ['linux'], cpu: ['x64'] }, undefined],
    [{ os: ['linux', 'darwin'] }, undefined],
    [{ os: ['!win32'], cpu: ['!arm64'] }, undefined],
    [{ os: 'linux' }, undefined],
    [{ os: ['darwin'], cpu: ['arm64'] }, 'darwin / arm64'],
    [{ os: ['!linux'] }, '!linux / any cpu'],
    [{ cpu: ['arm64'] }, 'any os / arm64'],
    [{ os: ['linux'], cpu: ['!x64'] }, 'linux / !x64'],
  ])('%j excludes linux/x64: %s', (manifest, expected) => {
    expect(packagePlatformExclusion(manifest)).toBe(expected);
  });
});
