import type { CapabilityNodeHandler } from './types.js';

export class CapabilityUnavailableError extends Error {
  readonly capabilityOperation: string;

  constructor(capabilityOperation: string) {
    super(`Capability operation '${capabilityOperation}' is unavailable.`);
    this.capabilityOperation = capabilityOperation;
  }
}

export class CapabilityRegistry {
  private readonly handlers = new Map<string, CapabilityNodeHandler>();

  register(operation: string, handler: CapabilityNodeHandler): void {
    if (this.handlers.has(operation)) {
      throw new Error(`Capability operation '${operation}' is already registered.`);
    }
    this.handlers.set(operation, handler);
  }

  get(operation: string): CapabilityNodeHandler {
    const handler = this.handlers.get(operation);
    if (!handler) throw new CapabilityUnavailableError(operation);
    return handler;
  }

  has(operation: string): boolean {
    return this.handlers.has(operation);
  }

  ids(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
