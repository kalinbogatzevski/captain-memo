// PreToolUse (Bash) — warn before a mutating git op on a working tree another session is using.
// Advisory only (fail-open): parse the command, resolve the cwd's repo root, ask the board who holds it,
// and if a PEER session does, emit additionalContext suggesting a worktree. Any error → silent no-op.
import { workerFetch, writeStdout, logHookError } from './shared.ts';
import { detectRepoRootSync } from '../worker/branch.ts';

const MUTATING = /^(checkout|switch|commit|reset|stash|rebase|merge|cherry-pick|clean|restore)$/;

interface Payload { session_id?: string; cwd?: string; tool_name?: string; tool_input?: { command?: unknown } & Record<string, unknown>; }
interface Holder { session_id: string; agent?: string; branch?: string; is_dirty?: boolean }
interface RepoActiveResp { holders?: Holder[] }
const HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);

/** Return the mutating git subcommand invoked by a shell command, or null. Finds a `git` token
 *  (not preceded by a quote/word char), then the next non-flag token as the subcommand — skipping
 *  the value of value-taking global flags (`-C <dir>`, `-c <name=value>`) so it doesn't mistake the
 *  flag's argument for the subcommand. Tolerates leading env assignments and `cd … &&`. Deliberately
 *  conservative — a miss just skips the warning. */
export function parseGitOp(command: string): string | null {
  if (typeof command !== 'string') return null;
  // split on shell separators so `echo git commit` (git not invoked) doesn't match a later segment's rules
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++;   // skip env assignments
    if (toks[i] !== 'git') continue;
    let j = i + 1;
    while (j < toks.length && toks[j]!.startsWith('-')) {                       // skip global flags (-C, -c …)
      const flag = toks[j]!;
      j++;
      if (flag === '-C' || flag === '-c') j++;                                 // …and their required value
    }
    const sub = toks[j];
    if (sub && MUTATING.test(sub)) return sub;
  }
  return null;
}

export async function runPreGit(payload: Payload): Promise<void> {
  const op = parseGitOp(typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '');
  if (!op || !payload.cwd) return;
  const root = detectRepoRootSync(payload.cwd);
  if (!root || root.includes('/claude-1000/')) return;            // no repo / scratchpad → nothing shared
  const res = await workerFetch<RepoActiveResp>(`/worknote/repo-active?repo_root=${encodeURIComponent(root)}`, { method: 'GET', timeoutMs: HOOK_TIMEOUT_MS });
  if (!res.ok || !res.body?.holders) return;
  const peers = res.body.holders.filter((h) => h.session_id !== payload.session_id);
  if (peers.length === 0) return;
  const who = peers.map((h) => `${(h.session_id ?? '').slice(0, 12)} (${h.agent ?? '?'})${h.branch ? ` on ${h.branch}` : ''}${h.is_dirty ? ', dirty' : ''}`).join(' ; ');
  const warning = `WORK-BOARD SHARED CHECKOUT: peer session(s) are using ${root} — ${who}. Running \`git ${op}\` here changes that shared working tree for them. Isolate instead: \`git worktree add ../<name> <branch>\` and work there. (advisory)`;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } }));
}
