// src/worker/thread-channel.ts — id-correlated request/response over a postMessage-style
// transport, BIDIRECTIONAL: each side may both request() and serve(op). Requests carry an
// `op` so one channel can host several handlers (the engine serves 'http'). Heartbeat/ready/
// fatal ride the same transport as separate {kind:'beat'|'ready'|...} messages handled
// OUTSIDE this class.
let seq = 0;
function nextId(): string { return `r${(seq = (seq + 1) % Number.MAX_SAFE_INTEGER)}`; }

export interface Transport {
  post: (msg: unknown) => void;
  onMessage: (cb: (msg: unknown) => void) => void;
}

type ReqMsg = { kind: 'req'; id: string; op: string; data: unknown };
type ResMsg = { kind: 'res'; id: string; data: unknown };
type ErrMsg = { kind: 'err'; id: string; message: string };

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class ThreadChannel {
  private pending = new Map<string, Pending>();
  private handlers = new Map<string, (data: unknown) => Promise<unknown>>();

  constructor(private transport: Transport, private timeoutMs = 30_000) {
    transport.onMessage((msg) => { void this.dispatch(msg as ReqMsg | ResMsg | ErrMsg); });
  }

  /** Responder side: register a handler for ONE op. Call once per op. */
  serve(op: string, handler: (data: unknown) => Promise<unknown>): void { this.handlers.set(op, handler); }

  /** Requester side: send a request for one op; resolve with the responder's result.
   *  `timeoutMs` overrides the channel default for this one call — used for known-long write ops
   *  (e.g. /reindex) that legitimately run for minutes and must not be abandoned at the 10s default. */
  request(op: string, data: unknown, timeoutMs?: number): Promise<unknown> {
    const id = nextId();
    const deadline = timeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('thread_rpc_timeout')); }, deadline);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.post({ kind: 'req', id, op, data } satisfies ReqMsg);
    });
  }

  private async dispatch(msg: ReqMsg | ResMsg | ErrMsg): Promise<void> {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'req') {
      const handler = this.handlers.get(msg.op);
      if (!handler) { this.transport.post({ kind: 'err', id: msg.id, message: 'no_handler:' + msg.op } satisfies ErrMsg); return; }
      try {
        const data = await handler(msg.data);
        this.transport.post({ kind: 'res', id: msg.id, data } satisfies ResMsg);
      } catch (e) {
        this.transport.post({ kind: 'err', id: msg.id, message: (e as Error).message } satisfies ErrMsg);
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;                       // late / unknown id
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.kind === 'res') p.resolve(msg.data);
    else p.reject(new Error(msg.message));
  }

  /** Reject every in-flight request — called when the peer thread dies. */
  rejectAll(reason: string): void {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    this.pending.clear();
  }
}
