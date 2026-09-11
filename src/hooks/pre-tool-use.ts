// PreToolUse hook — work-board auto-claim + overlap warning.
//
// Before a file-touching tool call, publish THIS session's recently-edited files to the shared work board
// (POST /worknote/set) so other captains can SEE what is being touched, and surface a NON-BLOCKING warning
// when another captain's claim overlaps. This is the active half of fleet coordination: observations are
// passive (after the fact); claims are the radar that stops two captains clobbering the same file.
//
// "File-touching" means BOTH:
//   • the edit tools (Edit/Write/MultiEdit/NotebookEdit), which carry an explicit tool_input.file_path; and
//   • Bash/PowerShell commands that WRITE — `sed -i`, `>`/`>>`, heredocs, `tee`, `Set-Content`, …
// The second half used to be missing entirely: the Bash branch ran the git check and returned without ever
// claiming. That is not an edge case — in bypass-permissions mode Claude Code is explicitly instructed to
// edit with sed/heredocs INSTEAD of the edit tools, so an entire session's work published nothing and the
// board showed it idle. PowerShell was worse still: it matched no PreToolUse matcher at all.
//
// Fail-open contract (shared.ts): NEVER block an edit. workerFetch is bounded and never throws, every path
// returns cleanly, and the only stdout is an advisory additionalContext note — never a deny. A worker outage,
// bad payload, or timeout is a silent no-op. stdout is written AT MOST ONCE: the host parses a single JSON
// object, so the two possible advisories (shared checkout, work-board overlap) are merged into one emit.
import { readStdinJson, workerFetch, writeStdout, resolveProjectId, logHookError, logWorkerFailure, isMainModule } from './shared.ts';
import { parseWrittenPaths, isCoarseClaim } from './shell-writes.ts';
import { detectRepoRootSync } from '../worker/branch.ts';

interface PreToolUsePayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown; command?: unknown } & Record<string, unknown>;
}
interface WorkNote { session_id: string; agent?: string; files?: string[]; what?: string }
interface OverlapHit { session_id: string; agent?: string; files?: string[]; overlapping?: string[]; what?: string; kind?: 'files' | 'semantic'; similarity?: number }
interface SetResp { session_id: string; ttl_s: number; overlaps?: OverlapHit[] }
interface ActiveResp { claims?: WorkNote[] }

const HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
const MAX_FILES = 25;

/** Shells whose commands we parse for writes. Bash was already matched; PowerShell is the primary shell
 *  on Windows and previously matched NO PreToolUse hook, so nothing it did was ever visible to the fleet. */
const SHELL_TOOLS: Record<string, 'posix' | 'powershell'> = { Bash: 'posix', PowerShell: 'powershell' };

/** Publish/refresh this session's claim, and return an overlap advisory when one is warranted. */
async function publishClaim(sid: string, cwd: string | undefined, touched: string[]): Promise<string | null> {
  const project = resolveProjectId(cwd);

  // accumulate this session's recently-touched files so the claim persists across edits (not just the last file)
  let files = [...touched];
  const cur = await workerFetch<ActiveResp>(`/worknote/active?session_id=${encodeURIComponent(sid)}`, { method: 'GET', timeoutMs: HOOK_TIMEOUT_MS });
  if (cur.ok && cur.body?.claims) {
    const mine = cur.body.claims.find((c) => c.session_id === sid);
    if (mine?.files?.length) files = [...new Set([...mine.files, ...touched])];
  }
  if (files.length > MAX_FILES) files = files.slice(-MAX_FILES);

  const set = await workerFetch<SetResp>('/worknote/set', {
    method: 'POST',
    // enrich_from_observations: let the worker swap this generic `what` for the session's latest observation
    // title (its real meaning) so the board reads well AND the semantic overlap pass has true intent to compare.
    // NOTE it is INFERRED, not declared — it can name the wrong thing. The articles tell the agent to state
    // real intent with work_set; this is a file radar, not a substitute for saying what you are doing.
    body: { session_id: sid, agent: 'claude', what: `editing ${files.length} file(s) in ${project}`, files, enrich_from_observations: true },
    timeoutMs: HOOK_TIMEOUT_MS,
  });
  logWorkerFailure('PreToolUse', '/worknote/set', set);
  if (!set.ok || !set.body) return null;

  const overlaps = set.body.overlaps ?? [];
  if (overlaps.length === 0) return null;

  // Two collision kinds: same FILES (glob overlap) and same INTENT by meaning (semantic, possibly different files).
  const fileHits = overlaps.filter((o) => o.kind !== 'semantic');
  const semHits = overlaps.filter((o) => o.kind === 'semantic');
  const parts: string[] = [];
  if (fileHits.length > 0) {
    const who = fileHits
      .map((o) => `${(o.session_id ?? '').slice(0, 12)} (${o.agent ?? '?'}) on ${(((o.overlapping ?? o.files) ?? [])).join(', ')}`)
      .join(' ; ');
    parts.push(`editing the same files: ${who}`);
  }
  if (semHits.length > 0) {
    const who = semHits
      .map((o) => `${(o.session_id ?? '').slice(0, 12)} (${o.agent ?? '?'}) on "${(o.what ?? '').slice(0, 80)}"${typeof o.similarity === 'number' ? ` (~${o.similarity.toFixed(2)})` : ''}`)
      .join(' ; ');
    parts.push(`working on the same thing by meaning: ${who}`);
  }
  return `WORK-BOARD OVERLAP: another captain is ${parts.join('; and is ')}. Check the captain-memo work board (work_active) and coordinate, or pick a different area, before continuing.`;
}

export async function main(): Promise<void> {
  let payload: PreToolUsePayload = {};
  try { payload = await readStdinJson<PreToolUsePayload>(); } catch (err) { logHookError('PreToolUse', err); return; }

  const sid = payload.session_id;
  const shell = SHELL_TOOLS[payload.tool_name ?? ''];
  const advisories: string[] = [];

  if (shell) {
    // 1. shared-checkout advisory (mutating git op on a tree a peer holds)
    try {
      const gitWarn = await (await import('./pre-git.ts')).runPreGit(payload as never);
      if (gitWarn) advisories.push(gitWarn);
    } catch (err) { logHookError('PreToolUse', err); }

    // 2. claim whatever this command WRITES. Parsing is pure, cheap and happens BEFORE any worker
    //    round-trip, so the overwhelmingly common read-only command (`ls`, `cat`, `grep`, `bun test`)
    //    short-circuits here and costs nothing — Bash fires far more often than the edit tools.
    const cmd = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '';
    let written = parseWrittenPaths(cmd, payload.cwd ?? '', shell);

    // The parser is PURE, so its "I could not name the target" fallback is `<cwd>/**` — and a cwd can be
    // a broad parent holding many unrelated projects. Observed live: a session at `C:\src` (not a repo
    // at all) claimed `C:\src/**`, which then overlapped every project beneath it and warned sessions
    // that shared nothing with it. Narrow it here, where touching the filesystem is allowed: bound the
    // claim to the REPO, which is the actual unit of sharing and the only thing that stamps repo_root.
    // Outside a repo — or in a per-session scratchpad — there is nothing shared, so claim nothing.
    if (payload.cwd && isCoarseClaim(written, payload.cwd)) {
      const root = detectRepoRootSync(payload.cwd);
      written = root && !root.includes('/claude-1000/') ? [`${root}/**`] : [];
    }

    if (sid && written.length > 0) {
      try {
        const warn = await publishClaim(sid, payload.cwd, written);
        if (warn) advisories.push(warn);
      } catch (err) { logHookError('PreToolUse', err); }
    }
  } else {
    const ip = payload.tool_input ?? {};
    const fp = typeof ip.file_path === 'string' ? ip.file_path
      : typeof ip.notebook_path === 'string' ? ip.notebook_path
      : undefined;
    if (!sid || !fp) return;   // only file-editing tools carry a path; everything else is a no-op
    try {
      const warn = await publishClaim(sid, payload.cwd, [fp]);
      if (warn) advisories.push(warn);
    } catch (err) { logHookError('PreToolUse', err); }
  }

  // advisory only — inject context, NEVER deny the edit. One emit, one JSON object.
  if (advisories.length === 0) return;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: advisories.join('\n\n') } }));
}

if (isMainModule(import.meta)) {
  try {
    await main();
  } catch (err) {
    logHookError('PreToolUse', err);
    process.exit(0);
  }
}
