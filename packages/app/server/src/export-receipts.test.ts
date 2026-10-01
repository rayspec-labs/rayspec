/**
 * The local receipt of an export: every transition with the operation, actor, fence epoch and
 * state, time, digests and recovery action, written to the state directory with mode 0600 — and
 * nothing in it that must not be shared: no recipient, no message, no table. A killed export's
 * receipt is closed as BLOCKED by the next one. The environment's receipts are covered by the
 * database-backed export suite of the CLI.
 */
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleError, CONTRACT_VERSION } from '@rayspec/bundle-contract';
import type { Db } from '@rayspec/db';
import { afterAll, describe, expect, it } from 'vitest';
import { openStateDirectory, type StateDirectory } from './deployment-state.js';
import {
  closeInterruptedExport,
  EXPORT_ACTOR,
  type ExportReceipt,
  ExportReceiptLog,
  exportReceiptName,
  resumeInstruction,
} from './export-receipts.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function stateDir(): Promise<StateDirectory> {
  const root = mkdtempSync(join(tmpdir(), 'rayspec-export-receipts-'));
  dirs.push(root);
  const dir = await openStateDirectory(join(root, 'state'), { create: true });
  if (dir === null) throw new Error('no state directory');
  return dir;
}

const RECIPIENT = `age1${'q'.repeat(58)}`;
const DIGEST = 'a'.repeat(64);
const inputs = {
  deploymentId: 'abcdef0123456789',
  recipient: RECIPIENT,
  runHistoryPolicy: 'excluded' as const,
  sourceStopped: true,
  quiesceDeadlineSeconds: 300,
};

function readReceipt(dir: StateDirectory, operationId: string): ExportReceipt {
  return JSON.parse(
    readFileSync(join(dir.root, 'receipts', `${exportReceiptName(operationId)}.json`), 'utf8'),
  ) as ExportReceipt;
}

describe('the local receipt of an export', () => {
  it('records every transition with its epoch, time, digests and recovery, mode 0600', async () => {
    const dir = await stateDir();
    const operationId = randomUUID();
    const log = ExportReceiptLog.start(dir, operationId, inputs);
    const at = new Date('2026-10-01T10:00:00Z');
    await log.transition('PRECHECK', {
      fenceEpoch: 0,
      fenceState: 'open',
      recovery: 'none',
      now: at,
    });
    await log.transition('QUIESCING', {
      fenceEpoch: 0,
      fenceState: 'open',
      digests: { applicationDigest: DIGEST },
      recovery: resumeInstruction(inputs.deploymentId, 1),
      now: at,
    });
    await log.transition('FROZEN', { fenceEpoch: 1, fenceState: 'fenced', recovery: 'r', now: at });
    await log.transition('EXPORTING', {
      fenceEpoch: 1,
      fenceState: 'fenced',
      recovery: 'r',
      now: at,
    });
    await log.transition('EXPORTED', {
      fenceEpoch: 1,
      fenceState: 'fenced',
      digests: { migrationBundleSha256: DIGEST, ciphertextSha256: DIGEST },
      recovery: resumeInstruction(inputs.deploymentId, 1),
      now: at,
    });
    const path = join(dir.root, 'receipts', `${exportReceiptName(operationId)}.json`);
    // Judge and read the receipt through one descriptor, so the mode checked is the file read.
    const fd = openSync(path, 'r');
    let receiptText: string;
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      receiptText = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    expect(statSync(join(dir.root, 'receipts')).mode & 0o777).toBe(0o700);
    const receipt = readReceipt(dir, operationId);
    expect(receipt).toMatchObject({
      receiptFormatVersion: 1,
      contractVersion: CONTRACT_VERSION,
      operation: 'export',
      operationId,
      actor: EXPORT_ACTOR,
      deploymentId: inputs.deploymentId,
      outcome: 'exported',
    });
    expect(receipt.inputsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.transitions.map((t) => [t.state, t.fenceEpoch, t.fenceState])).toEqual([
      ['PRECHECK', 0, 'open'],
      ['QUIESCING', 0, 'open'],
      ['FROZEN', 1, 'fenced'],
      ['EXPORTING', 1, 'fenced'],
      ['EXPORTED', 1, 'fenced'],
    ]);
    expect(receipt.transitions.every((t) => t.at === '2026-10-01T10:00:00Z')).toBe(true);
    expect(receipt.transitions[4]?.recovery).toBe(
      'rayspec resume --deployment abcdef0123456789 --fence-epoch 1',
    );
    // The recipient is covered by the digest, never written.
    expect(receiptText).not.toContain(RECIPIENT);
  });

  it('records a refusal by its code and reason, never its message', async () => {
    const dir = await stateDir();
    const operationId = randomUUID();
    const log = ExportReceiptLog.start(dir, operationId, inputs);
    await log.transition('PRECHECK', { fenceEpoch: 0, fenceState: 'open', recovery: 'none' });
    await log.transition('BLOCKED', {
      fenceEpoch: 0,
      fenceState: 'open',
      recovery: 'nothing at the source was changed',
      error: bundleError(
        'RAY_EXTERNAL_STATE_UNSUPPORTED',
        'tables that are neither platform tables nor product stores: secret_customer_ledger',
        { reason: 'unknown-table' },
      ),
    });
    const receipt = readReceipt(dir, operationId);
    expect(receipt.outcome).toBe('blocked');
    expect(receipt.transitions[1]?.error).toEqual({
      code: 'RAY_EXTERNAL_STATE_UNSUPPORTED',
      reason: 'unknown-table',
    });
    expect(JSON.stringify(receipt)).not.toContain('secret_customer_ledger');
  });

  it('closes the receipt of a killed export as BLOCKED, interrupted, with the fence to resume', async () => {
    const dir = await stateDir();
    const killed = randomUUID();
    const log = ExportReceiptLog.start(dir, killed, inputs);
    await log.transition('PRECHECK', { fenceEpoch: 2, fenceState: 'open', recovery: 'none' });
    await log.transition('QUIESCING', { fenceEpoch: 2, fenceState: 'open', recovery: 'r' });
    await log.transition('FROZEN', { fenceEpoch: 3, fenceState: 'fenced', recovery: 'r' });
    await log.transition('EXPORTING', { fenceEpoch: 3, fenceState: 'fenced', recovery: 'r' });

    const closer = randomUUID();
    expect(await closeInterruptedExport(dir, killed, closer, null)).toEqual({ fenceEpoch: 3 });
    const receipt = readReceipt(dir, killed);
    expect(receipt.outcome).toBe('blocked');
    expect(receipt.transitions.at(-1)).toMatchObject({
      state: 'BLOCKED',
      fenceEpoch: 3,
      fenceState: 'fenced',
      interrupted: true,
      closedBy: closer,
      error: { code: 'RAY_INTERRUPTED' },
    });
    expect(receipt.transitions.at(-1)?.recovery).toContain(
      'rayspec resume --deployment abcdef0123456789 --fence-epoch 3',
    );
    // A receipt that already ended, or none at all, is left alone.
    expect(await closeInterruptedExport(dir, killed, randomUUID(), null)).toBeNull();
    expect(await closeInterruptedExport(dir, randomUUID(), closer, null)).toBeNull();
  });

  /** A killed export's receipt that ends while quiesce was taking the fence at epoch 2 → 3. */
  async function killedWhileQuiescing(dir: StateDirectory): Promise<string> {
    const killed = randomUUID();
    const log = ExportReceiptLog.start(dir, killed, inputs);
    await log.transition('PRECHECK', {
      fenceEpoch: 2,
      fenceState: 'open',
      digests: { applicationDigest: DIGEST },
      recovery: 'none',
    });
    await log.transition('QUIESCING', {
      fenceEpoch: 2,
      fenceState: 'open',
      digests: { applicationDigest: DIGEST },
      recovery: resumeInstruction(inputs.deploymentId, 3),
    });
    return killed;
  }

  it('closes an export killed while quiescing with the epoch quiesce takes, not the open one', async () => {
    const dir = await stateDir();
    const killed = await killedWhileQuiescing(dir);
    expect(await closeInterruptedExport(dir, killed, randomUUID(), null)).toEqual({
      fenceEpoch: 3,
    });
    const closed = readReceipt(dir, killed).transitions.at(-1);
    expect(closed).toMatchObject({ state: 'BLOCKED', fenceEpoch: 3, fenceState: null });
    expect(closed?.digests).toEqual({ applicationDigest: DIGEST });
    expect(closed?.recovery).toContain(
      'rayspec resume --deployment abcdef0123456789 --fence-epoch 3',
    );
  });

  it("closes a killed export with the environment's fence when the database can be read", async () => {
    const fenceOf = (state: string, epoch: string): Db =>
      ({
        $client: { unsafe: async () => [{ fence_state: state, fence_epoch: epoch }] },
      }) as unknown as Db;

    const dir = await stateDir();
    const fenced = await killedWhileQuiescing(dir);
    expect(await closeInterruptedExport(dir, fenced, randomUUID(), fenceOf('fenced', '3'))).toEqual(
      { fenceEpoch: 3 },
    );
    const closed = readReceipt(dir, fenced).transitions.at(-1);
    expect(closed).toMatchObject({ fenceEpoch: 3, fenceState: 'fenced' });
    expect(closed?.recovery).toContain('--fence-epoch 3');

    // Killed before quiesce took the fence: the source is open, and no resume is offered.
    const open = await killedWhileQuiescing(dir);
    await closeInterruptedExport(dir, open, randomUUID(), fenceOf('open', '2'));
    const reopened = readReceipt(dir, open).transitions.at(-1);
    expect(reopened).toMatchObject({ fenceEpoch: 2, fenceState: 'open' });
    expect(reopened?.recovery).toBe(
      'the export was killed before it finished; the source is not fenced',
    );
  });
});
