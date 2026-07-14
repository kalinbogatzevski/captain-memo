// Antigravity CLI (`agy`) subprocess transport for Summarizer.
//
// The THIRD zero-key provider, and the one with the widest reach: it authenticates
// off a Google account (the OAuth token `agy` already stored), so a user with
// neither a Claude subscription nor a ChatGPT one still gets observations.
//   claude-oauth / claude-code → needs Claude Max/Pro
//   codex                      → needs ChatGPT Plus/Pro
//   agy                        → needs a Google account          ← most people
//   anthropic / openai-compatible → needs a paid API key
//
// ~3.4-5.5s/call on `Gemini 3.5 Flash (Low)` — the fastest of the three agent-CLI
// transports, though still an agent-runtime boot rather than inference. Runs on the
// worker's background tick, so it never blocks a prompt.
//
// ─── ARGUMENT ORDER IS LOAD-BEARING. DO NOT "TIDY" IT. ───
//
// `--print`/`-p` is a STRING flag whose VALUE is the prompt — it is not a boolean.
// So the prompt must be the argument immediately following `-p`, and any other flag
// must come BEFORE it:
//
//   ✅ agy --sandbox --model "<m>" -p "<prompt>"
//   ❌ agy -p --model "<m>" "<prompt>"     ← -p swallows the literal string "--model"
//                                            as its prompt; agy then cheerfully answers
//                                            "I am running on Gemini 3.5 Flash" and the
//                                            real prompt is silently discarded. Exit 0.
//
// It does not error — it succeeds against the wrong input. summarizer-agy.test.ts
// asserts the prompt sits directly after `-p` precisely so this cannot come back.
//
// ─── WHY WE RUN IT UNDER AN ISOLATED $HOME ───
//
// `agy` has NO --ephemeral equivalent: every run persists a conversation, and it has no
// config/home override env var (it derives everything from $HOME). Measured: ONE call
// writes ~364 KB across 3 conversation entries. The summarizer runs on every prompt
// window, so left alone this would (a) grow without bound and (b) poison the user's real
// `agy --continue` history — their next `agy -c` would resume a *summarizer* conversation.
//
// So: point $HOME at a private dir under CAPTAIN_MEMO_DATA_DIR and symlink the real OAuth
// token in (a symlink, not a copy, so a re-`agy login` stays in sync). Verified: the
// user's ~/.gemini conversation count stays at delta 0. Then prune our own conversations
// dir after each call — verified safe, agy just recreates it.
//
// Requires agy >= 1.1.1. Two fixes there are non-negotiable for subprocess use:
//   - 1.1.1 fixed `agy -p` HANGING when run inside a subprocess (it read stdin). A hang
//     here would strand processBatch's in-flight guard and silently halt the queue.
//   - 1.1.1 fixed print mode exiting 0 with empty output on a server-side failure, which
//     would otherwise be indistinguishable from success.

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { DATA_DIR } from '../shared/paths.ts';
import type { SummarizerTransport, SummarizerTransportArgs, SummarizerTransportResult } from './summarizer.ts';

/** Sentinel model meaning "don't pass --model; use the account default". Mirrors the
 *  codex transport. A real string, not '', because Summarizer drops falsy fallbacks. */
export const AGY_ACCOUNT_DEFAULT = 'default';

/** Where the real `agy` keeps its OAuth token — the one thing we link into our home. */
const AGY_TOKEN_REL = join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

export type SpawnFn = (args: {
  cmd: string[];
  env: Record<string, string>;
  stdin: 'ignore';
  stdout: 'pipe';
  stderr: 'pipe';
}) => {
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
  kill?: (signal?: string | number) => void;
};

export interface AgyTransportOptions {
  spawn?: SpawnFn;
  /** Override the binary name; defaults to `agy`. */
  bin?: string;
  /** Override the isolated home; defaults to <DATA_DIR>/agy-home. Tests pass a temp dir. */
  agyHome?: string;
  /** Skip the home/token setup + conversation pruning (tests inject a stub spawn). */
  skipHomeSetup?: boolean;
}

/** Create the private agy home and link the real OAuth token into it. Idempotent. */
function ensureAgyHome(agyHome: string): void {
  const cliDir = join(agyHome, '.gemini', 'antigravity-cli');
  mkdirSync(cliDir, { recursive: true });
  const link = join(agyHome, AGY_TOKEN_REL);
  if (!existsSync(link)) {
    const real = join(homedir(), AGY_TOKEN_REL);
    // Symlink, not copy — so `agy login` refreshing the token is picked up for free.
    // If the user has never run `agy login` there is nothing to link; the spawn will
    // then fail with agy's own auth error, which is the right message to surface.
    if (existsSync(real)) symlinkSync(real, link);
  }
}

/** Drop the conversations this transport just wrote. Ours, disposable, and unbounded
 *  otherwise (~364 KB/call). Verified safe: agy recreates the dir on the next run. */
function pruneConversations(agyHome: string): void {
  try {
    rmSync(join(agyHome, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true, force: true });
  } catch { /* best-effort — a failed prune must never fail a summarize */ }
}

/** "this model isn't available" → status 404, which Summarizer's fallback chain walks. */
function isModelRejection(message: string): boolean {
  return /invalid --model|not recognized as a known model|Available models:/i.test(message);
}

export function createAgyTransport(opts: AgyTransportOptions = {}): SummarizerTransport {
  const spawnFn: SpawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);
  const bin = opts.bin ?? 'agy';
  const agyHome = opts.agyHome ?? join(DATA_DIR, 'agy-home');
  const manageHome = !opts.skipHomeSetup;

  return async (args: SummarizerTransportArgs): Promise<SummarizerTransportResult> => {
    if (manageHome) ensureAgyHome(agyHome);

    // Order matters — see the header. Every flag BEFORE -p; the prompt is -p's value
    // and therefore always the final element. agy has no system-prompt flag, so system
    // and user are concatenated into that one value.
    const cmd = [
      bin,
      '--sandbox', // the summarizer must never execute model-authored commands
      ...(args.model && args.model !== AGY_ACCOUNT_DEFAULT ? ['--model', args.model] : []),
      '-p', `${args.system}\n\n${args.user}`,
    ];

    const proc = spawnFn({
      cmd,
      env: { ...process.env as Record<string, string>, HOME: agyHome },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const timeoutMs = Number(process.env.CAPTAIN_MEMO_SUMMARIZER_TIMEOUT_MS ?? 120_000);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill?.(); } catch { /* already exited */ }
    }, timeoutMs);
    const stdoutText = await new Response(proc.stdout).text();
    const stderrText = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (manageHome) pruneConversations(agyHome);

    if (timedOut) throw new Error(`agy transport: timed out after ${timeoutMs}ms`);

    if (exitCode !== 0) {
      const message = (stderrText.trim() || stdoutText.trim() || `agy exited ${exitCode}`);
      const e = new Error(`agy transport: ${message}`) as Error & { status?: number };
      if (isModelRejection(message)) e.status = 404;
      throw e;
    }
    if (!stdoutText.trim()) {
      throw new Error(
        `agy transport: empty stdout (exit 0) — is \`agy\` on PATH and logged in? Run \`agy\` once to authenticate.`,
      );
    }

    // agy prints plain prose/JSON (no envelope, no markdown fences observed). Summarizer
    // extracts the JSON object from this text and validates it, so pass it through whole.
    return {
      content: [{ type: 'text', text: stdoutText }],
      model: args.model,
    };
  };
}
