// src/hooks/deploy-guard.ts — guard 3: uploads (scp, rsync, `ssh host 'cat > p' < local`).
//
// 2026-09-30: two sessions in one checkout each built a deploy as "git HEAD + my hunk" and scp'd it over the other's
// uncommitted work on the server (a production page went to a PHP fatal). The server copy then held
// another session's work: its md5 matched no committed tip, not the uploader's file, and nothing the uploader had
// fetched. So before an upload the PreToolUse hook reads the server copy's md5 (one ssh per host) and refuses when it
// is none of those. A session repeating its own edit-deploy-verify loop matches its own last upload and goes through.
//
// Parsing is pure (reuses shell-writes' tokenizer and segment split). The checks spawn ssh and git; every failure
// fails OPEN (the upload goes through with a nudge that it could not be checked).

import { resolve, basename, dirname, join, relative } from 'path';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { splitSegments, tokenize, cmdName } from './shell-writes.ts';
import { DATA_DIR } from '../shared/paths.ts';
import { detectRepoRootSync } from '../worker/branch.ts';

export interface Transfer {
  local: string;        // absolute local path
  userhost: string;     // as the command spells it (ssh auth depends on it: a bare host failed where root@host worked)
  path: string;         // remote path as written (relative = the remote home)
  sshArgs: string[];    // port / identity / options to reach the same host
  dir?: boolean;        // a directory transfer: claimed as path/**, never md5-checked
  orDir?: boolean;      // scp/rsync of one file to a path with no trailing slash: when that path is a directory on the
                        // server the file lands at path/<basename>, which the check finds out (remoteMd5s)
}

/** `user@host:path` or `host:path`. A single letter before `:` is a Windows drive, so that stays local. */
function remoteSpec(t: string): { userhost: string; path: string } | null {
  const m = /^((?:[^@\s:/]+@)?[^@\s:/]+):(.*)$/.exec(t);
  if (!m || /^[A-Za-z]$/.test(m[1]!)) return null;
  return { userhost: m[1]!, path: m[2]! };
}

const SCP_VALUE_FLAGS = new Set(['-P', '-i', '-o', '-F', '-J', '-c', '-l', '-S']);
const RSYNC_VALUE_FLAGS = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--chmod', '--chown', '--port', '--rsync-path',
  '--log-file', '--password-file', '--files-from', '--exclude-from', '--include-from', '-T', '--temp-dir', '--partial-dir', '--backup-dir',
  '--suffix', '--timeout', '--bwlimit', '-B', '--block-size', '--compare-dest', '--link-dest', '--copy-dest']);
const SSH_VALUE_FLAGS = new Set(['-p', '-i', '-o', '-J', '-F', '-l', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B']);
const SSH_PASS = new Set(['-p', '-i', '-o', '-J', '-F', '-l']);

/** `~/x` as the shell would expand it: ssh and our resolve() get no shell. */
const tilde = (p: string): string => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

/** ssh options that reach the same host, from an ssh-style token list. */
function sshPassArgs(toks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (SSH_PASS.has(toks[i]!) && toks[i + 1] !== undefined) { out.push(toks[i]!, tilde(toks[i + 1]!)); i++; }
  }
  return out;
}

const defaultIsDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };

const VAR_REF = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;

const POS_REF = /\$\{([1-9])\}|\$([1-9])/g;
const MAX_BINDINGS = 25;    // nested loops multiply: past this a loop variable stays unresolved (counted as unchecked)
const MAX_EXPANSIONS = 20;  // function calls expanded per command: bounds a function that calls itself

/** One binding per combination of the values of the multi-valued (loop) variables a segment names: nested loops give
 *  their product, up to MAX_BINDINGS. */
function bindingsFor(seg: string, vars: Map<string, string[]>): Map<string, string>[] {
  let out = [new Map<string, string>()];
  for (const n of new Set([...seg.matchAll(VAR_REF)].map((m) => (m[1] ?? m[2])!))) {
    const v = vars.get(n);
    if (!v?.length || out.length * v.length > MAX_BINDINGS) continue;
    out = out.flatMap((b) => v.map((x) => new Map([...b, [n, x]])));
  }
  return out;
}
const substitute = (t: string, b: Map<string, string>): string => t.replace(VAR_REF, (m, a: string | undefined, c: string | undefined) => b.get((a ?? c)!) ?? m);

/** Uploads and downloads a shell command performs over scp, rsync or ssh. `isDir` is injected for tests. sftp is skipped
 *  (its batch files are not cheap to parse). */
export function parseTransfers(command: string, cwd: string, isDir: (p: string) => boolean = defaultIsDir): { uploads: Transfer[]; downloads: Transfer[]; unchecked?: number } {
  const uploads: Transfer[] = [], downloads: Transfer[] = [];
  let unchecked = 0;   // uploads whose source, host or path stayed in a variable: reported, never guessed
  // Same-line shell variables: every deploy on 2026-09-30 spelled its paths as `S=…; R=…; scp $S/x root@$box:$R/$F`,
  // often inside `for box in h1 h2; do`, so a literal-only parser saw none of them. ponytail: literal values only;
  // `$(…)`, `${x%%…}`, `$@` and quoting rules stay unresolved and count as unchecked.
  const vars = new Map<string, string[]>();
  // A function body is kept as text and run where it is CALLED, with $1..$9 replaced by the call's words: the
  // definition alone uploads nothing.
  const funcs = new Map<string, string>();
  const loops: (string | null)[] = [];   // open loops, innermost last; null = a loop with no variable we track
  let expansions = 0;
  const assign = (n: string, v: string[]): void => { if (v.some((x) => x.includes('$') || x.includes('`'))) vars.delete(n); else vars.set(n, v); };
  try {
    if (typeof command !== 'string' || !cwd || !/\b(scp|rsync|ssh)\b/.test(command)) return { uploads, downloads };
    const segs = splitSegments(command, cwd);
    for (let si = 0; si < segs.length; si++) {
      const { seg, masked, dir, piped } = segs[si]!;
      // quotes the tokenizer leaves inside a token (`root@$h:"$R/$f"`, `S="/x"`) are shell syntax, not path characters
      const toks0 = tokenize(seg).map((t) => t.replace(/["']/g, ''));
      // `put() { scp …; }` / `function put { …; }`: keep the body, up to the segment that closes the brace
      const def = /^\s*(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/.exec(seg);
      if (def) {
        const body = [seg.slice(def[0].length)];
        let depth = 1;
        while (++si < segs.length) {
          const s = segs[si]!;
          const first = s.seg.trim()[0];
          if (first === '{') depth++;
          else if (first === '}' && --depth === 0) break;
          body.push((s.piped ? '| ' : '\n') + s.seg);
        }
        funcs.set((def[1] ?? def[2])!.toLowerCase(), body.join(''));
        continue;
      }
      if (toks0[0] === '{') toks0.shift();
      if (toks0[0] === '<') toks0.splice(0, 2); else if (/^<[^<]/.test(toks0[0] ?? '')) toks0.shift();   // `< f ssh h 'cat > p'`
      const head = cmdName(toks0);
      const fn = funcs.get(head.name);
      if (fn !== undefined && expansions++ < MAX_EXPANSIONS) {
        const text = fn.replace(POS_REF, (m, a: string | undefined, c: string | undefined) => head.rest[Number(a ?? c) - 1] ?? m);
        segs.splice(si + 1, 0, ...splitSegments(text, dir ?? cwd).map((s) => (dir === null ? { ...s, dir: null } : s)));
        continue;
      }
      // Loop variables end with their loop: after `done` the variable holds its last value, so two loops in a row are
      // never read as one nested in the other.
      if (head.name === 'while' || head.name === 'until' || head.name === 'select') loops.push(null);
      if (head.name === 'done') { const n = loops.pop(); const v = n ? vars.get(n) : undefined; if (n && v?.length) vars.set(n, v.slice(-1)); continue; }
      if (head.name === '' || head.name === 'export' || head.name === 'local') {
        // An assignment naming a loop variable has one value per iteration: left unresolved (unchecked), never pinned
        // to the first iteration, which paired one file with another's server path.
        for (const t of toks0) {
          const a = /^([A-Za-z_]\w*)=(.*)$/s.exec(t);
          if (!a) continue;
          const bs = bindingsFor(a[2]!, vars);
          if (bs.length > 1) vars.delete(a[1]!); else assign(a[1]!, [substitute(a[2]!, bs[0]!)]);
        }
        continue;
      }
      if (head.name === 'for') loops.push(head.rest[1] === 'in' ? head.rest[0]! : null);
      if (head.name === 'for' && head.rest[1] === 'in') {
        assign(head.rest[0]!, head.rest.slice(2).flatMap((w) => bindingsFor(w, vars).flatMap((b) => substitute(w, b).split(/\s+/).filter(Boolean))));
        continue;
      }
      if (dir === null || !['scp', 'rsync', 'ssh'].includes(head.name)) continue;
      for (const b of bindingsFor(seg, vars)) {
        const sub = (t: string): string => substitute(t, b);
        const { name, rest } = cmdName(toks0.map(sub));
        if (name === 'scp' || name === 'rsync') {
          const valueFlags = name === 'scp' ? SCP_VALUE_FLAGS : RSYNC_VALUE_FLAGS;
          const pos: string[] = [];
          let recursive = false;
          let sshArgs: string[] = [];
          for (let i = 0; i < rest.length; i++) {
            const t = rest[i]!;
            if (t.startsWith('--') && t.includes('=')) {
              if (name === 'rsync' && t.startsWith('--rsh=')) sshArgs = sshPassArgs(tokenize(t.slice(6)).slice(1));
              continue;
            }
            if (t.startsWith('-') && t.length > 1) {
              if (name === 'scp' && /^-[a-zA-Z0-9]*r/.test(t) && !valueFlags.has(t)) recursive = true;
              if (name === 'rsync' && (/^-[a-zA-Z]*[ar]/.test(t) && !t.startsWith('--') || t === '--recursive' || t === '--archive')) recursive = true;
              if (valueFlags.has(t)) {
                const v = rest[i + 1] ?? '';
                if (name === 'scp' && t === '-P') sshArgs.push('-p', v);
                else if (name === 'scp' && (t === '-i' || t === '-o' || t === '-J')) sshArgs.push(t, tilde(v));
                else if (name === 'rsync' && (t === '-e' || t === '--rsh')) sshArgs = sshPassArgs(tokenize(v).slice(1));
                i++;
              }
              continue;
            }
            pos.push(t);
          }
          if (pos.length < 2) continue;
          const destTok = pos[pos.length - 1]!;
          const sources = pos.slice(0, -1);
          const dest = remoteSpec(destTok);
          if (dest) {
            for (const src of sources) {
              if (remoteSpec(src)) continue;
              if (/[$*?{]/.test(src) || destTok.includes('$')) { unchecked++; continue; }
              const local = resolve(dir, tilde(src));
              const isDirSrc = recursive && (isDir(local) || src.endsWith('/'));
              const intoDir = destTok.endsWith('/') || sources.length > 1 || dest.path === '' || (name === 'rsync' && isDirSrc && !src.endsWith('/'));
              let path = intoDir ? (dest.path === '' ? basename(local) : `${dest.path.replace(/\/+$/, '')}/${basename(local)}`) : dest.path;
              if (name === 'rsync' && isDirSrc && src.endsWith('/')) path = dest.path.replace(/\/+$/, '');
              uploads.push({ local, userhost: dest.userhost, path, sshArgs: [...sshArgs], ...(isDirSrc ? { dir: true } : !intoDir ? { orDir: true } : {}) });
            }
          } else if (!destTok.includes('$')) {
            for (const src of sources) {
              const r = remoteSpec(src);
              if (!r || !r.path || r.path.includes('*') || src.includes('$')) continue;
              const destAbs = resolve(dir, tilde(destTok));
              const local = destTok.endsWith('/') || destTok === '.' || isDir(destAbs) ? join(destAbs, basename(r.path)) : destAbs;
              downloads.push({ local, userhost: r.userhost, path: r.path, sshArgs: [...sshArgs] });
            }
          }
          continue;
        }
        if (name === 'ssh') {
          const pos: string[] = [];
          const opts: string[] = [];
          let i = 0;
          for (; i < rest.length; i++) {
            const t = rest[i]!;
            if (t.startsWith('-') && pos.length === 0) {
              if (SSH_VALUE_FLAGS.has(t)) { opts.push(t, rest[i + 1] ?? ''); i++; }
              continue;
            }
            pos.push(t);
          }
          if (pos.length < 2) continue;
          const userhost = pos[0]!;
          // the remote command is every positional after the host, up to the first local redirect
          const stop = pos.findIndex((t, k) => k > 0 && /^[<>]|^\d>/.test(t));
          const remoteCmd = pos.slice(1, stop < 0 ? undefined : stop).join(' ');
          const sshArgs = sshPassArgs(opts);
          // `< local` outside the quoted remote command (quoted spans are blanked in `masked`, same length as `seg`)
          const inRedirect = /(?:^|[^<])<(?!<)\s*/.exec(masked);
          const up = /\bcat\s*>\s*([^\s;|&'"]+)|\btee\s+([^\s;|&'"]+)/.exec(remoteCmd);
          if (up && inRedirect) {
            const src = sub(tokenize(seg.slice(inRedirect.index + inRedirect[0].length))[0] ?? '');
            const path = (up[1] ?? up[2])!;
            if (src.includes('$') || path.includes('$') || userhost.includes('$')) unchecked++;
            else if (src) uploads.push({ local: resolve(dir, tilde(src)), userhost, path, sshArgs });
            continue;
          }
          // `cat f | ssh h 'cat > p'`: the file is the one the `cat` before the pipe names; any other producer is unchecked
          if (up && piped) {
            const prev = segs[si - 1]!;
            const cat = cmdName(tokenize(prev.seg).map((t) => sub(t.replace(/["']/g, ''))));
            // one plain file only: `cat <<EOF`, `cat < f` and `cat -n f` are other producers
            const src = cat.name === 'cat' && cat.rest.length === 1 && !/^-|[<>]/.test(cat.rest[0]!) ? cat.rest[0]! : '$';
            const path = (up[1] ?? up[2])!;
            if (/[$*?{]/.test(src) || path.includes('$') || userhost.includes('$') || prev.dir === null) unchecked++;
            else uploads.push({ local: resolve(prev.dir, tilde(src)), userhost, path, sshArgs });
            continue;
          }
          const down = /^\s*cat\s+([^\s;|&<>'"]+)\s*$/.exec(remoteCmd);
          const outRedirect = /(?:^|[^0-9>&])>(?!>)\s*/.exec(masked);
          if (down && outRedirect) {
            const tok = sub(tokenize(seg.slice(outRedirect.index + outRedirect[0].length))[0] ?? '');
            if (tok && !tok.includes('$')) downloads.push({ local: resolve(dir, tilde(tok)), userhost, path: down[1]!, sshArgs });
          }
        }
      }
    }
  } catch { /* total: a parse failure never blocks */ }
  // `put f.deploytmp && ssh mv -f f.deploytmp f`: the file the deploy replaces is f, so f is what is checked and claimed.
  if (/\bmv\b/.test(command)) for (const u of uploads) u.path = u.path.replace(/\.(deploytmp|tmp|new)$/, '');
  return { uploads, downloads, ...(unchecked ? { unchecked } : {}) };
}

/** `userhost:path`, the key a remote target is claimed and baselined under. */
export const remoteKey = (t: Pick<Transfer, 'userhost' | 'path'>): string => `${t.userhost}:${t.path}`;

// ── Check 2: is the server copy one we know? ───────────────────────────────────────────────────────────────────

/** Deny when the server copy matches nothing known. The approved spec only blocked an upload whose LOCAL source another
 *  session holds live; this goes further (pending the maintainer's decision, 2026-09-30) because the 18:22 overwrite happened while
 *  the holder was deploying, not editing, so its claim was probably stale. false = the mismatch only nudges. */
export const DEPLOY_DENY_ON_UNKNOWN_SERVER_COPY = true;

export type ServerCopy = { kind: 'md5'; md5: string } | { kind: 'absent' } | { kind: 'error'; reason: string };
export type DeployVerdict = { allow: true; note: string } | { allow: false; md5: string };

/** Pure decision. `known` maps an md5 to how we know it ("HEAD", "your last upload", ...). */
export function decideDeploy(server: ServerCopy, known: Map<string, string>): DeployVerdict {
  if (server.kind === 'absent') return { allow: true, note: 'is new' };
  if (server.kind === 'error') return { allow: true, note: `could not be checked (${server.reason}): fetch and diff before uploading` };
  const how = known.get(server.md5);
  if (how) return { allow: true, note: `matched ${how}` };
  return DEPLOY_DENY_ON_UNKNOWN_SERVER_COPY ? { allow: false, md5: server.md5 }
    : { allow: true, note: 'matches nothing you know (not HEAD, not your file, not a copy you fetched): fetch and diff before uploading' };
}

export function denyDeployText(t: Transfer, md5: string, holder?: { local: string; session_id: string; agent?: string; age_s?: number }): string {
  const k = remoteKey(t);
  const board = holder ? `; the board last saw ${holder.local} held by ${holder.session_id} (${holder.agent ?? '?'}, ${Math.round((holder.age_s ?? 0) / 60)} min ago)` : '';
  return `DEPLOY BLOCKED: ${k} on the server (md5 ${md5.slice(0, 8)}) is not your file, not a committed version (HEAD, the last ${COMMITTED_DEPTH} commits or the default branch), and not a copy you fetched or uploaded in this session. Someone deployed uncommitted work there${board}. Uploading now erases it. Instead: 1) scp ${t.sshArgs.includes('-p') ? `-P ${t.sshArgs[t.sshArgs.indexOf('-p') + 1]} ` : ''}${k} <your scratchpad>/${basename(t.path)}.live  2) apply your change onto that LIVE copy  3) upload the merged file (the guard allows an upload whose server copy matches what you fetched). Do not bypass this with another command. If the user explicitly wants to overwrite, they type \`override: ${k}\`.`;
}

export function deployNudge(t: Transfer, note: string): string {
  return `DEPLOY: server copy of ${t.path} ${note}. Build a deploy from the LIVE copy plus your change, never from HEAD plus your change.`;
}

/** `<32hex>  <path>` lines, as md5sum prints them. */
export function parseMd5sumLines(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const x = /^\\?([0-9a-f]{32})\s+\*?(.+)$/.exec(line.trim());
    if (x) m.set(x[2]!, x[1]!);
  }
  return m;
}

export const md5Of = (buf: Buffer | string): string => createHash('md5').update(buf).digest('hex');

const MAX_HASH_BYTES = 5 * 1024 * 1024;
export function localMd5(p: string): string | null {
  try { const st = statSync(p); if (!st.isFile() || st.size > MAX_HASH_BYTES) return null; return md5Of(readFileSync(p)); } catch { return null; }
}

// Whole upload check without the network (git cat-file + repo root + a failing ssh spawn): +115 ms p50 on the hook
// (608 vs 493 ms, 50 runs, 2026-09-30).
// ssh: measured 2026-09-30 from this host, warm, `ssh -o BatchMode=yes <user@host> md5sum <file>` to two
// production hosts: 428-431 ms and 479-605 ms. 3 s kill leaves room for a cold connect; ConnectTimeout 2 s bounds a dead host.
export const SSH_KILL_MS = 3_000;
const DIR_MARK = 'cm-is-dir ';

/** Server md5 per path for one host, in one ssh. Exit 255 (or a kill) is an ssh failure; any other exit with a path's
 *  line missing means that path is absent (or a directory). `probeDirs` are paths that may be directories on the server
 *  (`scp f host:/dir`): the same ssh runs `test -d` on each and a directory's answer carries `dir`. No `test -d` answer
 *  (another shell, an error) leaves the path read as written. The round trip count is unchanged (one per host).
 *  Measured 2026-10-01 against a local stand-in ssh on a loaded host, 100 runs, two paths of 200 KB: 27 ms without
 *  the probe, 30-33 ms with it at best (p50 32-40 ms against 36-51 ms), the difference being one more file hashed. */
export function remoteMd5s(userhost: string, sshArgs: string[], paths: string[], killMs: number = SSH_KILL_MS, probeDirs: string[] = []): Map<string, ServerCopy & { dir?: true }> {
  const out = new Map<string, ServerCopy & { dir?: true }>();
  const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
  // plain `;` and `&&` only, so the line also runs under a csh or fish login shell
  const cmd = `md5sum -- ${paths.map(q).join(' ')}${probeDirs.map((p) => `; test -d ${q(p)} && echo ${q(`${DIR_MARK}${p}`)}`).join('')}`;
  try {
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', ...sshArgs, userhost, cmd], { encoding: 'utf-8', timeout: killMs });
    if (r.error || r.status === null || r.status === 255) {
      const reason = r.error ? ((r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'ssh timed out' : r.error.message) : `ssh failed: ${(r.stderr ?? '').trim().split('\n').pop() ?? ''}`.slice(0, 120);
      for (const p of paths) out.set(p, { kind: 'error', reason });
      return out;
    }
    const lines = parseMd5sumLines(r.stdout ?? '');
    const dirs = new Set(String(r.stdout ?? '').split(/\r?\n/).filter((l) => l.startsWith(DIR_MARK)).map((l) => l.slice(DIR_MARK.length)));
    for (const p of paths) { const m = lines.get(p); out.set(p, { ...(m ? { kind: 'md5' as const, md5: m } : { kind: 'absent' as const }), ...(dirs.has(p) ? { dir: true as const } : {}) }); }
  } catch (e) { for (const p of paths) out.set(p, { kind: 'error', reason: (e as Error).message.slice(0, 120) }); }
  return out;
}

/** How many ancestors of HEAD count as committed versions (HEAD~1..N), next to HEAD and the default branch tip.
 *  ponytail: first-parent ancestors; `git log -- <file>` would find older versions but costs ~400 ms. The cost is one
 *  `git cat-file --batch` per uploaded file and grows with the depth and the file size, since every ref's blob is read.
 *  Measured 2026-10-01, 10 runs each, in this repo (1,412 commits): a 220 KB file 20 ms at depth 0, 51 ms at 9, 84 ms
 *  at 20, 118 ms at 30, 201 ms at 50; a 451 KB file 27 / 86 / 152 / 223 / 321 ms. A command checks up to 5 files and a
 *  Codex or Gemini hook has 5 s in all, 3 s of it for ssh, so 9 stays: 5 large files cost under half a second. */
export const COMMITTED_DEPTH = 9;

/** md5 of the committed versions of `file`: HEAD and the default branch, local and origin, in ONE `git cat-file --batch`
 *  (~18 ms measured in a large PHP repo; `git log --all -- <file>` was ~400 ms). Names that do not exist print "missing". */
export function committedMd5s(file: string, remotePath?: string, cwd?: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    let root = detectRepoRootSync(dirname(file));
    let rel = root ? relative(root, file).split('\\').join('/') : '..';
    if (rel.startsWith('..') && remotePath && cwd) {
      // A deploy file built outside the repo (both sessions built theirs in a scratchpad on 2026-09-30): its committed
      // versions are those of the repo file the remote path ends with (the longest suffix that exists in cwd's repo).
      root = detectRepoRootSync(cwd);
      const parts = remotePath.split('/').filter(Boolean);
      const i = root ? parts.findIndex((_, k) => existsSync(join(root!, ...parts.slice(k)))) : -1;
      rel = i >= 0 ? parts.slice(i).join('/') : '..';
    }
    if (!root || rel.startsWith('..')) return out;
    // Plus the file as of the last COMMITTED_DEPTH commits: "commit, then deploy" leaves the server on the file's
    // PREVIOUS committed version, which is safe to replace; without these every such deploy was refused as "someone's
    // uncommitted work". The default branch tip is read under every name it usually has (origin/HEAD is the real one
    // after a clone), so a session on a feature branch may replace what the default branch deployed.
    const refs: [string, string][] = [['HEAD', 'HEAD'], ['master', 'the default branch'], ['main', 'the default branch'], ['origin/HEAD', 'the default branch'], ['origin/master', 'the default branch'], ['origin/main', 'the default branch'],
      ...Array.from({ length: COMMITTED_DEPTH }, (_, k): [string, string] => [`HEAD~${k + 1}`, 'a recent commit'])];
    const r = spawnSync('git', ['-C', root, 'cat-file', '--batch'], { input: refs.map(([ref]) => `${ref}:${rel}`).join('\n') + '\n', timeout: 2_000, maxBuffer: 64 * 1024 * 1024 });
    const buf = r.stdout as unknown as Buffer;
    if (!buf || r.status !== 0) return out;
    let off = 0;
    for (const [, how] of refs) {
      const nl = buf.indexOf(10, off);
      if (nl < 0) break;
      const header = buf.subarray(off, nl).toString();
      off = nl + 1;
      const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
      if (!m) continue;   // "<name> missing"
      const size = Number(m[1]);
      const md5 = md5Of(buf.subarray(off, off + size));
      off += size + 1;
      if (!out.has(md5)) out.set(md5, how);
    }
  } catch { /* no committed versions known */ }
  return out;
}

// ── Baselines: md5s this session uploaded or fetched, per remote target. Hook-local, never over the network. ──────
type Baselines = Record<string, { md5: string; how: 'upload' | 'fetch' }[]>;
const baseFile = (sid: string): string => join(process.env.CAPTAIN_MEMO_DATA_DIR ?? DATA_DIR, 'deploy-base', `${sid.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);

export function readBaselines(sid: string): Baselines {
  try { return JSON.parse(readFileSync(baseFile(sid), 'utf-8')) as Baselines; } catch { return {}; }
}

/** Remember an md5 for a remote target (last 5 kept). ponytail: baseline files are never pruned (a few bytes each). */
export function recordBaseline(sid: string, key: string, md5: string, how: 'upload' | 'fetch'): void {
  try {
    const b = readBaselines(sid);
    b[key] = [...(b[key] ?? []).filter((e) => e.md5 !== md5), { md5, how }].slice(-5);
    const f = baseFile(sid);
    if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(b));
  } catch { /* a lost baseline only means a later upload asks for a fetch */ }
}

const MAX_CHECKED = 5;

/** Check 2 for a command's file uploads (up to 5), skipping targets `skip` covers (the user's override). Returns the
 *  first deny text, or the nudges for every allowed upload. Records each allowed upload's md5 as a baseline. An upload
 *  whose path turned out to be a directory on the server gets its `path` rewritten to the file inside it. */
export function checkUploads(sid: string, uploads: Transfer[], opts: { skip?: (key: string) => boolean; holderOf?: (local: string) => { local: string; session_id: string; agent?: string; age_s?: number } | undefined; killMs?: number; cwd?: string } = {}): { deny?: string; nudges: string[] } {
  const files = uploads.filter((u) => !u.dir && !(opts.skip?.(remoteKey(u)))).slice(0, MAX_CHECKED);
  if (files.length === 0) return { nudges: [] };
  const base = readBaselines(sid);
  const byHost = new Map<string, Transfer[]>();
  for (const u of files) { const k = `${u.userhost}\0${u.sshArgs.join('\0')}`; byHost.set(k, [...(byHost.get(k) ?? []), u]); }
  const nudges: string[] = [];
  for (const group of byHost.values()) {
    // `scp f host:/dir`: if /dir is a directory the file lands at /dir/<basename>, read in the same ssh
    const inside = (u: Transfer): string => `${u.path.replace(/\/+$/, '')}/${basename(u.local)}`;
    const maybe = group.filter((u) => u.orDir);
    const server = remoteMd5s(group[0]!.userhost, group[0]!.sshArgs, [...group.map((u) => u.path), ...maybe.map(inside)], opts.killMs, maybe.map((u) => u.path));
    for (const u of group) {
      if (u.orDir && server.get(u.path)?.dir) {   // the file inside the directory is the target from here on
        u.path = inside(u);
        if (opts.skip?.(remoteKey(u))) continue;   // the override names the real target, as the deny text does
      }
      const copy = server.get(u.path) ?? { kind: 'error' as const, reason: 'no answer' };
      const mine = localMd5(u.local);
      const known = committedMd5s(u.local, u.path, opts.cwd);
      if (mine) known.set(mine, 'your file');
      for (const e of base[remoteKey(u)] ?? []) known.set(e.md5, e.how === 'upload' ? 'your last upload' : 'your fetched copy');
      const v = decideDeploy(copy, known);
      if (!v.allow) return { deny: denyDeployText(u, v.md5, opts.holderOf?.(u.local)), nudges: [] };
      nudges.push(deployNudge(u, v.note));
    }
  }
  for (const u of files) { const m = localMd5(u.local); if (m) recordBaseline(sid, remoteKey(u), m, 'upload'); }
  return { nudges };
}

/** PostToolUse: remember what this session just FETCHED from a server, so a later upload over it is allowed: the md5 of
 *  the file a download wrote (`scp host:p local`, `ssh host cat p > local`; 5 MB cap). An md5 a command merely printed
 *  (`ssh host md5sum p`) is NOT a baseline: seeing a hash is not having the content, and counting it let a session
 *  that checked the md5 after a refusal upload "HEAD + my hunk" over the very copy it was refused on. */
export function recordFetchBaselines(sid: string, command: string, cwd: string): void {
  try {
    if (!sid || typeof command !== 'string' || !/\b(scp|rsync|ssh)\b/.test(command)) return;
    for (const d of parseTransfers(command, cwd).downloads) {
      const m = localMd5(d.local);
      if (m) recordBaseline(sid, remoteKey(d), m, 'fetch');
    }
  } catch { /* a lost baseline only means a later upload asks for a fetch */ }
}
