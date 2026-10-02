/**
 * The blob backend record parses fail-closed: exactly one of its three shapes, with no other key,
 * and an extension id that is printable and bounded. Anything else reads as no record, which an
 * export refuses for an application that loads extensions.
 */
import { describe, expect, it } from 'vitest';
import { parseBlobBackendRecord } from './blob-backend-record.js';

describe('parseBlobBackendRecord', () => {
  it('reads the three shapes', () => {
    expect(parseBlobBackendRecord({ kind: 'fs' })).toEqual({ kind: 'fs' });
    expect(parseBlobBackendRecord({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(parseBlobBackendRecord({ kind: 'extension', extension: 'vault_pack' })).toEqual({
      kind: 'extension',
      extension: 'vault_pack',
    });
  });

  it('refuses everything else', () => {
    const longId = 'x'.repeat(257);
    expect(longId.length).toBeGreaterThan(256);
    for (const value of [
      null,
      undefined,
      'fs',
      ['fs'],
      {},
      { kind: 'FS' },
      { kind: 's3' },
      { kind: 'fs', root: '/var/blobs' },
      { kind: 'none', extension: 'vault_pack' },
      { kind: 'extension' },
      { kind: 'extension', extension: '' },
      { kind: 'extension', extension: 7 },
      { kind: 'extension', extension: longId },
      { kind: 'extension', extension: 'vault\npack' },
      { kind: 'extension', extension: 'vault_pack', root: '/var/blobs' },
      { kind: 'extension', id: 'vault_pack' },
    ]) {
      expect(parseBlobBackendRecord(value), JSON.stringify(value)).toBeNull();
    }
  });
});
