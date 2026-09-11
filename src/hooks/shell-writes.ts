// src/hooks/shell-writes.ts — which files does a shell command WRITE?
//
// PreToolUse's auto-claim only ever fired on a `tool_input.file_path`, i.e. only for Edit/Write/
// MultiEdit/NotebookEdit. But in bypass-permissions mode Claude Code is instructed to make file changes
// with `sed`, heredocs and `>` INSTEAD of those tools — and the Bash branch returned early after the
// git check without ever POSTing a claim. Net effect: a whole session could rewrite the tree while the
// work board showed it idle, so siblings got no overlap warning at all. (PowerShell was worse: it
// matched no PreToolUse hook whatsoever, on a host where it is the primary shell.)
//
// CONTRACT — this runs in front of EVERY Bash/PowerShell call, so it is:
//   pure    — no I/O, no fs, no spawn;
//   total   — never throws, whatever garbage arrives;
//   cheap   — plain scans, no nested quantifiers, no backtracking traps.
// Accuracy target is deliberately asymmetric: over-claiming costs one spurious "you might collide",
// under-claiming costs a silent clobber. When a mutation is clearly happening but its target cannot be
// resolved (a `"$f"` loop variable, say), claim the whole cwd rather than nothing — coarse beats invisible.

import { resolve } from 'path';

/** Cap on claimed paths. A `find … -exec sed -i` fan-out must not flood the board. */
export const MAX_SHELL_FILES = 25;

export type ShellKind = 'posix' | 'powershell';

/** Sinks that are not files. Claiming these would be pure noise. */
const NOT_A_FILE = /^(\/dev\/(null|stdout|stderr|tty)|nul:?|con)$/i;

/** `>file`, `>>file`, `2>file` — but NOT `2>&1` (an fd dup: `&` is excluded from the target class, so
 *  the match simply fails) and not a bare `>` with no target. */
const REDIRECT = /(?:^|[\s;|&])(\d?)(>>?)\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;

/** Flags whose NEXT token is a value, not a path — skipped so we never claim `-Value x`'s `x`. */
const PS_VALUE_FLAGS = new Set(['-value', '-itemtype', '-encoding', '-force', '-pattern', '-filter']);
const PS_PATH_FLAGS = new Set(['-path', '-filepath', '-literalpath', '-destination']);
const PS_WRITE_CMDLETS = new Set([
  'set-content', 'add-content', 'out-file', 'new-item', 'copy-item', 'move-item', 'set-itemproperty',
  'remove-item', 'rename-item', 'clear-content',
]);
/** Move/rename mutate the SOURCE too (it disappears), so both ends get claimed. */
const PS_MOVES = new Set(['move-item', 'rename-item']);

/** Split a segment into tokens, honouring simple quoting. Quotes are stripped from the value. */
function tokenize(seg: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** Command name, ignoring leading `VAR=value` assignments and any directory prefix. */
function cmdName(toks: string[]): { name: string; rest: string[] } {
  let i = 0;
  while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]!)) i++;
  const raw = toks[i] ?? '';
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return { name: base.toLowerCase(), rest: toks.slice(i + 1) };
}

/** Non-flag tokens, skipping the values of flags that take one. */
function positionals(rest: string[], valueFlags: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.startsWith('-')) { if (valueFlags.has(t)) i++; continue; }
    out.push(t);
  }
  return out;
}

/** `sed -i` rewrites its input files in place; `sed` without it is read-only. Without `-e`/`-f` the
 *  FIRST positional is the script and the rest are files; with them, every positional is a file. */
function sedTargets(rest: string[]): string[] {
  const inPlace = rest.some((t) => /^-i/.test(t) || t === '--in-place' || t.startsWith('--in-place='));
  if (!inPlace) return [];
  const scriptFlags = new Set(['-e', '-f', '--expression', '--file']);
  const sawScriptFlag = rest.some((t) => scriptFlags.has(t));
  const pos = positionals(rest, scriptFlags);
  return sawScriptFlag ? pos : pos.slice(1);
}

function psTargets(name: string, rest: string[]): string[] {
  const out: string[] = [];
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]!;
    if (t.startsWith('-')) {
      const f = t.toLowerCase();
      const val = rest[i + 1];
      const takesValue = PS_PATH_FLAGS.has(f) || PS_VALUE_FLAGS.has(f);
      if (PS_PATH_FLAGS.has(f) && val && !val.startsWith('-')) out.push(val);
      if (takesValue && val && !val.startsWith('-')) i++;
      continue;
    }
    pos.push(t);
  }
  // `-Destination` names the target; the leading positional is then the SOURCE — claimed only for a move.
  if (out.length > 0) return PS_MOVES.has(name) ? [...pos, ...out] : out;
  return pos.slice(0, 1);
}

/** Raw write targets named by one command segment, plus whether a mutation was seen at all. */
function segmentTargets(seg: string, shell: ShellKind): { targets: string[]; mutates: boolean } {
  const toks = tokenize(seg);
  if (toks.length === 0) return { targets: [], mutates: false };
  const { name, rest } = cmdName(toks);

  if (shell === 'powershell' && PS_WRITE_CMDLETS.has(name)) {
    return { targets: psTargets(name, rest), mutates: true };
  }

  switch (name) {
    case 'sed': {
      const t = sedTargets(rest);
      const inPlace = rest.some((x) => /^-i/.test(x) || x.startsWith('--in-place'));
      return { targets: t, mutates: inPlace };
    }
    case 'tee':
      return { targets: positionals(rest), mutates: true };
    case 'cp':
    case 'install': {
      const pos = positionals(rest);
      return { targets: pos.slice(-1), mutates: true };   // sources are READ; only the destination is written
    }
    case 'mv':
      return { targets: positionals(rest), mutates: true };   // source disappears → both ends mutate
    case 'dd': {
      const of = rest.find((t) => t.startsWith('of='));
      return { targets: of ? [of.slice(3)] : [], mutates: true };
    }
    case 'truncate':
      return { targets: positionals(rest, new Set(['-s', '--size'])), mutates: true };
    case 'rm':
    case 'shred':
      return { targets: positionals(rest), mutates: true };
    default:
      return { targets: [], mutates: false };
  }
}

/** A token we cannot turn into a real path: shell/PowerShell expansion, or a bare stream. */
function unresolvable(t: string): boolean {
  return t === '' || t === '-' || t.includes('$') || t.includes('`') || t.includes('%');
}

/**
 * Absolute paths (and globs) that `command` will write, resolved against `cwd`.
 *
 * Returns `[]` for read-only commands and when `cwd` is unknown — a relative claim is worse than none,
 * because `resolveRepoClaim` cannot stamp `repo_root` on one, so it would show on the board while
 * silently contributing nothing to shared-checkout contention.
 *
 * Returns `["<cwd>/**"]` when a mutation is unmistakable but its target is not resolvable.
 */
export function parseWrittenPaths(command: string, cwd: string, shell: ShellKind = 'posix'): string[] {
  try {
    if (typeof command !== 'string' || command.trim() === '' || !cwd) return [];

    const raw: string[] = [];
    // A mutation whose target we could not pin down. Kept SEPARATE from "a mutation happened", because
    // `> /dev/null` is a write that touches no file — treating it as unresolved would claim the whole
    // cwd on every `cmd > /dev/null`, which is most of them.
    let unresolved = false;

    for (const seg of command.split(/&&|\|\||;|\||\n/)) {
      const { targets, mutates } = segmentTargets(seg, shell);
      if (mutates && targets.length === 0) unresolved = true;   // e.g. `sed -i` with the file in a variable
      raw.push(...targets);
    }

    REDIRECT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REDIRECT.exec(command)) !== null) {
      const tok = m[3] ?? '';
      // A `>` INSIDE a string (`echo "a > b"`, `grep "x > y" f`) is not a redirect. The tail of such a
      // string lands here with an odd number of quote characters (`b"`), whereas a genuinely quoted
      // target (`> "out file.txt"`) is balanced. Cheaper and safer than masking quoted spans.
      if (((tok.match(/["']/g) ?? []).length % 2) === 1) continue;
      raw.push(tok.replace(/^["']|["']$/g, ''));
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of raw) {
      if (NOT_A_FILE.test(t)) continue;             // not a file at all → nothing to claim, not a miss
      if (unresolvable(t)) { unresolved = true; continue; }   // a real write we cannot name → fall back
      // PowerShell hands back `src\a.ts`; normalise so resolve() treats it as a path on every platform.
      const abs = resolve(cwd, shell === 'powershell' ? t.replace(/\\/g, '/') : t);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
      if (out.length >= MAX_SHELL_FILES) break;
    }

    if (out.length === 0 && unresolved) return [`${cwd}/**`];
    return out;
  } catch {
    return [];   // total by contract: a parse failure must never block or break the edit
  }
}
