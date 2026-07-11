import type { AgentRuntimeRegistry, FakeAgentHandler } from './types.js';

export class InMemoryAgentHandlerRegistry implements AgentRuntimeRegistry {
  private readonly handlers = new Map<string, FakeAgentHandler>();

  register(operation: string, handler: FakeAgentHandler): void {
    if (this.handlers.has(operation)) {
      throw new Error(`Agent fake handler '${operation}' is already registered.`);
    }
    this.handlers.set(operation, handler);
  }

  get(operation: string): FakeAgentHandler | undefined {
    return this.handlers.get(operation);
  }

  has(operation: string): boolean {
    return this.handlers.has(operation);
  }

  ids(): string[] {
    return [...this.handlers.keys()].sort();
  }
}
