// PreToolUse hook — work-board auto-claim, overlap warning, and the edit and deploy guards.
//
// Before a file-touching tool call, publish THIS session's recently-edited files to the shared work board
// (POST /worknote/set) so other sessions can SEE what is being touched, and warn when another claim overlaps.
//
// "File-touching" means:
//   • the edit tools (Edit/Write/MultiEdit/NotebookEdit; Gemini write_file/replace), which carry a file_path;
//   • Codex apply_patch, whose patch text names its files;
//   • shell commands that WRITE (`sed -i`, `>`/`>>`, heredocs, `tee`, `perl -i`, inline python/node writes, ...),
//     and uploads (scp, rsync, `ssh host 'cat > p' < f`). In bypass-permissions mode Claude Code is told to edit
//     with sed/heredocs INSTEAD of the edit tools, so without this a whole session published nothing.
//
// GUARDS (2026-09-30: two sessions in one checkout each deployed over the other while the board only warned):
//   2. a file another Claude Code session holds LIVE is refused (the worker decides; see guardContested);
//   3. an upload whose server copy is none of HEAD, the default branch, this file, or a copy this session fetched or
//      uploaded is refused (deploy-guard.ts).
// Stale claims still only warn. The user can lift a block by typing `override: <file>` (UserPromptSubmit).
// CAPTAIN_MEMO_WORKBOARD_ENFORCE=0 in the host's settings env turns both guards back into advisories.
//
// Fail-open contract: a worker outage, bad payload, ssh failure or timeout never blocks. workerFetch is bounded and
// never throws, and stdout is written AT MOST ONCE (the host parses a single JSON object): a deny alone, or one merged
// advisory.
import { readStdinJson, workerFetch, writeStdout, resolveProjectId, logHookError, logWorkerFailure, isMainModule, staleNote } from './shared.ts';
import { parseWrittenPaths, isCoarseClaim } from './shell-writes.ts';
import { parseTransfers, remoteKey, checkUploads, SSH_KILL_MS, type Transfer } from './deploy-guard.ts';
import { patchFiles } from './post-tool-use.ts';
import { detectRepoRootSync } from '../worker/branch.ts';
import { globsOverlap } from '../worker/glob-overlap.ts';
import { aiProcessPid } from '../shared/ai-process.ts';
import { resolve, dirname } from 'path';

interface PreToolUsePayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown; command?: unknown } & Record<string, unknown>;
}
interface WorkNote { session_id: string; agent?: string; files?: string[]; what?: string; age_s?: number }
export interface OverlapHit { session_id: string; agent?: string; repo_root?: string; files?: string[]; overlapping?: string[]; what?: string; kind?: 'files' | 'semantic' | 'repo' | 'topics'; similarity?: number; stale?: boolean; age_s?: number; override?: { files: string[]; until: number } }
export interface GuardHolderOut { session_id: string; agent?: string; what?: string; age_s?: number }
interface SetResp { session_id: string; ttl_s: number; overlaps?: OverlapHit[]; deny?: { files: string[]; holders: GuardHolderOut[] }; override?: { files: string[]; holders: GuardHolderOut[] } }
interface ActiveResp { claims?: WorkNote[]; my_override?: { files: string[]; until: number } }

export interface PreToolUseOptions {
  agent?: string;                       // who the claim is from: 'claude' (default), 'codex', 'gemini'
  format?: 'claude' | 'gemini';         // Claude Code and Codex share hookSpecificOutput; Gemini's BeforeTool wants {decision, reason}
  hostTimeoutMs?: number;               // a native CLI kills the hook at this many ms (Codex, Gemini: 5 s); absent = Claude Code (60 s)
}

// Two worker round trips per edit (GET + POST), each bounded here. Budget: 2 x 1.5 s + bun start stays under the 5 s
// Codex and Gemini give the hook; Claude Code allows 60 s. Measured 2026-09-30 (whole hook process, bundle 95 -> 119 KB,
// no worker listening, 2 x 30 runs), p50 before -> after the guards: Edit ~500 -> 533/564 ms, Bash `ls` ~488/520 ->
// 523/536 ms: about +35 ms per call, not yet split into bundle load vs runtime. An upload adds its ssh (see SSH_KILL_MS).
const HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
const MAX_FILES = 25;
const HOST_EXIT_MARGIN_MS = 750;   // same margin as user-prompt-submit's homeworkWaitMs: spawn, stdout write, exit

/** Shells whose commands we parse for writes. Codex calls its shell `Bash` too; Gemini's is run_shell_command. */
const SHELL_TOOLS: Record<string, 'posix' | 'powershell'> = { Bash: 'posix', PowerShell: 'powershell', run_shell_command: 'posix' };

const enforcing = (): boolean => process.env.CAPTAIN_MEMO_WORKBOARD_ENFORCE !== '0';

/** A scratch file (/tmp, /var/tmp, a Claude scratchpad) outside any checkout: shared by nobody on purpose, so never
 *  claimed. Claimed, two sessions writing /tmp/check.php minutes apart would block each other. */
const scratchPath = (p: string): boolean => (/^\/(?:var\/)?tmp\//.test(p) || /\/claude-\d+\//.test(p)) && !detectRepoRootSync(dirname(p));

interface ClaimOpts { agent: string; repo_root?: string; uploads?: Transfer[]; hostTimeoutMs?: number }

/** Publish/refresh this session's claim. Returns a deny text (the ONLY thing then written) or advisories. */
async function publishClaim(sid: string, cwd: string | undefined, touched: string[], o: ClaimOpts): Promise<{ deny?: string; advisories: string[] }> {
  const project = resolveProjectId(cwd);
  const advisories: string[] = [];

  // accumulate this session's recently-touched files so the claim persists across edits (not just the last file)
  let files = [...touched];
  const cur = await workerFetch<ActiveResp>(`/worknote/active?session_id=${encodeURIComponent(sid)}`, { method: 'GET', timeoutMs: HOOK_TIMEOUT_MS });
  const claims = cur.ok ? cur.body?.claims ?? [] : [];
  const mine = claims.find((c) => c.session_id === sid);
  if (mine?.files?.length) files = [...new Set([...mine.files, ...touched])];
  if (files.length > MAX_FILES) files = files.slice(-MAX_FILES);

  // Guard 3, check 2: the server copy of each uploaded file must be one this session knows.
  const uploads = o.uploads ?? [];
  if (uploads.length > 0) {
    const ov = cur.body?.my_override?.files ?? [];
    let killMs = SSH_KILL_MS;
    if (o.hostTimeoutMs !== undefined) killMs = Math.min(SSH_KILL_MS, Math.floor(o.hostTimeoutMs - performance.now() - HOOK_TIMEOUT_MS - HOST_EXIT_MARGIN_MS));   // spawnSync wants an integer
    if (killMs < 500) {
      advisories.push(...uploads.map((u) => `DEPLOY: server copy of ${u.path} could not be checked (no time left in this CLI's hook budget): fetch and diff before uploading. Build a deploy from the LIVE copy plus your change, never from HEAD plus your change.`));
    } else {
      const res = checkUploads(sid, uploads, {
        skip: (key) => globsOverlap([key], ov).length > 0,
        holderOf: (local) => {
          const h = claims.find((c) => c.session_id !== sid && globsOverlap([local], c.files ?? []).length > 0);
          return h ? { local, session_id: h.session_id, ...(h.agent ? { agent: h.agent } : {}), ...(typeof h.age_s === 'number' ? { age_s: h.age_s } : {}) } : undefined;
        },
        killMs,
        ...(cwd ? { cwd } : {}),
      });
      if (res.deny) {
        if (enforcing()) return { deny: res.deny, advisories: [] };
        advisories.push(res.deny);
      }
      advisories.push(...res.nudges);
    }
  }

  // The pid of the AI CLI process this session runs in: the edit guard enforces only claims that carry one (see
  // guardContested). CLAUDE_PID for Claude only: a Codex or Gemini process started from a Claude shell inherits it, so
  // theirs comes from the process tree (off Linux none is found and the claim only warns, as before).
  const pid = o.agent === 'claude' ? Number(process.env.CLAUDE_PID) : aiProcessPid([o.agent]) ?? NaN;
  const set = await workerFetch<SetResp>('/worknote/set', {
    method: 'POST',
    // enrich_from_observations: let the worker swap this generic `what` for the session's latest observation
    // title (its real meaning) so the board reads well AND the semantic overlap pass has true intent to compare.
    // NOTE it is INFERRED, not declared — it can name the wrong thing. The articles tell the agent to state
    // real intent with work_set; this is a file radar, not a substitute for saying what you are doing.
    body: {
      session_id: sid, agent: o.agent, what: `editing ${files.length} file(s) in ${project}`, files, enrich_from_observations: true,
      enforce: enforcing(), touched, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}), ...(o.repo_root ? { repo_root: o.repo_root } : {}),
    },
    timeoutMs: HOOK_TIMEOUT_MS,
  });
  logWorkerFailure('PreToolUse', '/worknote/set', set);
  if (!set.ok || !set.body) return { advisories };   // fail open: no answer, no deny

  if (set.body.deny?.files?.length) return { deny: formatDeny(set.body.deny.files, set.body.deny.holders ?? []), advisories: [] };
  if (set.body.override?.files?.length) {
    advisories.push(`WORK-BOARD OVERRIDE (by the user) in force: writing ${set.body.override.files.join(', ')} held by ${(set.body.override.holders ?? []).map((h) => h.session_id).join(', ')}; the holder sees the override on the work board.`);
  }
  const warn = formatOverlapWarning(set.body.overlaps ?? []);
  if (warn) advisories.push(warn);
  return { advisories };
}

/** The deny text: who holds the file, and that only the user decides (there is no channel to the holder here). */
export function formatDeny(files: string[], holders: GuardHolderOut[]): string {
  const f = files.join(', ');
  const who = holders.map((h) => `${h.session_id}, ${h.agent ?? '?'}, last edit ${Math.round((h.age_s ?? 0) / 60)} min ago: "${(h.what ?? '').slice(0, 80)}"`).join('; ');
  return `WORK-BOARD: BLOCKED. ${f} ${files.length > 1 ? 'are' : 'is'} held by another session on this captain (${who}). Two sessions writing one file is how work gets lost. Do not route around this with another tool or a shell command. Stop and tell the user which session holds it (work_active shows the board); they decide. If they want to overwrite it, they type \`override: ${files[0]}\` as their message.`;
}

/** The overlap advisory, or null. For each peer it names the PEER's own matching paths. The worker's `overlapping` is
 *  the CALLER's side of the match, which the warning used to print under the peer's id (and call every peer "another
 *  captain"), so two sessions on one checkout each looked like they were editing the other's files. Whole-repo claims
 *  never reach here: the worker drops them. A peer whose user typed `override:` says so, since there is no inbox. */
export function formatOverlapWarning(overlaps: OverlapHit[]): string | null {
  if (overlaps.length === 0) return null;
  const lines = overlaps.map((o) => {
    const stale = staleNote(o);
    const who = `another session on this captain (${(o.session_id ?? '').slice(0, 12)}, ${o.agent ?? '?'}${stale ? `; ${stale}` : ''})`;
    const yours = o.overlapping ?? [];
    if (o.kind === 'semantic') {
      return `${who} is working on the same thing by meaning: "${(o.what ?? '').slice(0, 80)}"${typeof o.similarity === 'number' ? ` (~${o.similarity.toFixed(2)})` : ''}`;
    }
    if (o.kind === 'topics') return `${who} holds the same topic: ${yours.join(', ')} ("${(o.what ?? '').slice(0, 80)}")`;
    if (o.kind === 'repo') return `${who} works in the same repository (${yours.join(', ')})`;
    const theirs = globsOverlap(o.files ?? [], yours);
    const note = o.override ? ` (its user typed \`override:\` for ${o.override.files.join(', ')} until ${new Date(o.override.until).toTimeString().slice(0, 5)}: it may write them now, so re-read them before your next write)` : '';
    return `${who} holds ${(theirs.length ? theirs : (o.files ?? [])).join(', ')}, which overlaps your ${yours.join(', ')}${note}`;
  });
  // Stale only means no recent edit (a session that is reading refreshes nothing), so even an all-stale overlap says
  // tell the user first; it just does not read like a live peer. There is no peer channel here, the user decides.
  // No "continue": in a compound shell command this merges with pre-git's advice to isolate a mutating git op.
  const next = overlaps.every((o) => o.stale)
    ? 'Every overlapping claim is stale (no recent edit, not necessarily ended): tell the user which session holds it before writing the same files.'
    : 'Stop and tell the user which session holds it (work_active shows the board); never edit or deploy over another session\'s claim.';
  return `WORK-BOARD OVERLAP: ${lines.join('; ')}. ${next}`;
}

export async function main(opts: PreToolUseOptions = {}): Promise<void> {
  let payload: PreToolUsePayload = {};
  try { payload = await readStdinJson<PreToolUsePayload>(); } catch (err) { logHookError('PreToolUse', err); return; }

  const sid = payload.session_id;
  const cwd = payload.cwd;
  const tool = payload.tool_name ?? '';
  const shell = SHELL_TOOLS[tool];
  const agent = opts.agent ?? 'claude';
  const advisories: string[] = [];
  let deny: string | undefined;
  const abs = (p: string): string => (cwd ? resolve(cwd, p) : p);   // Gemini and Codex hand relative paths

  const claim = async (touched: string[], extra: Omit<ClaimOpts, 'agent'> = {}): Promise<void> => {
    try {
      const r = await publishClaim(sid!, cwd, touched.filter((p) => !scratchPath(p)), { agent, ...extra, ...(opts.hostTimeoutMs !== undefined ? { hostTimeoutMs: opts.hostTimeoutMs } : {}) });
      deny = r.deny;
      advisories.push(...r.advisories);
    } catch (err) { logHookError('PreToolUse', err); }
  };

  if (shell) {
    // 1. shared-checkout advisory (mutating git op on a tree a peer holds)
    try {
      const gitWarn = await (await import('./pre-git.ts')).runPreGit(payload as never);
      if (gitWarn) advisories.push(gitWarn);
    } catch (err) { logHookError('PreToolUse', err); }

    // 2. claim whatever this command WRITES or UPLOADS. Parsing is pure, cheap and happens BEFORE any worker
    //    round-trip, so the overwhelmingly common read-only command (`ls`, `cat`, `grep`, `bun test`)
    //    short-circuits here and costs nothing — Bash fires far more often than the edit tools.
    const cmd = typeof payload.tool_input?.command === 'string' ? payload.tool_input.command : '';
    let written = parseWrittenPaths(cmd, cwd ?? '', shell);
    const transfers: { uploads: Transfer[]; unchecked?: number } = shell === 'posix' ? parseTransfers(cmd, cwd ?? '') : { uploads: [] };
    const uploads = transfers.uploads.filter((u) => !/^\/(?:var\/)?tmp\//.test(u.path));   // a server's /tmp is scratch too
    if (transfers.unchecked) advisories.push(`DEPLOY: ${transfers.unchecked} upload(s) in this command name their file, host or path through a shell expansion the guard cannot resolve ($(...), \$1, a glob), so the server copy was not checked: fetch the live copy and diff before uploading. Build a deploy from the LIVE copy plus your change, never from HEAD plus your change.`);
    let repoRoot: string | undefined;

    // The parser's "I could not name the target" fallback is `<cwd>/**`. That claim named no file, yet it overlapped
    // every file in the repo, and on 2026-09-30 its warnings on nearly every edit taught two sessions to ignore the
    // board. Now it publishes NO file: only a heartbeat with the repo as presence (pre-git and repo contention still
    // see the session). Outside a repo, or in a per-session scratchpad, there is nothing shared: nothing is sent.
    if (cwd && isCoarseClaim(written, cwd)) {
      const root = detectRepoRootSync(cwd);
      written = [];
      if (root && !root.includes('/claude-1000/')) repoRoot = root;
    }
    const upTouched = uploads.flatMap((u) => (u.dir ? [`${u.local}/**`, `${remoteKey(u)}/**`] : [u.local, remoteKey(u)]));
    const touched = [...new Set([...written, ...upTouched])];

    if (sid && (touched.length > 0 || repoRoot)) {
      await claim(touched, { ...(repoRoot ? { repo_root: repoRoot } : {}), ...(uploads.length ? { uploads } : {}) });
    }
  } else {
    const ip = payload.tool_input ?? {};
    let touched: string[] = [];
    if (tool === 'apply_patch') touched = patchFiles(ip).map(abs);
    else {
      const fp = typeof ip.file_path === 'string' ? ip.file_path
        : typeof ip.notebook_path === 'string' ? ip.notebook_path
        : undefined;
      if (fp) touched = [abs(fp)];
    }
    if (!sid || touched.length === 0) return;   // only file-editing tools carry a path; everything else is a no-op
    await claim(touched);
  }

  // ONE emit, one JSON object: a deny alone (nothing merged into it), else the advisories.
  if (deny) {
    writeStdout(JSON.stringify(opts.format === 'gemini' ? { decision: 'deny', reason: deny }
      : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: deny } }));
    return;
  }
  if (advisories.length === 0) return;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: opts.format === 'gemini' ? 'BeforeTool' : 'PreToolUse', additionalContext: advisories.join('\n\n') } }));
}

if (isMainModule(import.meta)) {
  try {
    await main();
  } catch (err) {
    logHookError('PreToolUse', err);
    process.exit(0);
  }
}
