// src/shared/worker-auth.ts — the worker's local HTTP API is authenticated with a per-install secret (#229).
//
// The worker binds 127.0.0.1 only, but loopback is not the owner: any process on the host that can reach the
// port (another local user, a sandboxed tool that keeps the host network) could POST /homework/add or
// /worknote/set with plain curl. Every legitimate caller runs as the owner and reads the secret from
// CONFIG_DIR/worker.token (0600, owner-only ACL on Windows).
//
// Kept OUT of worker.env on purpose: loadWorkerEnv copies worker.env into process.env, and from there it is
// inherited by every child the worker spawns.
//
// TRANSITION. A session started before this release keeps its old hook bundle (the plugin cache is versioned)
// and its long-lived MCP server, both of which send no token. So the worker runs in one of two modes:
//   warn    (default): a WRONG token is refused; a MISSING token is served, counted per route and logged once an
//                      hour per route, and shown in /stats and `captain-memo doctor`.
//   enforce          : a missing token is refused too (CAPTAIN_MEMO_WORKER_AUTH=enforce in worker.env).
// Whatever the mode, GET /health is always open (every liveness probe and the hooks' fail-open check need it),
// and a route in alwaysEnforced() never accepts a missing token: no released client calls it tokenless.
import { randomBytes, timingSafeEqual } from 'crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { lockWorkerEnvFile } from './worker-env.ts';

export const WORKER_TOKEN_HEADER = 'x-captain-memo-worker-token';
export const WORKER_TOKEN_PATH = join(CONFIG_DIR, 'worker.token');

/** Create the secret if it does not exist yet (atomic: the first of several racing workers wins, the rest read
 *  it), tighten a file that is readable by others, and return it. Throws when it can neither create nor read it. */
export function ensureWorkerToken(path: string = WORKER_TOKEN_PATH): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    if (process.platform === 'win32') lockWorkerEnvFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  }
  const t = readFileSync(path, 'utf8').trim();
  if (!t) throw new Error(`${path} is empty`);
  return t;
}

/** The secret as a client reads it, or null when the file is missing or unreadable. Read on every call (a few
 *  microseconds): a long-lived MCP server that started before the worker created it picks it up on its next call. */
export function readWorkerToken(path: string = WORKER_TOKEN_PATH): string | null {
  try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
}

/** The header every local caller sends; {} when there is no secret to send (the worker then decides). */
export function workerAuthHeaders(path: string = WORKER_TOKEN_PATH): Record<string, string> {
  const t = readWorkerToken(path);
  return t ? { [WORKER_TOKEN_HEADER]: t } : {};
}

export type WorkerAuthMode = 'warn' | 'enforce';

export function workerAuthMode(env: Record<string, string | undefined> = process.env): WorkerAuthMode {
  return env.CAPTAIN_MEMO_WORKER_AUTH?.trim().toLowerCase() === 'enforce' ? 'enforce' : 'warn';
}

/** Routes that never accept a missing token, whatever the mode: internal routes (`/_…`), which no client calls
 *  over HTTP, and any route added after this release that no old client calls. */
export function alwaysEnforced(pathname: string): boolean {
  return pathname.includes('/_');
}

export interface TokenlessRow { count: number; last_at: number }

export interface WorkerAuthGate {
  /** null = let the request through; a Response = the refusal to send. */
  check(req: Request): Response | null;
  /** Tokenless requests served in warn mode since boot, by "METHOD /path". */
  report(): { mode: WorkerAuthMode; armed: boolean; tokenless: Record<string, TokenlessRow> };
}

const LOG_EVERY_MS = 3_600_000;

export function makeWorkerAuthGate(o: {
  token: string | null; mode: WorkerAuthMode; tokenPath?: string;
  log?: (line: string) => void; now?: () => number;
}): WorkerAuthGate {
  const path = o.tokenPath ?? WORKER_TOKEN_PATH;
  const log = o.log ?? ((l: string) => console.warn(l));
  const now = o.now ?? Date.now;
  const expected = o.token ? Buffer.from(o.token) : null;
  const tokenless = new Map<string, TokenlessRow & { logged_at: number }>();

  const refuse = (status: number, error: string, detail: string) => Response.json({ error, detail }, { status });

  return {
    check(req) {
      const { pathname } = new URL(req.url);
      if (req.method === 'GET' && pathname === '/health') return null;
      const sent = req.headers.get(WORKER_TOKEN_HEADER);
      if (sent !== null) {
        if (!expected) return refuse(503, 'worker_token_unavailable', `the worker has no token (${path} could not be created or read); see its log`);
        const got = Buffer.from(sent.trim());
        if (got.length === expected.length && timingSafeEqual(got, expected)) return null;
        return refuse(401, 'worker_auth_failed', `wrong worker token. Callers read it from ${path}; it changes only when that file is deleted and the worker restarts, so restart this session or tool.`);
      }
      if (o.mode === 'enforce' || alwaysEnforced(pathname)) {
        return refuse(401, 'worker_auth_required', `this request carried no worker token (header ${WORKER_TOKEN_HEADER}, read from ${path}, owner-only). A session started before worker auth sends none: restart it.`);
      }
      const key = `${req.method} ${pathname}`;
      const t = now();
      const row = tokenless.get(key) ?? { count: 0, last_at: 0, logged_at: -Infinity };
      row.count++; row.last_at = t;
      if (t - row.logged_at >= LOG_EVERY_MS) {
        row.logged_at = t;
        log(`[worker-auth] served a tokenless ${key} (warn mode). A session or tool started before worker auth sends no token: restart it. Set CAPTAIN_MEMO_WORKER_AUTH=enforce once \`captain-memo doctor\` shows none.`);
      }
      tokenless.set(key, row);
      return null;
    },
    report() {
      const out: Record<string, TokenlessRow> = {};
      for (const [k, v] of tokenless) out[k] = { count: v.count, last_at: v.last_at };
      return { mode: o.mode, armed: !!expected, tokenless: out };
    },
  };
}

/** The single-process listener answers /stats from the engine, which knows nothing of the gate: add its report
 *  on the way out, as threaded main does, so `captain-memo doctor` sees tokenless callers on either path. */
export async function withAuthReport(req: Request, res: Response, gate: WorkerAuthGate): Promise<Response> {
  if (req.method !== 'GET' || new URL(req.url).pathname !== '/stats' || !res.ok) return res;
  try {
    const body = await res.clone().json() as Record<string, unknown>;
    return Response.json({ ...body, worker_auth: gate.report() }, { status: res.status });
  } catch { return res; }
}

/** Boot helper for both serve paths: the secret (or null with the reason logged) + the gate. */
export function bootWorkerAuthGate(env: Record<string, string | undefined> = process.env): WorkerAuthGate {
  let token: string | null = null;
  try { token = ensureWorkerToken(); }
  catch (e) { console.error(`[worker-auth] could not create or read ${WORKER_TOKEN_PATH}: ${(e as Error).message}. Callers that send a token get 503; tokenless calls follow the mode.`); }
  return makeWorkerAuthGate({ token, mode: workerAuthMode(env) });
}
