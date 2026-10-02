/**
 * The application process's side of the supervisor (supervisor.ts): it was started by a supervisor
 * that holds the migration role in its place, over an IPC channel that only the two of them share.
 *
 * It refuses to run otherwise: an entrypoint of the application process started by hand, without a
 * supervisor or with a privileged connection in its environment, exits 70. It takes its instruction
 * from the supervisor's first message, asks the supervisor for each schema step of its boot, and
 * stops at once, without a drain, when the supervisor goes away without stopping it first, so it never
 * serves without one.
 *
 * Everything this process sends is data the supervisor validates, and the supervisor sends it
 * nothing it does not hold already: the channel carries no privileged value.
 */
import { writeSync } from 'node:fs';
import type {
  BeforeSchemaChangeResult,
  BootFacts,
  SupervisedSchemaWork,
} from './composition-root.js';
import {
  type ChildMessage,
  refusalError,
  type SchemaStep,
  SUPERVISOR_PROTOCOL,
  type SupervisorMessage,
} from './supervisor.js';
import { privilegedConnectionsIn, SUPERVISOR_HANDOFF_VAR } from './supervisor-handoff.js';

/** The exit code of an application-process entrypoint started without a supervisor. */
export const NO_SUPERVISOR_EXIT_CODE = 70;

/** An application-process entrypoint started without a supervisor. */
export class NoSupervisorError extends Error {
  readonly exitCode = NO_SUPERVISOR_EXIT_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'NoSupervisorError';
  }
}

/** The application process's channel to its supervisor. */
export interface SupervisorConnection {
  /** What the supervisor told this process to serve. */
  readonly instruction: unknown;
  /** The boot's schema work, run by the supervisor. */
  readonly schemaWork: SupervisedSchemaWork;
  /** Tell the supervisor this process now serves. */
  serving(): void;
}

type Pending = {
  resolve: (result: BeforeSchemaChangeResult) => void;
  reject: (err: Error) => void;
};

type RequestFields =
  | { step: Exclude<SchemaStep, 'before-schema-change' | 'product-migration'> }
  | { step: 'before-schema-change'; facts: BootFacts }
  | { step: 'product-migration'; name: string; specSource?: string };

/**
 * Connect to the supervisor that started this process and wait for its instruction. Throws
 * `NoSupervisorError` when there is none, or when this process's environment holds a privileged
 * connection (a supervisor never starts it so). `prefix` starts the line this process prints when its
 * supervisor goes away (`[rayspec deploy]`).
 */
export function connectToSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  prefix = '[rayspec]',
): Promise<SupervisorConnection> {
  const send = process.send?.bind(process);
  if (send === undefined || !process.connected) {
    return Promise.reject(
      new NoSupervisorError(
        'this is the application process of a supervised deploy, started without its supervisor; ' +
          'start the deployment with `rayspec deploy` or `rayspec-serve`',
      ),
    );
  }
  const leaked = [
    ...privilegedConnectionsIn(env),
    ...(env[SUPERVISOR_HANDOFF_VAR] ? [SUPERVISOR_HANDOFF_VAR] : []),
  ];
  if (leaked.length > 0) {
    return Promise.reject(
      new NoSupervisorError(
        `the application process was started with ${leaked.join(', ')} in its environment; a ` +
          'supervisor never starts it so',
      ),
    );
  }

  const pending = new Map<number, Pending>();
  let nextId = 1;
  const channel = (process as unknown as { channel?: { ref(): void; unref(): void } }).channel;
  // The channel keeps this process alive only while a step is awaited; serving keeps it alive itself.
  const settle = () => {
    if (pending.size === 0) channel?.unref();
  };
  const request = (fields: RequestFields): Promise<BeforeSchemaChangeResult> =>
    new Promise((resolve, reject) => {
      if (!process.connected) {
        reject(new Error('the supervisor has ended; the boot cannot continue'));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      channel?.ref();
      const message: ChildMessage & { protocol: number } = {
        type: 'request',
        protocol: SUPERVISOR_PROTOCOL,
        id,
        ...fields,
      } as ChildMessage & { protocol: number };
      send(message, undefined, undefined, (err: Error | null) => {
        if (err === null) return;
        pending.delete(id);
        settle();
        reject(new Error('the supervisor has ended; the boot cannot continue'));
      });
    });

  return new Promise((resolve, reject) => {
    let started = false;
    process.on('message', (raw: unknown) => {
      const message = raw as SupervisorMessage;
      if (
        typeof message !== 'object' ||
        message === null ||
        message.protocol !== SUPERVISOR_PROTOCOL
      ) {
        return;
      }
      if (message.type === 'start' && !started) {
        started = true;
        settle();
        const schemaWork: SupervisedSchemaWork = {
          beforeSchemaChange: (facts) => request({ step: 'before-schema-change', facts }),
          platformChain: async () => {
            await request({ step: 'platform-chain' });
          },
          tenantIsolation: async () => {
            await request({ step: 'tenant-isolation' });
          },
          productMigration: async (name, specSource) => {
            await request({
              step: 'product-migration',
              name,
              ...(specSource !== undefined ? { specSource } : {}),
            });
          },
          workflowSystemSchema: async () => {
            await request({ step: 'workflow-system-schema' });
          },
          done: async () => {
            await request({ step: 'schema-done' });
          },
        };
        resolve({
          instruction: message.instruction,
          schemaWork,
          serving: () => {
            if (process.connected) send({ type: 'serving', protocol: SUPERVISOR_PROTOCOL });
          },
        });
        return;
      }
      if (message.type === 'reply') {
        const waiting = pending.get(message.id);
        if (waiting === undefined) return;
        pending.delete(message.id);
        settle();
        if (message.ok) waiting.resolve(message.result);
        else waiting.reject(refusalError(message.error));
      }
    });
    process.once('disconnect', () => {
      for (const waiting of pending.values()) {
        waiting.reject(new Error('the supervisor has ended; the boot cannot continue'));
      }
      pending.clear();
      if (!started) {
        reject(new NoSupervisorError('the supervisor ended before it sent an instruction'));
        return;
      }
      // The supervisor ended without stopping this process first: it was killed or crashed, and the
      // deployment may already be starting again beside this process. A drain would keep serving and
      // keep running the durable workflow executor next to the new one, so this process ends at once,
      // as the single process ended when it was killed. The line is written synchronously: nothing
      // after the kill runs.
      try {
        writeSync(
          2,
          `${prefix} the supervisor ended without stopping the application process; it stops at ` +
            'once, without a drain\n',
        );
      } catch {
        // No stderr left to write to: the process stops all the same.
      }
      process.kill(process.pid, 'SIGKILL');
    });
  });
}
