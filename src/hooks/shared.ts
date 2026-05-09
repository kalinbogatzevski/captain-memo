// Shared helpers for the four hook scripts.
//
// Hook contract: Claude Code spawns the hook process, writes a JSON payload
// to stdin, and reads the hook's stdout. Errors should NEVER cause the hook
// to print stack traces — fail-open is the contract. The script's job is to
// pass through (UserPromptSubmit appends the envelope; others just log).
//
// To make "fail-open" debuggable, all hooks log unhandled errors to
// ~/.captain-memo/logs/hook.log via logHookError below; CAPTAIN_MEMO_HOOK_DEBUG=1
// also tees them to stderr.

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DEFAULT_WORKER_PORT } from '../shared/paths.ts';

const HOOK_LOG_DIR = join(homedir(), '.captain-memo', 'logs');
const HOOK_LOG_FILE = join(HOOK_LOG_DIR, 'hook.log');
const HOOK_LOG_ROTATE_BYTES = 10 * 1024 * 1024; // 10 MB

function rotateIfNeeded(): void {
  try {
    if (!existsSync(HOOK_LOG_FILE)) return;
    const sz = statSync(HOOK_LOG_FILE).size;
    if (sz < HOOK_LOG_ROTATE_BYTES) return;
    // Single-step rollover (lossy is fine for debug logs): hook.log → hook.log.1
    renameSync(HOOK_LOG_FILE, HOOK_LOG_FILE + '.1');
  } catch {
    // rotation failure is non-fatal — keep going on the original file
  }
}

export function logHookError(event: string, err: unknown): void {
  try {
    mkdirSync(HOOK_LOG_DIR, { recursive: true });
    rotateIfNeeded();
    const e = err as Error;
    const line = `${new Date().toISOString()} [${event}] ${e?.name ?? 'Error'}: ${e?.message ?? String(err)}\n${e?.stack ?? ''}\n`;
    appendFileSync(HOOK_LOG_FILE, line);
    if (process.env.CAPTAIN_MEMO_HOOK_DEBUG === '1') {
      process.stderr.write(line);
    }
  } catch {
    // last-ditch — fs failed; nothing left to do without violating the hook contract.
  }
}

const WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

/** Read all of stdin synchronously (Bun supports this via Bun.stdin). */
export async function readStdinJson<T = unknown>(): Promise<T> {
  const text = await Bun.stdin.text();
  if (!text || !text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`hook: failed to parse stdin JSON: ${(err as Error).message}`);
  }
}

/** Write a string to stdout, no trailing newline added (caller controls).
 *  Uses process.stdout.write (Node-compatible, synchronous-ish path) instead
 *  of Bun.write — the latter returns a Promise we'd have to await everywhere
 *  to guarantee the buffer flushes before process exit. With pipes (Claude
 *  Code's hook protocol), unawaited Bun.write can leave bytes in a buffer
 *  that the parent never reads. */
export function writeStdout(s: string): void {
  process.stdout.write(s);
}

export interface FetchWithTimeoutOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs: number;
}

export interface FetchResult<T> {
  ok: boolean;
  status: number;
  body: T | null;
  timedOut: boolean;
  errorMessage: string | null;
}

/**
 * Bounded fetch — returns a structured result, NEVER throws.
 * Used by every hook so a worker outage cannot block Claude Code.
 */
export async function workerFetch<T>(
  path: string,
  opts: FetchWithTimeoutOptions,
): Promise<FetchResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      signal: controller.signal,
    };
    if (opts.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${WORKER_BASE}${path}`, init);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: null, timedOut: false, errorMessage: `${res.status}: ${txt}` };
    }
    const body = await res.json() as T;
    return { ok: true, status: res.status, body, timedOut: false, errorMessage: null };
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'AbortError' || /aborted/i.test(e.message);
    return { ok: false, status: 0, body: null, timedOut, errorMessage: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Coerce hook-time CWD → project_id for non-installed flows. Honors $CAPTAIN_MEMO_PROJECT_ID. */
export function resolveProjectId(cwd: string | undefined): string {
  if (process.env.CAPTAIN_MEMO_PROJECT_ID) return process.env.CAPTAIN_MEMO_PROJECT_ID;
  if (!cwd) return 'default';
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'default';
}

/** Truncate any string to ≤ N chars, preserving a trailing marker. */
export function clamp(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Compact-stringify any object/value for tool_input/tool_response summaries. */
export function summarize(value: unknown, max = 1500): string {
  try {
    return clamp(typeof value === 'string' ? value : JSON.stringify(value), max);
  } catch {
    return '[unserializable]';
  }
}
