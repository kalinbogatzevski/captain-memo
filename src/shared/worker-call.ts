// src/shared/worker-call.ts — the verdict a client raises when it cannot say how a worker call ended.

// 'unconfirmed' is the only kind raised today (cli/client.ts, on a 202 write_in_flight): the worker was still running
// a non-idempotent write when it stopped answering. Never reported as a failure, because a retry would do the work twice.
export type WorkerCallKind = 'unreachable' | 'timeout' | 'unconfirmed' | 'http';

export class WorkerCallError extends Error {
  constructor(public readonly kind: WorkerCallKind, public readonly path: string, message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = 'WorkerCallError';
  }
}
