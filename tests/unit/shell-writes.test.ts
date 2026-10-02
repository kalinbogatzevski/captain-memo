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
  expect(parse('sudo -u alice sed -i s/a/b/ a.ts')).toEqual(at('a.ts'));
  expect(parse('time sed -i s/a/b/ a.ts')).toEqual(at('a.ts'));
  expect(parse('find . -name "*.ts" | xargs sed -i s/a/b/')).toEqual([coarseClaimFor(CWD)]);
});

// FOUND LIVE (again, on my own claim): `$(… 2>/dev/null)` claimed a file called `/dev/null)` —
// the closing paren of a command substitution was swallowed into the redirect target, so the
// not-a-file check no longer recognised it. Parens terminate the target.
test('a command substitution does not swallow its closing paren into the target', () => {
  expect(parse('x=$(grep -c foo bar 2>/dev/null)')).toEqual([]);
  expect(parse('echo $(date) > out.txt')).toEqual(at('out.txt'));
  expect(parse('(echo hi > inner.txt)')).toEqual(at('inner.txt'));
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

// ─── 2026-09-17 work board garbage: heredoc bodies, quoted code, code tokens, the wrong cwd ────────────
// Observed claims: "/home/user/.config/captain-memo/{", ".../bun:test", ".../SummarizerTransport,",
// ".../.\/summarizer.ts" (tokens of TypeScript import lines inside a python heredoc), "C:\src\x\'", "…\<",
// "…\2>&1)", and scratchpad files resolved under C:\src\ because the command had `cd`'d elsewhere.
test('a heredoc body is not scanned for redirects or targets — only the heredoc\'s own target is claimed', () => {
  const cmd = [
    "cat > src/a.ts <<'EOF'",
    "import { test } from 'bun:test';",
    "const f = (x) => { return x > 2 ? a : b };",
    "export type T = Record<string, SummarizerTransport>;",
    "echo hi > /tmp/inside-heredoc.txt",
    "EOF",
    "python3 - <<'PY'",
    "s=s.replace(\"import { a, type SummarizerTransport, b } from './summarizer.ts';\", 'x')",
    "open('/tmp/py.txt','w').write('{')",
    "PY",
  ].join('\n');
  // The interpreter scan (scriptWrites) DOES read the python body: its literal open(..., 'w') is a real write.
  expect(parse(cmd)).toEqual([...at('src/a.ts'), resolve('/tmp/py.txt')]);
});

test('quoted code (python -c, node -e, bash -c) is not scanned for redirects', () => {
  // the `>` inside is not a redirect; the literal open(..., "w") is a write the interpreter scan names
  expect(parse(`python3 -c 'import sys; print(sys.argv > 1); open("/tmp/x","w")' && echo ok`)).toEqual([resolve('/tmp/x')]);
  expect(parse(`node -e "const f = () => { x > y }" > real-out.txt`)).toEqual(at('real-out.txt'));
});

test('tokens that cannot be paths are dropped: braces, quotes, module specifiers, trailing commas, fd dups', () => {
  expect(parse(`echo x > {`)).toEqual([]);
  expect(parse(`echo x > 'bun:test'`)).toEqual([]);
  expect(parse(`tee SummarizerTransport, foo.txt`)).toEqual(at('foo.txt'));
  expect(parse(`echo x > <`)).toEqual([]);
  expect(parse(`(bun test 2>&1)`)).toEqual([]);
  expect(parse(`Set-Content -Path "'" -Value 1`, 'powershell')).toEqual([]);
  expect(parse(`Out-File 2>&1) -Value 1`, 'powershell')).toEqual([]);
});

test('relative paths resolve against the directory the command cd\'d into, not the session cwd', () => {
  expect(parse(`cd /tmp/scratch && echo x > out.txt && sed -i 's/a/b/' notes.md`)).toEqual(['/tmp/scratch/out.txt', '/tmp/scratch/notes.md'].map((p) => resolve(p)));
  expect(parse(`cd sub; echo x > out.txt`)).toEqual(at('sub/out.txt'));
  expect(parse(`Set-Location sub2; Set-Content -Path out.txt -Value 1`, 'powershell')).toEqual(at('sub2/out.txt'));
  expect(parse(`cd "$SCRATCH" && echo x > out.txt`)).toEqual([coarseClaimFor(CWD)]);   // a cd we cannot resolve: the write is real, its place unknown
});

// ─── guard 1 (2026-09-30): name more writes, so fewer edits fall back to the whole-repo claim ─────────────
test('perl -i, -pi -e and -i.bak claim the edited file; perl without -i claims nothing', () => {
  expect(parse(`perl -i -pe 's/a/b/' src/a.php`)).toEqual(at('src/a.php'));
  expect(parse(`perl -pi -e 's/a/b/' src/a.php src/b.php`)).toEqual(at('src/a.php', 'src/b.php'));
  expect(parse(`perl -i.bak -pe 's/a/b/' src/a.php`)).toEqual(at('src/a.php'));
  expect(parse(`perl -ne 'print if /x/' src/a.php`)).toEqual([]);
  // -Ilib / -Mdiagnostics carry an i but are not in-place: a read-only perl must not claim (and now be blocked on) a file
  expect(parse(`perl -Ilib -e 'print 1' src/a.php`)).toEqual([]);
  expect(parse(`perl -Mdiagnostics -ne 'print' src/a.php`)).toEqual([]);
});

test('inline interpreter writes with a literal path are named: python open/Path, node writeFileSync, php file_put_contents', () => {
  expect(parse("python3 - <<'PY'\nimport pathlib\nopen('hr/rpc.php','w').write(s)\nPY")).toEqual(at('hr/rpc.php'));
  expect(parse("python3 - <<'PY'\nfrom pathlib import Path\nPath('hr/functions.php').write_text(s)\nPY")).toEqual(at('hr/functions.php'));
  expect(parse(`node -e "require('fs').writeFileSync('out/x.json', '{}')"`)).toEqual(at('out/x.json'));
  expect(parse(`php -r "file_put_contents('cfg/a.ini', 'x');"`)).toEqual(at('cfg/a.ini'));
  expect(parse(`python3 -c "open('a.txt').read()"`)).toEqual([]);   // read mode is not a write
});

test('an interpreter write through a variable yields nothing, and a line with ssh is never scanned', () => {
  expect(parse(`python3 -c "open(p,'w').write(s)"`)).toEqual([]);
  expect(parse(`ssh root@h "python3 -c \\"open('/etc/x','w')\\""`)).toEqual([]);
});

test('sed -i on a variable is still the coarse claim', () => {
  expect(parse(`for f in *.ts; do sed -i 's/a/b/' "$f"; done`)).toEqual([coarseClaimFor(CWD)]);
});
