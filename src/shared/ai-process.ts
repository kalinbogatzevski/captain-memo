// Which AI CLI process a hook or MCP server runs under, so a Codex or Gemini work claim carries a pid like Claude's
// CLAUDE_PID. Verified 2026-10-01 on Linux (codex 0.156.1, gemini 0.61.0): both start hooks and MCP servers as direct
// children of the session process. Codex: the native binary (comm `codex`) under its `node .../bin/codex` launcher.
// Gemini: a relaunched `node --max-old-space-size=N .../bin/gemini` (comm `node`) under the first `node .../bin/gemini`.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const MAX_DEPTH = 8;

const name = (arg: string | undefined): string => (arg ? basename(arg).replace(/\.[cm]?js$/, '') : '');

/** The pid of the nearest ancestor, from `start` up, that is one of `agents` (matched on comm, or on the basename of
 *  argv[0] or of the first non-option argument, the script a `node` runs). undefined when none is found within
 *  MAX_DEPTH, or off Linux: no pid is sent and the claim behaves as before. */
export function aiProcessPid(agents: readonly string[], start: number = process.ppid, root = '/proc', platform: string = process.platform): number | undefined {
  if (platform !== 'linux') return undefined;   // ponytail: /proc only; add ps/sysctl walks if macOS claims need a pid
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
