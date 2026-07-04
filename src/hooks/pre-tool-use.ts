// PreToolUse hook — work-board auto-claim + overlap warning.
//
// Before an Edit/Write/MultiEdit/NotebookEdit, publish THIS session's recently-edited files to the shared
// work board (POST /worknote/set) so other captains can SEE what is being touched, and surface a NON-BLOCKING
// warning when another captain's claim overlaps. This is the active half of fleet coordination: observations
// are passive (after the fact); claims are the radar that stops two captains clobbering the same file.
//
// Fail-open contract (shared.ts): NEVER block an edit. workerFetch is bounded and never throws, every path
// returns cleanly, and the only stdout is an advisory additionalContext note — never a deny. A worker outage,
// bad payload, or timeout is a silent no-op.
import { readStdinJson, workerFetch, writeStdout, resolveProjectId, logHookError, logWorkerFailure } from './shared.ts';

interface PreToolUsePayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; notebook_path?: unknown } & Record<string, unknown>;
}
interface WorkNote { session_id: string; agent?: string; files?: string[]; what?: string }
interface OverlapHit { session_id: string; agent?: string; files?: string[]; overlapping?: string[]; what?: string; kind?: 'files' | 'semantic'; similarity?: number }
interface SetResp { session_id: string; ttl_s: number; overlaps?: OverlapHit[] }
interface ActiveResp { claims?: WorkNote[] }

const HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
const MAX_FILES = 25;

export async function main(): Promise<void> {
  let payload: PreToolUsePayload = {};
  try { payload = await readStdinJson<PreToolUsePayload>(); } catch (err) { logHookError('PreToolUse', err); return; }

  const sid = payload.session_id;
  const ip = payload.tool_input ?? {};
  const fp = typeof ip.file_path === 'string' ? ip.file_path
    : typeof ip.notebook_path === 'string' ? ip.notebook_path
    : undefined;
  if (!sid || !fp) return;   // only file-editing tools carry a path; everything else is a no-op

  const project = resolveProjectId(payload.cwd);

  // accumulate this session's recently-touched files so the claim persists across edits (not just the last file)
  let files: string[] = [fp];
  const cur = await workerFetch<ActiveResp>(`/worknote/active?session_id=${encodeURIComponent(sid)}`, { method: 'GET', timeoutMs: HOOK_TIMEOUT_MS });
  if (cur.ok && cur.body?.claims) {
    const mine = cur.body.claims.find((c) => c.session_id === sid);
    if (mine?.files?.length) {
      files = [...new Set([...mine.files, fp])];
      if (files.length > MAX_FILES) files = files.slice(-MAX_FILES);
    }
  }

  const set = await workerFetch<SetResp>('/worknote/set', {
    method: 'POST',
    // enrich_from_observations: let the worker swap this generic `what` for the session's latest observation
    // title (its real meaning) so the board reads well AND the semantic overlap pass has true intent to compare.
    body: { session_id: sid, agent: 'claude', what: `editing ${files.length} file(s) in ${project}`, files, enrich_from_observations: true },
    timeoutMs: HOOK_TIMEOUT_MS,
  });
  logWorkerFailure('PreToolUse', '/worknote/set', set);
  if (!set.ok || !set.body) return;

  const overlaps = set.body.overlaps ?? [];
  if (overlaps.length === 0) return;

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
  const warning = `WORK-BOARD OVERLAP: another captain is ${parts.join('; and is ')}. Check the captain-memo work board (work_active) and coordinate, or pick a different area, before continuing.`;

  // advisory only — inject context, NEVER deny the edit
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } }));
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('PreToolUse', err);
    process.exit(0);
  });
}
