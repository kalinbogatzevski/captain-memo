// Codex CLI subprocess transport for Summarizer.
//
// Lets ChatGPT Plus/Pro users run the summarizer with no API key at all —
// `codex exec` authenticates via the ChatGPT account already logged in with
// `codex login`. This is the OpenAI-side counterpart to summarizer-claude-code:
// it exists so a user with a ChatGPT subscription but NO Anthropic subscription
// still gets observations. ('claude-oauth'/'claude-code' both assume Max/Pro;
// 'anthropic'/'openai-compatible' both demand a paid API key.)
//
// Trade-offs vs the claude-oauth transport (~700 ms/call):
//   - ~6-7 s per call. Measured across the whole model ladder (gpt-5.4-mini
//     through gpt-5.6-sol) the latency is flat, so this is `codex exec` booting
//     an agent runtime — NOT inference. Picking a smaller model saves quota,
//     not wall-clock. Codex exposes no non-agent completion entrypoint, so
//     there is no way around the floor.
//   - Costs ~10k input tokens/call of Codex's own agent scaffolding on top of
//     our prompt (partly cached). Fine for a background queue, wasteful if you
//     have a cheaper option.
// Neither hurts interactively: summarization runs off a 5 s background tick and
// collapses a whole prompt window into ONE call, so the user never waits on it.
//
// Flags that are load-bearing, not cosmetic:
//   --ignore-user-config  The user's ~/.codex/config.toml may set a heavyweight
//                         reasoning effort and register MCP servers — including
//                         captain-memo itself. Without this, every summarize call
//                         boots those MCP servers as child processes and burns
//                         high-effort reasoning on a 5-line JSON blob.
//   --ephemeral           Otherwise every call writes a session file; this runs
//                         on every prompt window, forever.
//   --sandbox read-only   The summarizer must never execute model-authored writes.
//   stdin: 'ignore'       Without it codex blocks on "Reading additional input
//                         from stdin" when stdin is an open pipe (i.e. the worker).

import type { SummarizerTransport, SummarizerTransportArgs, SummarizerTransportResult } from './summarizer.ts';

/**
 * Sentinel model meaning "don't pass -m; let Codex use the account default".
 *
 * This exists because a ChatGPT account gates the model list server-side and the
 * allowed set differs per plan and shifts over releases — every `gpt-5.1-*` slug
 * and `gpt-5.4-nano` are rejected outright on a ChatGPT account with
 * "model is not supported when using Codex with a ChatGPT account". A terminal
 * fallback that passes no model at all is the one candidate that cannot 400,
 * so the fallback chain always has a floor that works.
 *
 * It is a real string (not '') because Summarizer drops falsy entries from the
 * fallback chain (summarizer.ts:100).
 */
export const CODEX_ACCOUNT_DEFAULT = 'default';

/** JSONL events emitted by `codex exec --json`. Only the fields we consume. */
interface CodexEvent {
  type?: string;
  /** on {"type":"item.completed"} */
  item?: { type?: string; text?: string };
  /** on {"type":"turn.completed"} */
  usage?: { input_tokens?: number; output_tokens?: number };
  /** on {"type":"error"} — a JSON-encoded error envelope, as a string */
  message?: string;
  /** on {"type":"turn.failed"} */
  error?: { message?: string };
}

/** Minimal shape of `Bun.spawn` we depend on. Tests inject a stub. */
export type SpawnFn = (args: {
  cmd: string[];
  stdin: 'ignore';
  stdout: 'pipe';
  stderr: 'pipe';
}) => {
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
  kill?: (signal?: string | number) => void;
};

export interface CodexTransportOptions {
  spawn?: SpawnFn;
  /** Override the binary name; defaults to `codex`. */
  bin?: string;
  /** Extra CLI flags appended before the prompt. */
  extraArgs?: string[];
}

/** True for errors meaning "this model isn't available to you", which Summarizer's
 *  fallback chain walks past (it keys on status 404, like the SDK's 404s). */
function isModelRejection(message: string): boolean {
  return (
    /not supported when using Codex/i.test(message) ||
    /model_not_found|not_found/i.test(message) ||
    /unknown model|invalid.*model|model.*not.*(exist|available)/i.test(message)
  );
}

/**
 * Build a SummarizerTransport that shells out to `codex exec --json`.
 *
 * Codex has no system-prompt flag, so system and user are concatenated into the
 * single positional prompt. The JSONL stream is reduced to the same
 * `{ content, model, usage }` shape the SDK transport returns, so Summarizer's
 * JSON extraction, schema validation and fallback walking are unchanged.
 */
export function createCodexTransport(opts: CodexTransportOptions = {}): SummarizerTransport {
  const spawnFn: SpawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);
  const bin = opts.bin ?? 'codex';
  const extraArgs = opts.extraArgs ?? [];

  return async (args: SummarizerTransportArgs): Promise<SummarizerTransportResult> => {
    const cmd = [
      bin, 'exec',
      '--json',
      '--ignore-user-config',
      '-c', 'model_reasoning_effort=low',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
      ...(args.model && args.model !== CODEX_ACCOUNT_DEFAULT ? ['-m', args.model] : []),
      ...extraArgs,
      `${args.system}\n\n${args.user}`,
    ];

    const proc = spawnFn({ cmd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    // Same reasoning as the claude-code transport: a wedged subprocess would
    // never resolve `exited`, stranding processBatch's in-flight guard and
    // silently halting the observation queue forever. Codex's agent boot makes
    // it slower than `claude -p`, so the floor is 120 s rather than 60 s.
    const timeoutMs = Number(process.env.CAPTAIN_MEMO_SUMMARIZER_TIMEOUT_MS ?? 120_000);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill?.(); } catch { /* already exited */ }
    }, timeoutMs);
    const stdoutText = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    clearTimeout(timer);
    if (timedOut) {
      throw new Error(`codex transport: timed out after ${timeoutMs}ms`);
    }

    let text: string | null = null;
    let usage: { input_tokens: number; output_tokens: number } | undefined;
    let errMessage: string | null = null;

    for (const line of stdoutText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue; // codex interleaves plain-text notices
      let ev: CodexEvent;
      try {
        ev = JSON.parse(trimmed) as CodexEvent;
      } catch {
        continue; // a non-event line; the envelope we need is well-formed or absent
      }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        text = ev.item.text; // last agent_message wins
      } else if (ev.type === 'turn.completed' && ev.usage) {
        const { input_tokens, output_tokens } = ev.usage;
        if (input_tokens !== undefined && output_tokens !== undefined) {
          usage = { input_tokens, output_tokens };
        }
      } else if (ev.type === 'error') {
        errMessage = ev.message ?? 'codex reported an error';
      } else if (ev.type === 'turn.failed') {
        errMessage = ev.error?.message ?? errMessage ?? 'codex turn failed';
      }
    }

    if (errMessage !== null) {
      const e = new Error(errMessage) as Error & { status?: number };
      if (isModelRejection(errMessage)) e.status = 404;
      throw e;
    }
    if (text === null) {
      throw new Error(
        `codex transport: no agent_message in output (exit ${exitCode})` +
        (stdoutText.trim() ? '' : ' — empty stdout; is `codex` on PATH and logged in?'),
      );
    }

    return {
      content: [{ type: 'text', text }],
      model: args.model,
      ...(usage && { usage }),
    };
  };
}
