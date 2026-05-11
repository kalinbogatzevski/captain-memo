// Claude OAuth transport for Summarizer.
//
// Reads the OAuth access token Claude Code stored when the user ran
// `claude login` and uses it directly against api.anthropic.com — no
// subprocess, no API key, no per-call startup overhead. Usually a
// 700–1500 ms HTTP roundtrip, vs the 5–15 s of the subprocess transport.
//
// Token storage locations checked, in order:
//   1. ~/.claude/.credentials.json (file fallback when libsecret/Keychain
//      isn't available; default on most Linux installs without
//      `secret-tool` from libsecret-tools).
//   2. macOS Keychain via `security` (TODO: not yet implemented).
//   3. Linux libsecret via `secret-tool` (TODO: not yet implemented).
//   4. Windows Credential Manager via PowerShell (TODO: not yet implemented).
//
// On 401 we surface a clear "your OAuth token has expired — run `claude
// login` to refresh" error so the operator knows what to do.

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SummarizerTransport, SummarizerTransportArgs, SummarizerTransportResult } from './summarizer.ts';

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  loadedAt: number;
}

const CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';

// Cache the parsed token across calls. The credentials file rotates
// occasionally (refresh / re-login); refresh the cached value when its
// recorded expiresAt is within a 60 s safety window.
let cached: CachedToken | null = null;

export function readClaudeOauthToken(): CachedToken | null {
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached;

  if (!existsSync(CREDENTIALS_PATH)) return null;
  try {
    const raw = readFileSync(CREDENTIALS_PATH, 'utf-8');
    const data = JSON.parse(raw) as CredentialsFile;
    const oa = data.claudeAiOauth;
    if (!oa?.accessToken || !oa?.expiresAt) return null;
    cached = {
      accessToken: oa.accessToken,
      expiresAt: oa.expiresAt,
      loadedAt: Date.now(),
    };
    return cached;
  } catch {
    return null;
  }
}

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface ClaudeOauthTransportOptions {
  /** Override fetch (tests). */
  fetchFn?: typeof fetch;
  /** Per-call timeout. Long enough for haiku-4-5 plus margin. */
  timeoutMs?: number;
}

export function createClaudeOauthTransport(opts: ClaudeOauthTransportOptions = {}): SummarizerTransport {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.CAPTAIN_MEMO_SUMMARIZER_TIMEOUT_MS ?? 60_000);

  return async (args: SummarizerTransportArgs): Promise<SummarizerTransportResult> => {
    const cred = readClaudeOauthToken();
    if (!cred) {
      const e = new Error(
        `claude-oauth: no OAuth token found at ${CREDENTIALS_PATH}. ` +
        `Run \`claude login\` to authenticate, or switch ` +
        `CAPTAIN_MEMO_SUMMARIZER_PROVIDER to 'anthropic' (with API key) ` +
        `or 'claude-code' (subprocess).`,
      ) as Error & { status?: number };
      e.status = 401;
      throw e;
    }

    if (Date.now() >= cred.expiresAt) {
      const e = new Error(
        `claude-oauth: OAuth token expired (expiresAt=${new Date(cred.expiresAt).toISOString()}). ` +
        `Run \`claude login\` to refresh.`,
      ) as Error & { status?: number };
      e.status = 401;
      throw e;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetchFn(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${cred.accessToken}`,
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': OAUTH_BETA,
        },
        body: JSON.stringify({
          model: args.model,
          max_tokens: 4096,
          system: args.system,
          messages: [{ role: 'user', content: args.user }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const e = new Error(
          `claude-oauth: HTTP ${res.status}: ${body.slice(0, 500)}`,
        ) as Error & { status?: number };
        e.status = res.status;
        // Invalidate cache on 401 so the next call re-reads from disk
        // (in case the user just ran `claude login`).
        if (res.status === 401) cached = null;
        throw e;
      }

      const json = (await res.json()) as AnthropicMessageResponse;
      // Anthropic's `content` is an array of typed blocks. The summarizer
      // contract expects the same array shape; passing it through means
      // the parser in summarizer.ts can find the first text block normally.
      const content = (json.content ?? [])
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
        .map(c => ({ type: 'text' as const, text: c.text }));
      const usage = (json.usage?.input_tokens !== undefined && json.usage?.output_tokens !== undefined)
        ? { input_tokens: json.usage.input_tokens, output_tokens: json.usage.output_tokens }
        : undefined;
      return {
        content,
        model: json.model ?? args.model,
        ...(usage && { usage }),
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
