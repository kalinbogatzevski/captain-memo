// Which AI CLI process a hook or MCP server runs under, so a Codex or Gemini work claim carries a pid like Claude's
// CLAUDE_PID. Verified 2026-10-01 on Linux (codex 0.156.1, gemini 0.61.0): both start hooks and MCP servers as direct
// children of the session process. Codex: the native binary (comm `codex`) under its `node .../bin/codex` launcher.
// Gemini: a relaunched `node --max-old-space-size=N .../bin/gemini` (comm `node`) under the first `node .../bin/gemini`.
// macOS has no /proc: there the same walk runs over ONE `ps -ax -o pid=,ppid=,args=` snapshot. A `ps -o ppid=,comm=`
// call per ancestor was the first plan, but comm alone never finds Gemini (it runs as `node .../bin/gemini`), and each
// ps call cost 195-228 ms on the Linux host this was measured on (2026-10-01, load 16, 755 processes; the snapshot
// 205-216 ms), so one call beats up to 16. NOT verified on a Mac: the output shape is from the ps manual, and the walk
// is tested on Linux against the real ps and against recorded lines. Windows has neither and sends no pid.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

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

function psWalk(agents: readonly string[], start: number, ps: PsRunner): number | undefined {
  const procs = new Map<number, { ppid: number; argv: string[] }>();
  for (const line of (ps() ?? '').split('\n')) {
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

/** The pid of the nearest ancestor, from `start` up, that is one of `agents` (matched on comm, or on the basename of
 *  argv[0] or of the first non-option argument, the script a `node` runs). undefined when none is found within
 *  MAX_DEPTH, or on a platform with neither /proc nor this ps (Windows): no pid is sent and the claim behaves as before. */
export function aiProcessPid(agents: readonly string[], start: number = process.ppid, root = '/proc', platform: string = process.platform, ps: PsRunner = realPs): number | undefined {
  if (platform === 'darwin') {
    const key = `${agents.join(',')}\0${start}`;
    if (!psCache.has(key)) psCache.set(key, psWalk(agents, start, ps));
    return psCache.get(key);
  }
  if (platform !== 'linux') return undefined;   // ponytail: Windows has no /proc and no such ps; add a WMI walk if its claims need a pid
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
