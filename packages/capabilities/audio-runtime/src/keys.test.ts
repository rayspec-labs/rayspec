import { describe, expect, it } from 'vitest';
import {
  chunkKey,
  finalizedEventId,
  mediaArtifactKey,
  sessionRef,
  storageKeyPrefix,
  trackRef,
} from './keys.js';

describe('key derivation', () => {
  it('tenant-namespaces the unique refs (isolates identical ids across tenants)', () => {
    expect(sessionRef('t1', 's1')).toBe('t1:s1');
    expect(sessionRef('t2', 's1')).toBe('t2:s1');
    expect(sessionRef('t1', 's1')).not.toBe(sessionRef('t2', 's1'));
    expect(trackRef('t1', 's1', 'mic')).toBe('t1:s1:mic');
  });

  it('the finalized event id is SESSION-scoped (no track — the single-flight key)', () => {
    expect(finalizedEventId('t1', 's1')).toBe('t1:s1');
    expect(finalizedEventId('t1', 's1')).toBe(finalizedEventId('t1', 's1'));
  });

  it('blob keys are relative + stable (chunk-by-index, single media artifact)', () => {
    expect(storageKeyPrefix('s1', 'mic')).toBe('s1/mic');
    expect(chunkKey('s1', 'mic', 3)).toBe('s1/mic/chunk_3');
    expect(mediaArtifactKey('s1', 'mic')).toBe('s1/mic/media');
  });
});
