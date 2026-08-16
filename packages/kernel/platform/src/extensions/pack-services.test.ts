/**
 * The `services` contribution kind — the one kind the platform BOOTS rather than calls.
 *
 * Every other contribution a pack makes is REACTIVE: a route is served, a tool is invoked, a trigger
 * fires. A service is the pack's own thread of control, so the two things that can only be got wrong
 * here are ORDER and FAILURE — and both are asserted against the running orchestrator, never against
 * a comment:
 *
 *   (A) RESOLUTION — a `services: [{ module }]` declaration resolves through the SAME jailed,
 *       `.js`-preferred module resolution the pack entry and every claimed section's schema module go
 *       through, and a module whose default export is not `{ name, boot, shutdown }` is refused
 *       naming the pack. A manifest without `services` contributes none (a strict no-op).
 *   (B) ORDER — boot follows declaration order; shutdown is its exact REVERSE. Asserted on one shared
 *       log both directions append to, so a reversal that is not a reversal cannot pass.
 *   (C) A FAILING BOOT FAILS THE BOOT — it throws, the message names the offending pack AND service,
 *       and the services that had already booted are shut down again in reverse. A service left
 *       running behind a refused boot is the failure mode this arm exists to catch.
 *   (D) THE POSITIVE SIDE OF THE DISPATCH BOUNDARY — a service RECEIVES `TurnDispatch`. The CI gate
 *       (`scripts/check-contribution-dispatch-boundary.mjs`) proves the negative: a handler or tooling
 *       module that names the capability fails the build. Nothing proved the positive, so these arms
 *       do: the capability reaches a service's `boot`, it schedules a turn onto the durable seam, and
 *       the TENANT it schedules under is the one CORE bound — the request object has no tenant field
 *       to name one with, and an undeclared agent is fail-closed rather than silently enqueued. The
 *       last three arms are the FAILING enqueue, which is where the advisory header write earns its
 *       keep or leaves a phantom `enqueued` run behind: the engine is probed, and the header is
 *       removed for a provably-absent job and KEPT for one that may be live or cannot be read.
 *
 * No DB and no on-disk pack: the pack entry and its service modules are provided through the injected
 * importer, and the durable executor + the tenant-scoped handle are fakes — exactly as the sibling
 * `section-claims.test.ts` and `load-extensions.test.ts` do.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TenantDb } from '@rayspec/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DurableExecutor, DurableJobStatus, EnqueueResult, RunJob } from '../durable/types.js';
import type { ModuleImporter } from '../handlers/loader.js';
import { makeTurnDispatch } from '../turn-dispatch.js';
import { defineExtension, type ExtensionManifest } from './extension.js';
import { ExtensionLoadError, type ExtensionRefLike, loadExtensions } from './load-extensions.js';
import {
  bootPackServices,
  type PackServiceContext,
  PackServiceError,
  type PackServiceModule,
} from './pack-services.js';

/** A fake importer: maps an absolute module path → a module namespace. */
function fakeImporter(byPath: Map<string, Record<string, unknown>>): ModuleImporter {
  return async (absolutePath: string) => {
    const mod = byPath.get(absolutePath);
    if (!mod) throw new Error(`fake importer: nothing registered for ${absolutePath}`);
    return mod;
  };
}

/** A manifest that declares `modules` as its services. */
function manifestWithServices(...modules: string[]): ExtensionManifest {
  return { version: '1.0.0', fragments: {}, services: modules.map((module) => ({ module })) };
}

/** A service module that appends `<name>:boot` / `<name>:shutdown` to a shared log. */
function loggingService(name: string, log: string[], onBoot?: () => void): PackServiceModule {
  return {
    name,
    boot() {
      log.push(`${name}:boot`);
      onBoot?.();
    },
    shutdown() {
      log.push(`${name}:shutdown`);
    },
  };
}

/**
 * The database door a service is handed. `transaction` runs the callback on the SAME stub handle:
 * these arms measure the orchestrator, and a stub that refused one would make the door the variable.
 */
const stubDb: PackServiceContext['db'] = {
  query: async () => [],
  transaction: async (fn) => await fn(stubDb),
};

/** The minimal context the orchestrator hands a service; the per-member wiring is the boot's. */
function stubContext(packId: string, over: Partial<PackServiceContext> = {}): PackServiceContext {
  return {
    packId,
    db: stubDb,
    spec: { metadata: { name: 'fixture' } } as PackServiceContext['spec'],
    sections: {},
    env: {},
    ...over,
  };
}

describe('loadExtensions — the services contribution kind', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rayspec-pack-services-'));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const ref = (over: Partial<ExtensionRefLike> = {}): ExtensionRefLike => ({
    id: 'acme-notes',
    module: './pack',
    version: '1.0.0',
    ...over,
  });

  it('a manifest without `services` contributes none (a strict no-op)', async () => {
    const importer = fakeImporter(
      new Map([
        [
          resolve(root, 'pack', 'index.ts'),
          { default: defineExtension({ version: '1.0.0', fragments: {} }) },
        ],
      ]),
    );
    const out = await loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer });
    expect(out.services).toEqual([]);
  });

  it('resolves each declared service module, in declaration order, naming its owning pack', async () => {
    const log: string[] = [];
    const importer = fakeImporter(
      new Map<string, Record<string, unknown>>([
        [
          resolve(root, 'pack', 'index.ts'),
          {
            default: defineExtension(
              manifestWithServices('services/reconcile.ts', 'services/drain.ts'),
            ),
          },
        ],
        [resolve(root, 'pack', 'services/reconcile.ts'), { default: loggingService('a', log) }],
        [resolve(root, 'pack', 'services/drain.ts'), { default: loggingService('b', log) }],
      ]),
    );
    const out = await loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer });
    expect(out.services.map((s) => `${s.packId}:${s.name}`)).toEqual([
      'acme-notes:a',
      'acme-notes:b',
    ]);
    expect(out.services.map((s) => s.module)).toEqual([
      'services/reconcile.ts',
      'services/drain.ts',
    ]);
  });

  it('PATH-JAIL FAIL-CLOSED: a service `module` outside the pack directory is refused', async () => {
    const importer = fakeImporter(
      new Map<string, Record<string, unknown>>([
        [
          resolve(root, 'pack', 'index.ts'),
          { default: defineExtension(manifestWithServices('../outside.ts')) },
        ],
      ]),
    );
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(ExtensionLoadError);
  });

  it('an unloadable service module is refused, naming the pack', async () => {
    // Only the entry is registered — the service module import fails.
    const importer = fakeImporter(
      new Map<string, Record<string, unknown>>([
        [
          resolve(root, 'pack', 'index.ts'),
          { default: defineExtension(manifestWithServices('services/reconcile.ts')) },
        ],
      ]),
    );
    await expect(
      loadExtensions([ref()], { packsRoot: root, deploymentRoot: root, importer }),
    ).rejects.toThrow(/acme-notes/);
  });

  it.each([
    ['no default export', {}],
    ['a default export that is not an object', { default: 'nope' }],
    ['a module with no boot', { default: { name: 'x', shutdown: () => {} } }],
    ['a module with no shutdown', { default: { name: 'x', boot: () => {} } }],
    ['a module with no name', { default: { boot: () => {}, shutdown: () => {} } }],
  ])('a service module that is not `{ name, boot, shutdown }` is refused: %s', async (_w, mod) => {
    const importer = fakeImporter(
      new Map<string, Record<string, unknown>>([
        [
          resolve(root, 'pack', 'index.ts'),
          { default: defineExtension(manifestWithServices('services/reconcile.ts')) },
        ],
        [resolve(root, 'pack', 'services/reconcile.ts'), mod as Record<string, unknown>],
      ]),
    );
    const err = await loadExtensions([ref()], {
      packsRoot: root,
      deploymentRoot: root,
      importer,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionLoadError);
    expect((err as Error).message).toContain('acme-notes');
    expect((err as Error).message).toContain('services/reconcile.ts');
  });
});

describe('bootPackServices — boot order, and its exact reverse on shutdown', () => {
  it('(B) boots in declaration order and shuts down in reverse', async () => {
    const log: string[] = [];
    const handle = await bootPackServices(
      [
        { packId: 'p1', module: 's1.ts', ...loggingService('a', log) },
        { packId: 'p1', module: 's2.ts', ...loggingService('b', log) },
        { packId: 'p2', module: 's3.ts', ...loggingService('c', log) },
      ],
      stubContext,
    );
    expect(log).toEqual(['a:boot', 'b:boot', 'c:boot']);
    expect(handle.booted).toEqual(['p1/a', 'p1/b', 'p2/c']);
    await handle.shutdown();
    expect(log).toEqual(['a:boot', 'b:boot', 'c:boot', 'c:shutdown', 'b:shutdown', 'a:shutdown']);
  });

  it('(B) a service receives a context built for ITS pack', async () => {
    const seen: Array<{ packId: string; sections: unknown }> = [];
    const capture = (name: string): PackServiceModule => ({
      name,
      boot(ctx) {
        seen.push({ packId: ctx.packId, sections: ctx.sections });
      },
      shutdown() {},
    });
    const handle = await bootPackServices(
      [
        { packId: 'p1', module: 's1.ts', ...capture('a') },
        { packId: 'p2', module: 's2.ts', ...capture('b') },
      ],
      (packId) => stubContext(packId, { sections: { [packId]: { retentionDays: 7 } } }),
    );
    expect(seen).toEqual([
      { packId: 'p1', sections: { p1: { retentionDays: 7 } } },
      { packId: 'p2', sections: { p2: { retentionDays: 7 } } },
    ]);
    await handle.shutdown();
  });

  it('(C) a failing boot FAILS the boot, names the pack and the service, and unwinds in reverse', async () => {
    const log: string[] = [];
    const err = await bootPackServices(
      [
        { packId: 'p1', module: 'services/ok.ts', ...loggingService('a', log) },
        {
          packId: 'acme-notes',
          module: 'services/reconcile.ts',
          name: 'reconciler',
          boot() {
            throw new Error('the queue is unreachable');
          },
          shutdown() {
            log.push('reconciler:shutdown');
          },
        },
        { packId: 'p2', module: 'services/never.ts', ...loggingService('c', log) },
      ],
      stubContext,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PackServiceError);
    const message = (err as Error).message;
    expect(message).toContain('acme-notes');
    expect(message).toContain('reconciler');
    expect(message).toContain('services/reconcile.ts');
    expect(message).toContain('the queue is unreachable');
    // The service that had already booted is shut down again; the one AFTER the failure never
    // booted, so it is never shut down — and the failing service's own shutdown is not called
    // (its boot never completed).
    expect(log).toEqual(['a:boot', 'a:shutdown']);
  });

  it('(C) a throwing shutdown does not strand the services behind it', async () => {
    const log: string[] = [];
    const handle = await bootPackServices(
      [
        { packId: 'p1', module: 's1.ts', ...loggingService('a', log) },
        {
          packId: 'p2',
          module: 's2.ts',
          name: 'noisy',
          boot() {
            log.push('noisy:boot');
          },
          shutdown() {
            throw new Error('shutdown blew up');
          },
        },
      ],
      stubContext,
    );
    await handle.shutdown();
    // 'a' is BEHIND 'noisy' in the reverse order, so it only runs if the throw was contained.
    expect(log).toEqual(['a:boot', 'noisy:boot', 'a:shutdown']);
  });
});

describe('makeTurnDispatch — the one sanctioned way a service schedules an agent turn', () => {
  /**
   * A fake durable executor recording what it was asked to enqueue. `enqueueThrows` makes the enqueue
   * REJECT (the failure the compensating delete exists for) and `statusAnswer` is what the engine
   * probe then reads back — `'unknown'` for a job that provably never durably existed, anything else
   * for one that may be live, and `'throw'` for an engine that cannot answer at all.
   */
  function fakeExecutor(
    opts: { enqueueThrows?: boolean; statusAnswer?: DurableJobStatus | 'throw' } = {},
  ): DurableExecutor & { readonly jobs: Array<[string, RunJob]> } {
    const jobs: Array<[string, RunJob]> = [];
    return {
      jobs,
      async enqueue(tenantId: string, job: RunJob): Promise<EnqueueResult> {
        if (opts.enqueueThrows) throw new Error('the durable engine refused the enqueue');
        jobs.push([tenantId, job]);
        return { jobId: job.runId };
      },
      async status() {
        if (opts.statusAnswer === 'throw') throw new Error('the engine status is unreadable');
        return opts.statusAnswer ?? ('enqueued' as const);
      },
      async cancel() {},
      async start() {},
      async shutdown() {},
      identity() {
        return { executorId: 'fake', applicationVersion: 'v' };
      },
    };
  }

  /**
   * A fake tenant-scoped handle recording the run headers written through it AND the runIds deleted
   * again. The delete is what the enqueue-failure arms below read: the compensation is a real write,
   * so measuring it means measuring a write, not a flag.
   */
  function fakeTdb(written: unknown[], deleted: string[] = []): TenantDb {
    return {
      select: () => ({
        where: () => ({ limit: async () => [] }),
      }),
      insert: (_table: unknown, values: unknown) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            written.push(values);
            return [{ runId: (values as { runId: string }).runId }];
          },
        }),
      }),
      // `deleteEnqueuedRunHeader` filters on `(runId, status='enqueued')`; the fake records the runId
      // the compensating delete was issued for, which is the fact these arms are about.
      delete: () => ({
        where: async (..._args: unknown[]) => {
          deleted.push(lastRunId(written));
        },
      }),
    } as unknown as TenantDb;
  }

  /** The runId of the most recent header write — what a compensating delete must be removing. */
  function lastRunId(written: unknown[]): string {
    return (written[written.length - 1] as { runId?: string } | undefined)?.runId ?? '';
  }

  const TENANT = '00000000-0000-4000-8000-0000000004aa';

  it('(D) schedules under the tenant CORE bound — the request has no way to name one', async () => {
    const executor = fakeExecutor();
    const written: unknown[] = [];
    const dispatch = makeTurnDispatch({
      tenantId: TENANT,
      tdb: fakeTdb(written),
      executor,
      resolveAgent: (agentId) =>
        agentId === 'summarizer'
          ? { backend: 'anthropic', agentName: 'Summarizer', model: 'a-model' }
          : undefined,
    });

    const { runId } = await dispatch.schedule({ agentId: 'summarizer', input: 'reconcile' });
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(executor.jobs).toHaveLength(1);
    const [enqueuedTenant, job] = executor.jobs[0] as [string, RunJob];
    expect(enqueuedTenant).toBe(TENANT);
    expect(job.tenantId).toBe(TENANT);
    expect(job.runId).toBe(runId);
    expect(job.agentId).toBe('summarizer');
    expect(job.input).toBe('reconcile');
    // The header is written BEFORE the enqueue, so the returned runId resolves on the run-read
    // routes for the whole run rather than 404ing until the worker finishes it.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ runId, backend: 'anthropic', agentName: 'Summarizer' });
  });

  /**
   * THE ENQUEUE THREW — the header this call wrote must not outlive the job it was written for.
   *
   * The header write is advisory and deliberately best-effort, which is only safe while it is PAIRED
   * with a compensation: the two other enqueue-with-header paths (`routes/runs.ts`,
   * `cron-scheduler.ts`) probe the engine and remove the row for a job that provably never existed.
   * Without it a failed enqueue leaves a `runs` row at `status='enqueued'` for a runId that will never
   * run — readable on the run-read routes and in every listing for that tenant, for ever.
   *
   * The three arms are one decision table, and the middle two are each other's control: the engine's
   * answer is the ONLY variable, so a delete that fired unconditionally would fail the second arm and
   * a compensation that never fired would fail the first.
   */
  it('(D) enqueue THREW and the job is provably absent → the header is removed, the error rethrown', async () => {
    const executor = fakeExecutor({ enqueueThrows: true, statusAnswer: 'unknown' });
    const written: unknown[] = [];
    const deleted: string[] = [];
    const dispatch = makeTurnDispatch({
      tenantId: TENANT,
      tdb: fakeTdb(written, deleted),
      executor,
      resolveAgent: () => ({ backend: 'anthropic', agentName: 'S', model: 'm' }),
    });

    await expect(dispatch.schedule({ agentId: 'a', input: 'i' })).rejects.toThrow(
      /refused the enqueue/,
    );
    // The header was written, and then removed again for the runId it was written for.
    expect(written).toHaveLength(1);
    expect(deleted).toEqual([(written[0] as { runId: string }).runId]);
  });

  it('(D) enqueue THREW but the job MAY be live → the header STAYS (the run it belongs to owns it)', async () => {
    // A throw does not prove the job was never created: the engine persists the workflow status before
    // `enqueue` resolves, so a job the engine still reports on WILL run and needs its header.
    const executor = fakeExecutor({ enqueueThrows: true, statusAnswer: 'enqueued' });
    const written: unknown[] = [];
    const deleted: string[] = [];
    const dispatch = makeTurnDispatch({
      tenantId: TENANT,
      tdb: fakeTdb(written, deleted),
      executor,
      resolveAgent: () => ({ backend: 'anthropic', agentName: 'S', model: 'm' }),
    });

    await expect(dispatch.schedule({ agentId: 'a', input: 'i' })).rejects.toThrow(
      /refused the enqueue/,
    );
    expect(written).toHaveLength(1);
    expect(deleted).toEqual([]);
  });

  it('(D) enqueue THREW and the status is UNREADABLE → fail-closed, the header STAYS', async () => {
    const executor = fakeExecutor({ enqueueThrows: true, statusAnswer: 'throw' });
    const written: unknown[] = [];
    const deleted: string[] = [];
    const dispatch = makeTurnDispatch({
      tenantId: TENANT,
      tdb: fakeTdb(written, deleted),
      executor,
      resolveAgent: () => ({ backend: 'anthropic', agentName: 'S', model: 'm' }),
    });

    // The ORIGINAL error is what the caller sees — never the probe's.
    await expect(dispatch.schedule({ agentId: 'a', input: 'i' })).rejects.toThrow(
      /refused the enqueue/,
    );
    expect(written).toHaveLength(1);
    expect(deleted).toEqual([]);
  });

  it('(D) an UNDECLARED agent is fail-closed — never a silent, dangling enqueue', async () => {
    const executor = fakeExecutor();
    const dispatch = makeTurnDispatch({
      tenantId: TENANT,
      tdb: fakeTdb([]),
      executor,
      resolveAgent: () => undefined,
    });
    await expect(dispatch.schedule({ agentId: 'ghost', input: 'x' })).rejects.toThrow(/ghost/);
    expect(executor.jobs).toEqual([]);
  });

  it('(D) it reaches a SERVICE through its boot context', async () => {
    const executor = fakeExecutor();
    const dispatch = makeTurnDispatch({
      tenantId: TENANT,
      tdb: fakeTdb([]),
      executor,
      resolveAgent: () => ({ backend: 'anthropic', agentName: 'S', model: 'm' }),
    });
    let scheduled: string | undefined;
    const handle = await bootPackServices(
      [
        {
          packId: 'acme-notes',
          module: 'services/reconcile.ts',
          name: 'reconciler',
          async boot(ctx) {
            scheduled = (await ctx.dispatch?.schedule({ agentId: 'a', input: 'i' }))?.runId;
          },
          shutdown() {},
        },
      ],
      (packId) => stubContext(packId, { dispatch }),
    );
    expect(scheduled).toMatch(/^[0-9a-f-]{36}$/);
    expect(executor.jobs).toHaveLength(1);
    await handle.shutdown();
  });
});
