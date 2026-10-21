// Codex's home. Shared by cross-ai.ts (connect, doctor, the approvals refresh) and the readers that look at the same folder
// (summarizer-login.ts), so it imports only path + os.
import { homedir } from 'os';
import { join } from 'path';

/** Codex's home: $CODEX_HOME when set and non-empty, else <home>/.codex (%USERPROFILE%\.codex on Windows). Codex itself
 *  treats an empty CODEX_HOME as unset. Observed with codex-cli 0.159.3 in a throwaway CODEX_HOME: config.toml
 *  (`codex mcp add` writes it there), hooks.json and skills/ are read from it and ~/.codex is ignored; a CODEX_HOME that
 *  does not exist makes codex refuse to start. A whitespace-only value is NOT trimmed to unset: codex takes " " as a path
 *  and fails with "CODEX_HOME points to " ", but that path does not exist" (same version, 2026-10-21). `env` is
 *  injectable so a test never reads the developer's real one. */
export function codexHomeDir(home: string = homedir(), env: Record<string, string | undefined> = process.env): string {
  return env.CODEX_HOME || join(home, '.codex');
}
