// Which AI CLI process a hook or MCP server runs under, so a Codex or Gemini work claim carries a pid like Claude's
// CLAUDE_PID. Verified 2026-10-01 on Linux (codex 0.156.1, gemini 0.61.0): both start hooks and MCP servers as direct
// children of the session process. Codex: the native binary (comm `codex`) under its `node .../bin/codex` launcher.
// Gemini: a relaunched `node --max-old-space-size=N .../bin/gemini` (comm `node`) under the first `node .../bin/gemini`.
// macOS has no /proc: there the same walk runs over ONE `ps -ax -o pid=,ppid=,args=` snapshot. A `ps -o ppid=,comm=`
// call per ancestor was the first plan, but comm alone never finds Gemini (it runs as `node .../bin/gemini`), and each
// ps call cost 195-228 ms on the Linux host this was measured on (2026-10-01, load 16, 755 processes; the snapshot
// 205-216 ms), so one call beats up to 16. NOT verified on a Mac: the output shape is from the ps manual, and the walk
// is tested on Linux against the real ps and against recorded lines.
// Windows has neither: there the walk runs over one Toolhelp32 process snapshot (pid, parent pid, image name), read
// through bun:ffi from kernel32, so no PowerShell or wmic starts on every hook. Verified 2026-11-21 on Windows 11 x64
// (codex-cli npm package): the MCP server and the hook run under the native `codex.exe`, itself under the
// `node.exe .../codex.js` launcher. A snapshot has no command lines, so a node-run CLI (Gemini) is not found there and
// its claims carry no pid, as before.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { dlopen, FFIType } from 'bun:ffi';

const MAX_DEPTH = 8;
const PS_TIMEOUT_MS = 1_000;

/** The `ps -ax -o pid=,ppid=,args=` text, or null when ps fails or times out. Injected in tests. */
export type PsRunner = () => string | null;
const realPs: PsRunner = () => {
  try {
    const r = spawnSync('ps', ['-ax', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch { return null; }
};

// One snapshot per process and question: the hook is one process per tool call, and the MCP server asks on every
// claim while the answer (its own ancestor) cannot change.
const psCache = new Map<string, number | undefined>();

function psWalk(agents: readonly string[], start: number, snapshot: string): number | undefined {
  const procs = new Map<number, { ppid: number; argv: string[] }>();
  for (const line of snapshot.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    // ponytail: arguments split on spaces, so an executable or script path that holds a space is not matched
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), argv: m[3]!.trim().split(/\s+/) });
  }
  let pid = start;
  for (let i = 0; i < MAX_DEPTH && pid > 1; i++) {
    const p = procs.get(pid);
    if (!p) return undefined;
    const script = p.argv.slice(1).find((a) => !a.startsWith('-'));
    if (agents.some((a) => name(p.argv[0]) === a || name(script) === a)) return pid;
    pid = p.ppid;
  }
  return undefined;
}

const name = (arg: string | undefined): string => (arg ? basename(arg).replace(/\.[cm]?js$/, '') : '');

/** One Windows process: its parent and image name (`codex.exe`). */
export interface WinProc { pid: number; ppid: number; exe: string }
/** The machine's processes, or null when the snapshot fails. Injected in tests. */
export type WinSnapshotRunner = () => WinProc[] | null;

const TH32CS_SNAPPROCESS = 0x2;
// PROCESSENTRY32W on x64: dwSize@0, th32ProcessID@8, th32ParentProcessID@32, szExeFile@44 (WCHAR[260]); 568 bytes.
const PE32W_SIZE = 568, PE32W_PID = 8, PE32W_PPID = 32, PE32W_EXE = 44, MAX_PATH = 260;

const realWinSnapshot: WinSnapshotRunner = () => {
  try {
    const k32 = dlopen('kernel32.dll', {
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.ptr },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
    });
    try {
      const snap = k32.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
      if (!snap || Number(snap) === -1) return null;   // INVALID_HANDLE_VALUE
      try {
        const entry = new Uint8Array(PE32W_SIZE);
        const view = new DataView(entry.buffer);
        view.setUint32(0, PE32W_SIZE, true);
        const out: WinProc[] = [];
        for (let ok = k32.symbols.Process32FirstW(snap, entry); ok; ok = k32.symbols.Process32NextW(snap, entry)) {
          let exe = '';
          for (let i = 0; i < MAX_PATH; i++) {
            const c = view.getUint16(PE32W_EXE + i * 2, true);
            if (c === 0) break;
            exe += String.fromCharCode(c);
          }
          out.push({ pid: view.getUint32(PE32W_PID, true), ppid: view.getUint32(PE32W_PPID, true), exe });
        }
        return out.length ? out : null;
      } finally { k32.symbols.CloseHandle(snap); }
    } finally { k32.close(); }
  } catch { return null; }
};

function winWalk(agents: readonly string[], start: number, procs: WinProc[]): number | undefined {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  let pid = start;
  for (let i = 0; i < MAX_DEPTH && pid > 0; i++) {
    const p = byPid.get(pid);
    if (!p) return undefined;
    const image = p.exe.replace(/\.exe$/i, '').toLowerCase();
    if (agents.some((a) => image === a.toLowerCase())) return pid;
    if (p.ppid === pid) return undefined;
    pid = p.ppid;
  }
  return undefined;
}

/** The pid of the nearest ancestor, from `start` up, that is one of `agents` (matched on comm, or on the basename of
 *  argv[0] or of the first non-option argument, the script a `node` runs). undefined when none is found within
 *  MAX_DEPTH, or when the process list cannot be read: no pid is sent and the claim behaves as before. On Windows the
 *  match is on the image name only (`codex.exe` → `codex`). */
export function aiProcessPid(agents: readonly string[], start: number = process.ppid, root = '/proc', platform: string = process.platform, ps: PsRunner = realPs, win: WinSnapshotRunner = realWinSnapshot): number | undefined {
  if (platform === 'win32') {
    const key = `win\0${agents.join(',')}\0${start}`;
    if (!psCache.has(key)) {
      const snapshot = win();
      if (snapshot === null) return undefined;   // a failed snapshot is not cached: the next claim asks again
      psCache.set(key, winWalk(agents, start, snapshot));
    }
    return psCache.get(key);
  }
  if (platform === 'darwin') {
    const key = `${agents.join(',')}\0${start}`;
    if (!psCache.has(key)) {
      const snapshot = ps();
      if (snapshot === null) return undefined;   // a failed ps is not cached: the next claim asks again
      psCache.set(key, psWalk(agents, start, snapshot));
    }
    return psCache.get(key);
  }
  if (platform !== 'linux') return undefined;
  let pid = start;
  for (let i = 0; i < MAX_DEPTH && pid > 1; i++) {
    try {
      const comm = readFileSync(`${root}/${pid}/comm`, 'utf8').trim();
      const argv = readFileSync(`${root}/${pid}/cmdline`, 'utf8').split('\0');
      const script = argv.slice(1).find((a) => a !== '' && !a.startsWith('-'));
      if (agents.some((a) => comm === a || name(argv[0]) === a || name(script) === a)) return pid;
      const stat = readFileSync(`${root}/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);   // comm may hold spaces or ')': read after the last ')'
    } catch { return undefined; }
  }
  return undefined;
}
