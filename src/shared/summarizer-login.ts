// src/shared/summarizer-login.ts — which subscription-backed summarizers are actually logged in on THIS machine.
//
// The install wizard used to recommend "Claude via OAuth" unconditionally, and a first install on a laptop
// with no Claude login took that default and came up with a dead summarizer (doctor: "no usable
// credentials"). This is the cheap local signal the wizard needs to recommend, and headless installs to
// pick, the first provider that can run right now. Mirrors the worker's login checks (ai-capacity.ts,
// federation-only code the shared CLI must not import): Claude = env token or ~/.claude/.credentials.json
// with an access token; Codex = codex on PATH + ~/.codex/auth.json (api key or tokens); agy = agy on PATH +
// either its OAuth token file under the Gemini dir or, on a desktop where agy keeps its login in the OS keyring
// instead (Linux Secret Service, Windows Credential Manager), a keyring item. Read-only. summarizerLogins() is
// pure over its inputs and spawns nothing; only probeSummarizerLogins() asks the keyring, with the one bounded,
// read-only query of secret-store.ts (names only, no secret, never starts a keyring daemon), and only when agy is
// on PATH and its token file is missing.
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AGY_KEYRING_ATTRS, probeSecretStore, type SecretStoreState } from './secret-store.ts';

export type LoginProbeEnv = {
  env: Record<string, string | undefined>;
  home: string;
  exists(path: string): boolean;
  readFile(path: string): string | null;
  which(bin: string): string | null;
};

export const realLoginProbeEnv = (): LoginProbeEnv => ({
  env: process.env,
  home: homedir(),
  exists: (p) => { try { return existsSync(p); } catch { return false; } },
  readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
  which: (bin) => { try { return Bun.which(bin); } catch { return null; } },
});

function json(env: LoginProbeEnv, path: string): Record<string, unknown> | null {
  const raw = env.readFile(path);
  if (!raw) return null;
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
}
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function claudeOauthLoggedIn(env: LoginProbeEnv = realLoginProbeEnv()): boolean {
  if (str(env.env.CLAUDE_CODE_OAUTH_TOKEN)) return true;
  const dir = str(env.env.CLAUDE_CONFIG_DIR) ? env.env.CLAUDE_CONFIG_DIR : join(env.home, '.claude');
  const oauth = json(env, join(dir, '.credentials.json'))?.claudeAiOauth as Record<string, unknown> | undefined;
  return !!oauth && str(oauth.accessToken);
}

export function codexLoggedIn(env: LoginProbeEnv = realLoginProbeEnv()): boolean {
  if (!env.which('codex')) return false;
  const dir = str(env.env.CODEX_HOME) ? env.env.CODEX_HOME : join(env.home, '.codex');
  const auth = json(env, join(dir, 'auth.json'));
  return !!auth && (str(auth.OPENAI_API_KEY) || (!!auth.tokens && typeof auth.tokens === 'object'));
}

/** `keyring` is the last answer of secret-store.ts for agy's login item; 'locked' counts (the item exists, it just is
 *  not readable until the keyring is unlocked). undefined / null = not asked or could not ask. */
export function agyLoggedIn(env: LoginProbeEnv = realLoginProbeEnv(), keyring?: SecretStoreState | null): boolean {
  if (!env.which('agy')) return false;
  const dir = str(env.env.GEMINI_CLI_HOME) ? env.env.GEMINI_CLI_HOME : join(env.home, '.gemini');
  if (env.exists(join(dir, 'antigravity-cli', 'antigravity-oauth-token'))) return true;
  return keyring === 'unlocked' || keyring === 'locked';
}

export type SummarizerLogins = { 'claude-oauth': boolean; codex: boolean; agy: boolean };

/** The subscription-backed providers, in the wizard's order, with whether each is usable here right now. */
export function summarizerLogins(env: LoginProbeEnv = realLoginProbeEnv(), agyKeyring?: SecretStoreState | null): SummarizerLogins {
  return { 'claude-oauth': claudeOauthLoggedIn(env), codex: codexLoggedIn(env), agy: agyLoggedIn(env, agyKeyring) };
}

/** summarizerLogins() plus the OS keyring question for agy, for the wizard's async call sites. The keyring is asked only
 *  when the answer can change the result: agy is on PATH and its token file did not already say "logged in". */
export async function probeSummarizerLogins(
  env: LoginProbeEnv = realLoginProbeEnv(),
  probe: typeof probeSecretStore = probeSecretStore,
): Promise<SummarizerLogins> {
  const logins = summarizerLogins(env);
  if (logins.agy || !env.which('agy')) return logins;
  return summarizerLogins(env, await probe(AGY_KEYRING_ATTRS));
}
