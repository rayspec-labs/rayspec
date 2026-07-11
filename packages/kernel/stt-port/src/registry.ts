import type { SttAdapter } from './types.js';

export class SttAdapterRegistry {
  private readonly adapters = new Map<string, SttAdapter>();

  register(adapter: SttAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`STT adapter '${adapter.id}' is already registered.`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): SttAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      throw new Error(`Unknown STT adapter '${adapterId}'.`);
    }
    return adapter;
  }

  has(adapterId: string): boolean {
    return this.adapters.has(adapterId);
  }

  ids(): string[] {
    return [...this.adapters.keys()].sort();
  }
}
