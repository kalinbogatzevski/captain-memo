// src/eval/retry.ts — retry a worker POST on a transient (retryable) error.
// Eval-only: the worker itself does NOT retry (that would double-charge the
// fan-out). Default retryable = the threaded-engine RPC timeout.

export function isThreadRpcTimeout(e: unknown): boolean {
  return e instanceof Error && /thread_rpc_timeout/.test(e.message);
}

export async function postWithRetry<T>(
  post: () => Promise<T>,
  opts?: { tries?: number; isRetryable?: (e: unknown) => boolean },
): Promise<T> {
  const tries = opts?.tries ?? 2;
  const isRetryable = opts?.isRetryable ?? isThreadRpcTimeout;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await post();
    } catch (e) {
      last = e;
      if (!isRetryable(e) || i === tries - 1) throw e;
    }
  }
  throw last;
}
