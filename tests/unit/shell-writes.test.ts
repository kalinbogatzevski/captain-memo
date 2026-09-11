import { test, expect } from 'bun:test';
import { resolve } from 'path';
import { parseWrittenPaths, MAX_SHELL_FILES, isCoarseClaim, coarseClaimFor } from '../../src/hooks/shell-writes.ts';

// The bug this covers: in bypass-permissions mode Claude Code is instructed to make file changes with
// `sed`, heredocs and `>` rather than the Edit/Write tools — so PreToolUse's auto-claim, which only ever
// fired on a tool_input.file_path, published NOTHING for an entire session's worth of real edits.
// Everything here is ADVISORY input to a work claim: over-claiming costs a spurious "you might collide",
// under-claiming costs a silent clobber. When in doubt, claim.

const CWD = process.platform === 'win32' ? 'C:\\src\\proj' : '/src/proj';
const at = (...p: string[]) => p.map((x) => resolve(CWD, x));
const parse = (cmd: string, shell: 'posix' | 'powershell' = 'posix') => parseWrittenPaths(cmd, CWD, shell);

// ─── POSIX: the constructs bypass mode actually uses ────────────────────────
test('sed -i claims the edited file, with or without a backup suffix', () => {
  expect(parse(`sed -i 's/a/b/' src/foo.ts`)).toEqual(at('src/foo.ts'));
  expect(parse(`sed -i.bak 's/a/b/' src/foo.ts`)).toEqual(at('src/foo.ts'));
  expect(parse(`sed -i -e 's/a/b/' -e 's/c/d/' src/foo.ts`)).toEqual(at('src/foo.ts'));
});

test('sed WITHOUT -i is read-only and claims nothing', () => {
  expect(parse(`sed -n '1,5p' src/foo.ts`)).toEqual([]);
  expect(parse(`sed 's/a/b/' src/foo.ts`)).toEqual([]);
});

test('redirections claim their target', () => {
  expect(parse('echo hi > out.txt')).toEqual(at('out.txt'));
  expect(parse('echo hi >> log.txt')).toEqual(at('log.txt'));
  expect(parse(`cat > src/a.ts <<'EOF'`)).toEqual(at('src/a.ts'));   // heredoc write
  expect(parse('bun run build 2> build.err')).toEqual(at('build.err'));
});

test('redirections that are not files claim nothing', () => {
  expect(parse('bun test > /dev/null')).toEqual([]);
  expect(parse('bun test 2>&1')).toEqual([]);              // fd dup, not a path
  expect(parse('bun test > /dev/null 2>&1')).toEqual([]);
  expect(parse('cmd > NUL', 'powershell')).toEqual([]);
});

// `>` is only a redirect outside quotes. Without this, `echo "a > b"` claimed a file called `b"` — pure
// noise on the board, and noise is how a coordination signal gets ignored.
test('a > inside a quoted string is not a redirect', () => {
  expect(parse('echo "a > b"')).toEqual([]);
  expect(parse(`grep "x > y" src/foo.ts`)).toEqual([]);
  expect(parse('echo hi > "out file.txt"')).toEqual(at('out file.txt'));   // a genuinely quoted target still works
});

test('tee claims its targets, append or not', () => {
  expect(parse('echo x | tee out.txt')).toEqual(at('out.txt'));
  expect(parse('echo x | tee -a out.txt')).toEqual(at('out.txt'));
});

test('cp claims the destination only; mv claims source and destination', () => {
  expect(parse('cp a.ts b.ts')).toEqual(at('b.ts'));               // source is read, not written
  expect(parse('mv a.ts b.ts')).toEqual(at('a.ts', 'b.ts'));       // source is removed → mutated
});

test('dd and truncate claim their target', () => {
  expect(parse('dd if=/dev/zero of=disk.img bs=1M')).toEqual(at('disk.img'));
  expect(parse('truncate -s 0 app.log')).toEqual(at('app.log'));
});

test('read-only commands claim nothing', () => {
  expect(parse('cat src/foo.ts')).toEqual([]);
  expect(parse('grep -rn needle src/')).toEqual([]);
  expect(parse('ls -la')).toEqual([]);
  expect(parse('git status')).toEqual([]);
  expect(parse('bun test tests/unit/')).toEqual([]);
});

test('several writes in one command line are all claimed, deduped, in order', () => {
  expect(parse(`sed -i s/a/b/ a.ts && echo x > b.txt`)).toEqual(at('a.ts', 'b.txt'));
  expect(parse(`echo x > a.txt; echo y >> a.txt`)).toEqual(at('a.txt'));   // deduped
});

// ─── the unresolvable case ──────────────────────────────────────────────────
// `for f in *.ts; do sed -i ... "$f"; done` is the common shape. A variable cannot be resolved from the
// command text, and claiming NOTHING is the failure mode this whole change exists to remove — so fall
// back to the whole cwd. Coarse and noisy beats invisible.
test('a write whose path is a variable falls back to claiming the cwd subtree', () => {
  expect(parse(`sed -i 's/a/b/' "$f"`)).toEqual([coarseClaimFor(CWD)]);
  expect(parse('echo x > "$OUT"')).toEqual([coarseClaimFor(CWD)]);
});

// The fallback is COARSE and the caller must be able to tell, because a cwd can be a broad parent of
// many unrelated projects. Observed live: a session at `C:\src` — not a repo at all — claimed
// `C:\src/**`, which overlapped every project beneath it and warned sessions that shared nothing with
// it. pre-tool-use.ts narrows it to the repo root, or drops it when there is no repo.
test('the coarse fallback is identifiable, and named files are never mistaken for it', () => {
  expect(isCoarseClaim(parse(`sed -i 's/a/b/' "$f"`), CWD)).toBe(true);
  expect(isCoarseClaim(parse('echo hi > out.txt'), CWD)).toBe(false);
  expect(isCoarseClaim(parse('cat foo.ts'), CWD)).toBe(false);           // empty is not coarse
  expect(isCoarseClaim(parse(`sed -i 's/a/b/' src/*.ts`), CWD)).toBe(false);   // a real glob is not coarse
});

// FOUND LIVE: a claim on the board named `C:\src\=`, with no such file on disk. ` >= ` was being read
// as a redirect to a file called `=`. A shell would genuinely redirect there, but an agent writing `>=`
// means a comparison — and a bogus path is noise, which is how a real signal gets ignored.
test('a >= comparison is not a redirect', () => {
  expect(parse('if [ $a >= $b ]; then echo x; fi')).toEqual([]);
  expect(parse('pip install numpy>=1.2')).toEqual([]);
  expect(parse('test $x >>= 2')).toEqual([]);
  expect(parse('echo hi >= out.txt')).toEqual([]);       // still a comparison shape, not a claim
});

// FOUND LIVE: splitting on `;` leaves a loop body as `do sed -i …`, so the command name read as `do`
// and the whole shape was missed — including the `for f in *.ts; do sed -i … "$f"; done` bulk edit that
// the coarse fallback was written for. Wrappers hid it the same way.
test('shell keywords and wrappers do not hide the real command', () => {
  expect(parse('for f in *.ts; do sed -i "s/a/b/" "$f"; done')).toEqual([coarseClaimFor(CWD)]);
  expect(parse('if [ -f x ]; then sed -i s/a/b/ a.ts; fi')).toEqual(at('a.ts'));
  expect(parse('sudo sed -i s/a/b/ a.ts')).toEqual(at('a.ts'));
  expect(parse('sudo -u kalin sed -i s/a/b/ a.ts')).toEqual(at('a.ts'));
  expect(parse('time sed -i s/a/b/ a.ts')).toEqual(at('a.ts'));
  expect(parse('find . -name "*.ts" | xargs sed -i s/a/b/')).toEqual([coarseClaimFor(CWD)]);
});

test('globs are claimed as-is — the board understands them', () => {
  expect(parse(`sed -i 's/a/b/' src/*.ts`)).toEqual(at('src/*.ts'));
});

test('output is capped so a find -exec fan-out cannot flood the board', () => {
  const many = Array.from({ length: 40 }, (_, i) => `f${i}.txt`);
  const cmd = many.map((f) => `echo x > ${f}`).join(' && ');
  expect(parse(cmd)).toHaveLength(MAX_SHELL_FILES);
});

// ─── PowerShell: the primary shell on this host, and it matched NO hook at all ──
test('PowerShell write cmdlets claim their target', () => {
  expect(parse('Set-Content -Path src\\a.ts -Value x', 'powershell')).toEqual(at('src/a.ts'));
  expect(parse('Add-Content -Path app.log -Value x', 'powershell')).toEqual(at('app.log'));
  expect(parse('"x" | Out-File -FilePath out.txt', 'powershell')).toEqual(at('out.txt'));
  expect(parse('New-Item -ItemType File -Path new.txt', 'powershell')).toEqual(at('new.txt'));
  expect(parse('Copy-Item a.txt -Destination b.txt', 'powershell')).toEqual(at('b.txt'));
});

test('PowerShell positional path is claimed when no -Path flag is given', () => {
  expect(parse('Set-Content a.txt "hello"', 'powershell')).toEqual(at('a.txt'));
});

test('PowerShell read-only cmdlets claim nothing', () => {
  expect(parse('Get-Content src/foo.ts', 'powershell')).toEqual([]);
  expect(parse('Select-String -Pattern x -Path src/*.ts', 'powershell')).toEqual([]);
  expect(parse('Get-ChildItem -Recurse', 'powershell')).toEqual([]);
});

// ─── robustness: this runs in front of EVERY Bash call, and must never throw ──
test('malformed / hostile input is a silent no-op, never a throw', () => {
  for (const bad of ['', '   ', '>', '>>', 'sed -i', 'tee', 'cp', '|||', '&& &&', '>'.repeat(500)]) {
    expect(() => parse(bad)).not.toThrow();
  }
  expect(parse('')).toEqual([]);
});

test('no cwd → no claim (an unresolvable relative path is worse than none)', () => {
  expect(parseWrittenPaths('echo x > out.txt', '', 'posix')).toEqual([]);
});
