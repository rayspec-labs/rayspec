/**
 * The supported-backend matrix and the managed-posture refusal built on it.
 *
 *  - The matrix agrees with the contract vocabulary's managed-posture column, row by row.
 *  - Every row that claims a bound names the test that proves it, and that test exists.
 *  - docs/hardened-posture.md renders exactly these rows.
 *  - Under the managed posture a backend outside the matrix is refused with a diagnosis that names
 *    the backend, what uses it and why; outside the posture nothing is refused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Backend } from '@rayspec/core';
import { describe, expect, it } from 'vitest';
import { BootConfigError } from './boot-config-error.js';
import { managedProductBackends } from './product-boot.js';
import {
  assertManagedPostureBackends,
  managedBackendIds,
  matrixVocabularyDisagreements,
  SUPPORTED_BACKEND_MATRIX,
} from './supported-backends.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('the supported-backend matrix', () => {
  it('agrees with the capability vocabulary on every managed-posture status', () => {
    expect(matrixVocabularyDisagreements()).toEqual([]);
  });

  it('supports exactly the openai agent backend and the two real speech providers under the managed posture', () => {
    expect(managedBackendIds('agent')).toEqual(['openai']);
    expect(managedBackendIds('speech-to-text')).toEqual(['deepgram']);
    expect(managedBackendIds('text-to-speech')).toEqual(['openai']);
  });

  it('every row that claims a bound names an existing test, and every refused row says why', () => {
    for (const row of SUPPORTED_BACKEND_MATRIX) {
      for (const path of row.evidence) expect(existsSync(join(repoRoot, path)), path).toBe(true);
      if (row.managed === 'allowed') expect(row.evidence.length, row.id).toBeGreaterThan(0);
      else expect(row.refusal, `${row.kind}/${row.id}`).toBeTruthy();
    }
  });

  it('docs/hardened-posture.md renders exactly these rows', () => {
    const doc = readFileSync(join(repoRoot, 'docs', 'hardened-posture.md'), 'utf8');
    // The section runs to the next second-level heading; later sections have tables of their own.
    const start = doc.indexOf('## Supported backends');
    const end = doc.indexOf('\n## ', start + 1);
    const section = doc.slice(start, end === -1 ? undefined : end);
    const rows = section
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => line.split('|').map((cell) => cell.trim()));
    const rendered = rows.map((cells) => `${cells[1]} ${cells[2]} ${cells[3]}`);
    expect(rendered).toEqual(
      SUPPORTED_BACKEND_MATRIX.map((r) => `\`${r.id}\` ${r.kind} ${r.managed}`),
    );
  });
});

describe('assertManagedPostureBackends', () => {
  it('refuses an agent backend outside the matrix, naming every agent that declares it', () => {
    const refusal = (() => {
      try {
        assertManagedPostureBackends({
          posture: 'managed',
          agents: [
            { name: 'writer', backend: 'openai' },
            { name: 'coder', backend: 'codex' },
            { name: 'reviewer', backend: 'codex' },
          ],
        });
        return undefined;
      } catch (err) {
        return err;
      }
    })();
    expect(refusal).toBeInstanceOf(BootConfigError);
    const message = (refusal as Error).message;
    expect(message).toContain("agent backend 'codex' (declared by agents 'coder', 'reviewer')");
    expect(message).toContain("'agent-backend-codex' is self-host-only");
    expect(message).toContain('Supported under the managed posture: openai');
  });

  it('refuses the test-only speech providers', () => {
    expect(() => assertManagedPostureBackends({ posture: 'managed', sttProvider: 'fake' })).toThrow(
      /speech-to-text provider \(STT_PROVIDER\) 'fake'.*test-only/,
    );
    expect(() => assertManagedPostureBackends({ posture: 'managed', ttsProvider: 'fake' })).toThrow(
      /text-to-speech provider \(TTS_PROVIDER\) 'fake'.*test-only/,
    );
  });

  it('refuses a backend the matrix does not know at all', () => {
    expect(() =>
      assertManagedPostureBackends({
        posture: 'managed',
        agents: [{ name: 'x', backend: 'someday' }],
      }),
    ).toThrow(/not in the supported-backend matrix/);
  });

  it('admits the supported set under the managed posture, and refuses nothing outside it', () => {
    expect(() =>
      assertManagedPostureBackends({
        posture: 'managed',
        agents: [{ name: 'writer', backend: 'openai' }],
        sttProvider: 'deepgram',
        ttsProvider: 'openai',
      }),
    ).not.toThrow();
    for (const posture of ['local', undefined] as const) {
      expect(() =>
        assertManagedPostureBackends({
          posture,
          agents: [{ name: 'coder', backend: 'codex' }],
          sttProvider: 'fake',
          ttsProvider: 'fake',
        }),
      ).not.toThrow();
    }
  });
});

describe('managedProductBackends — the product profile under the managed posture', () => {
  const built: string[] = [];
  const source = {
    backendFor(_kind: unknown, _agentId: string, backend: string): Backend {
      built.push(backend);
      return { id: backend } as unknown as Backend;
    },
  };

  it('refuses a product model call on a backend outside the matrix before it is built', () => {
    built.length = 0;
    const gated = managedProductBackends(source);
    expect(() => gated.backendFor('extraction', 'invoice_extractor', 'pi', 'gpt-4.1-mini')).toThrow(
      /agent backend 'pi' \(the product extraction 'invoice_extractor'\)/,
    );
    expect(built).toEqual([]);
    expect(gated.backendFor('responder', 'helper', 'openai', 'gpt-4.1-mini').id).toBe('openai');
    expect(built).toEqual(['openai']);
  });
});
