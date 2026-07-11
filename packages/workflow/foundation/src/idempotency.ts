export function workflowRunId(workflowId: string, idempotencyKey: string): string {
  return `workflow_run:${workflowId}:${idempotencyKey}`;
}

export function workflowIdempotencyScope(workflowId: string, idempotencyKey: string): string {
  return `${workflowId}:${idempotencyKey}`;
}

export class SingleFlight<T> {
  private readonly flights = new Map<string, Promise<T>>();

  run(key: string, start: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key);
    if (existing) return existing;

    const flight = start().finally(() => {
      this.flights.delete(key);
    });
    this.flights.set(key, flight);
    return flight;
  }
}
