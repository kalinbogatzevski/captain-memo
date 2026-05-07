// Claude Code subprocess transport for Summarizer.
//
// Lets Max-plan users skip ANTHROPIC_API_KEY entirely — the `claude` CLI
// authenticates via OAuth/keychain and counts against the user's Max quota.
//
// Trade-offs vs the default Anthropic SDK transport:
//   - +1-2s latency per call (subprocess + Claude Code boot).
//   - Counts against Max session rate limits, not API billing.
//   - Errors come back as `{is_error: true, result: "<message>"}` rather
//     than HTTP 4xx; the parser maps "model_not_found"/"not_found" into a
//     synthetic `Error` with `status: 404` so the existing fallback chain
//     in Summarizer continues to walk.

import type { SummarizerTransport, SummarizerTransportArgs, SummarizerTransportResult } from './summarizer.ts';

/**
 * Subset of the JSON envelope returned by `claude -p --output-format json`.
 * Fields we don't use are intentionally omitted to keep the contract narrow.
 */
interface ClaudeCodeEnvelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  result: string;
}

/**
 * Minimal shape of `Bun.spawn` we depend on. Tests inject a stub.
 */
export type SpawnFn = (args: {
  cmd: string[];
  stdout: 'pipe';
  stderr: 'pipe';
}) => {
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
};

export interface ClaudeCodeTransportOptions {
  spawn?: SpawnFn;
  /** Override the binary name; defaults to `claude`. */
  bin?: string;
  /** Extra CLI flags appended after `-p`. Tests may pass `--bare` here. */
  extraArgs?: string[];
}

/**
 * Build a SummarizerTransport that shells out to `claude -p` with the
 * configured model and prompt. JSON output is parsed and re-shaped into
 * the same `{ content, model }` form the SDK transport returns, so the
 * rest of Summarizer is unchanged.
 */
export function createClaudeCodeTransport(opts: ClaudeCodeTransportOptions = {}): SummarizerTransport {
  const spawnFn: SpawnFn = opts.spawn ?? (Bun.spawn as unknown as SpawnFn);
  const bin = opts.bin ?? 'claude';
  const extraArgs = opts.extraArgs ?? [];

  return async (args: SummarizerTransportArgs): Promise<SummarizerTransportResult> => {
    const cmd = [
      bin, '-p',
      '--model', args.model,
      '--append-system-prompt', args.system,
      '--output-format', 'json',
      ...extraArgs,
      args.user,
    ];
    const proc = spawnFn({ cmd, stdout: 'pipe', stderr: 'pipe' });
    const stdoutText = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (!stdoutText.trim()) {
      throw new Error(`claude-code transport: empty stdout (exit ${exitCode})`);
    }

    let envelope: ClaudeCodeEnvelope;
    try {
      envelope = JSON.parse(stdoutText) as ClaudeCodeEnvelope;
    } catch (err) {
      throw new Error(`claude-code transport: failed to parse JSON envelope: ${(err as Error).message}`);
    }

    if (envelope.is_error) {
      const message = envelope.result || `claude-code transport: error (exit ${exitCode})`;
      const e = new Error(message) as Error & { status?: number };
      // Map model-not-found-style errors to status=404 so the Summarizer's
      // fallback chain walker treats them the same way it treats SDK 404s.
      // The Claude Code CLI surfaces several phrasings for "this model isn't
      // available to you" — catch all of them.
      if (
        /model_not_found|not_found|invalid.*model/i.test(message) ||
        /issue with.*model/i.test(message) ||
        /model.*may not (exist|have access)/i.test(message) ||
        /pick a different model/i.test(message)
      ) {
        e.status = 404;
      }
      throw e;
    }

    if (typeof envelope.result !== 'string') {
      throw new Error(`claude-code transport: missing 'result' field in envelope`);
    }

    return {
      content: [{ type: 'text', text: envelope.result }],
      model: args.model,
    };
  };
}
