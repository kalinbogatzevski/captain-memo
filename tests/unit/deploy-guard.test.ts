// Guard 3 (2026-09-30): an upload built as "HEAD + my hunk" erased another session's uncommitted work on the server.
// Before an upload the hook reads the server copy's md5 and refuses when it is none of: the local file, a committed
// version, a copy this session fetched or uploaded. No real host is contacted: a fake `ssh` on PATH runs md5sum locally.
import { test, expect, beforeAll } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import {
  parseTransfers, decideDeploy, denyDeployText, deployNudge, parseMd5sumLines, md5Of, remoteKey, checkUploads,
  recordBaseline, readBaselines, recordFetchBaselines, committedMd5s,
} from '../../src/hooks/deploy-guard.ts';

const noDir = () => false;

test('scp: flags with values are skipped, the last positional is the destination, ssh args are carried', () => {
  const r = parseTransfers('scp -P 30043 -i /k/id -o StrictHostKeyChecking=no hr/functions.php root@deploy.example.com:/var/www/app/hr/functions.php', '/repo', noDir);
  expect(r.uploads).toEqual([{ local: '/repo/hr/functions.php', userhost: 'root@deploy.example.com', path: '/var/www/app/hr/functions.php', sshArgs: ['-p', '30043', '-i', '/k/id', '-o', 'StrictHostKeyChecking=no'] }]);
  expect(r.downloads).toEqual([]);
});

test('scp: several sources or a trailing slash land under the directory; -r with a directory is a dir claim', () => {
  expect(parseTransfers('scp a.php b.php root@h1:/srv/x/', '/r', noDir).uploads.map((u) => u.path)).toEqual(['/srv/x/a.php', '/srv/x/b.php']);
  expect(parseTransfers('scp a.php root@h1:/srv/x/', '/r', noDir).uploads[0]!.path).toBe('/srv/x/a.php');
  const d = parseTransfers('scp -r mod root@h1:/srv/', '/r', (p) => p === '/r/mod').uploads[0]!;
  expect(d).toMatchObject({ local: '/r/mod', path: '/srv/mod', dir: true });
});

test('rsync -e \'ssh -p 30043 -i k\' carries the port and key', () => {
  const u = parseTransfers("rsync -av -e 'ssh -p 30043 -i /k' a.php root@h1:/srv/a.php", '/r', noDir).uploads[0]!;
  expect(u).toMatchObject({ local: '/r/a.php', userhost: 'root@h1', path: '/srv/a.php', sshArgs: ['-p', '30043', '-i', '/k'] });
});

test("ssh h 'cat > p' < f is an upload; ssh h cat p > f and scp h:p f are downloads", () => {
  expect(parseTransfers("ssh root@h1 'cat > /srv/a.php' < a.php", '/r', noDir).uploads).toEqual([{ local: '/r/a.php', userhost: 'root@h1', path: '/srv/a.php', sshArgs: [] }]);
  expect(parseTransfers('ssh -p 22 root@h1 cat /srv/a.php > /tmp/a.live', '/r', noDir).downloads).toEqual([{ local: '/tmp/a.live', userhost: 'root@h1', path: '/srv/a.php', sshArgs: ['-p', '22'] }]);
  expect(parseTransfers('scp root@h1:/srv/a.php /tmp/a.live', '/r', noDir).downloads[0]).toMatchObject({ local: '/tmp/a.live', path: '/srv/a.php' });
  expect(parseTransfers('scp root@h1:/srv/a.php /tmp/', '/r', noDir).downloads[0]!.local).toBe('/tmp/a.php');
});

test('a Windows drive stays local; read-only commands and sftp yield nothing', () => {
  expect(parseTransfers('scp C:\\x\\a.php root@h1:/y', '/r', noDir).uploads[0]!.userhost).toBe('root@h1');
  expect(parseTransfers('scp root@h1:/y C:\\x\\a.php', '/r', noDir).downloads[0]!.userhost).toBe('root@h1');
  expect(parseTransfers('ls -la && git status', '/r', noDir)).toEqual({ uploads: [], downloads: [] });
  expect(parseTransfers('sftp -b batch root@h1', '/r', noDir)).toEqual({ uploads: [], downloads: [] });
});

test('decision: a known md5 allows with its label, absent allows as new, an ssh failure fails open, a mismatch denies', () => {
  const known = new Map([['a'.repeat(32), 'HEAD'], ['b'.repeat(32), 'your fetched copy']]);
  expect(decideDeploy({ kind: 'md5', md5: 'a'.repeat(32) }, known)).toEqual({ allow: true, note: 'matched HEAD' });
  expect(decideDeploy({ kind: 'md5', md5: 'b'.repeat(32) }, known)).toEqual({ allow: true, note: 'matched your fetched copy' });
  expect(decideDeploy({ kind: 'absent' }, known)).toEqual({ allow: true, note: 'is new' });
  const err = decideDeploy({ kind: 'error', reason: 'ssh timed out' }, known);
  expect(err.allow).toBe(true);
  expect((err as { note: string }).note).toContain('could not be checked (ssh timed out)');
  expect(decideDeploy({ kind: 'md5', md5: 'c'.repeat(32) }, known)).toEqual({ allow: false, md5: 'c'.repeat(32) });
});

test('the deny text names host:path, the fetch command and the override; the nudge says build from the live copy', () => {
  const t = { local: '/r/hr/functions.php', userhost: 'root@deploy.example.com', path: '/var/www/hr/functions.php', sshArgs: ['-p', '30043'] };
  const d = denyDeployText(t, 'deadbeef'.repeat(4), { local: t.local, session_id: '0b005e40', agent: 'claude', age_s: 1200 });
  expect(d).toStartWith('DEPLOY BLOCKED: root@deploy.example.com:/var/www/hr/functions.php on the server (md5 deadbeef)');
  expect(d).toContain('scp -P 30043 root@deploy.example.com:/var/www/hr/functions.php <your scratchpad>/functions.php.live');
  expect(d).toContain('held by 0b005e40 (claude, 20 min ago)');
  expect(d).toContain('`override: root@deploy.example.com:/var/www/hr/functions.php`');
  expect(d).not.toMatch(/\u2014/);
  expect(deployNudge(t, 'matched HEAD')).toBe('DEPLOY: server copy of /var/www/hr/functions.php matched HEAD. Build a deploy from the LIVE copy plus your change, never from HEAD plus your change.');
});

test('md5sum output lines parse; baselines keep the last five per target', () => {
  expect([...parseMd5sumLines(`${'a'.repeat(32)}  /srv/a.php\nmd5sum: /srv/b: No such file\n${'b'.repeat(32)}  rel/c.php`)]).toEqual([['/srv/a.php', 'a'.repeat(32)], ['rel/c.php', 'b'.repeat(32)]]);
  for (let i = 0; i < 7; i++) recordBaseline('sess-b', 'root@h:/p', String(i).repeat(32), 'upload');
  expect(readBaselines('sess-b')['root@h:/p']!.map((e) => e.md5[0])).toEqual(['2', '3', '4', '5', '6']);
  // an md5 a command printed is not a fetched copy: seeing the hash is not having the content
  recordFetchBaselines('sess-f', 'ssh root@h1 md5sum /srv/a.php', '/r');
  expect(readBaselines('sess-f')['root@h1:/srv/a.php']).toBeUndefined();
});

// The three overwrites of 2026-09-30, verbatim in shape (only the scratchpad path is shortened). Every path is in a shell
// variable, two are inside a `for box in` loop; the first parser skipped all of them.
const S = '/home/u/tmp/claude-1000/x/scratchpad';
const R = '/var/www/app';
test('incident commands: same-line variables and for-loops resolve to the real targets', () => {
  const c1 = `cd /home/u/projects/app; S=${S}; R=${R}\nscp -q $S/hr_functions_deploy.php root@deploy.example.com:$R/core/modules/admin/hr/functions.php && scp -q core/modules/admin/hr/post_handlers/importflog_handler.php root@deploy.example.com:$R/core/modules/admin/hr/post_handlers/ && ssh -o BatchMode=yes root@deploy.example.com "cd $R && php -l core/modules/admin/hr/functions.php"`;
  expect(parseTransfers(c1, '/', noDir).uploads.map((u) => [u.local, remoteKey(u)])).toEqual([
    [`${S}/hr_functions_deploy.php`, `root@deploy.example.com:${R}/core/modules/admin/hr/functions.php`],
    ['/home/u/projects/app/core/modules/admin/hr/post_handlers/importflog_handler.php', `root@deploy.example.com:${R}/core/modules/admin/hr/post_handlers/importflog_handler.php`],
  ]);
  const c2 = `cd /home/u/projects/app; S=${S}; R=${R}; H=$(git show HEAD:core/modules/admin/hr/rpc.php | md5sum | cut -c1-32)\nfor box in deploy2.example.com deploy.example.com; do cur=$(ssh -o BatchMode=yes root@$box "md5sum $R/core/modules/admin/hr/rpc.php" | cut -c1-32); if [ "$cur" = "$H" ]; then scp -q $S/hr_rpc_deploy.php root@$box:$R/core/modules/admin/hr/rpc.php && scp -q core/templates/admin/hr/history.html root@$box:$R/core/templates/admin/hr/ && echo ok; fi; done`;
  expect(parseTransfers(c2, '/', noDir).uploads.filter((u) => u.path.endsWith('rpc.php')).map(remoteKey)).toEqual([
    `root@deploy2.example.com:${R}/core/modules/admin/hr/rpc.php`, `root@deploy.example.com:${R}/core/modules/admin/hr/rpc.php`,
  ]);
  const c3 = `R=${R}\nfor box in deploy2.example.com deploy.example.com; do scp -q $S/hr_rpc_deploy.php root@$box:$R/core/modules/admin/hr/rpc.php && ssh -o BatchMode=yes root@$box "php -l $R/core/modules/admin/hr/rpc.php | head -1"; done`;
  const r3 = parseTransfers(`S=${S}; ${c3}`, '/', noDir);
  expect(r3.uploads.map((u) => u.userhost)).toEqual(['root@deploy2.example.com', 'root@deploy.example.com']);
  // unresolvable expansions are counted, never guessed
  expect(parseTransfers('put() { scp -q "$2" root@$1:"$R/$3.deploytmp"; }; put deploy2.example.com a a', '/r', noDir).unchecked).toBe(1);
  expect(parseTransfers('for h in a:b; do box=${h%%:*}; scp x.php root@$box:/srv/x.php; done', '/r', noDir).unchecked).toBe(1);
  // upload to a temp name then mv over the target: the target is what is checked
  expect(parseTransfers(`F=hr/rpc.php; scp -q $F root@h1:${R}/$F.deploytmp && ssh root@h1 "mv -f ${R}/$F.deploytmp ${R}/$F"`, '/r', noDir).uploads[0]!.path).toBe(`${R}/hr/rpc.php`);
});

// ── end to end over a fake ssh (runs md5sum locally, ignoring the host) ───────────────────────────────────────────
let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // ssh [opts] host cmd: drop options and the host, run the command locally
  writeFileSync(join(bin, 'ssh'), '#!/bin/bash\nwhile [[ "$1" == -* ]]; do case "$1" in -o|-p|-i|-J|-F|-l) shift 2;; *) shift;; esac; done\nshift\n[ -n "$FAKE_SSH_FAIL" ] && exit 255\nexec bash -c "$*"\n');
  chmodSync(join(bin, 'ssh'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'hr'), { recursive: true });
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf-8' });
  git('init', '-q', '-b', 'master');
  writeFileSync(join(repo, 'hr/functions.php'), '<?php // v0 committed\n');
  git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'v0');
  mkdirSync(join(dir, 'server/hr'), { recursive: true });
});

test('committedMd5s reads HEAD (and the default branch) in one git cat-file', () => {
  const m = committedMd5s(join(dir, 'repo/hr/functions.php'));
  expect(m.get(md5Of('<?php // v0 committed\n'))).toBe('HEAD');
});

test('incident replay: A deployed uncommitted v1; B uploading HEAD + its hunk is denied; after fetching the live copy it is allowed', () => {
  const local = join(dir, 'repo/hr/functions.php');
  const server = join(dir, 'server/hr/functions.php');
  writeFileSync(server, '<?php // v1: A\'s uncommitted helpers\n');                  // A's deploy
  writeFileSync(local, '<?php // v0 committed\n// B hunk\n');                          // B: HEAD + my hunk
  const up = parseTransfers(`scp hr/functions.php root@h1:${server}`, join(dir, 'repo'), noDir).uploads;
  const denied = checkUploads('B', up);
  expect(denied.deny).toContain(`DEPLOY BLOCKED: root@h1:${server}`);
  // B fetches the live copy (PostToolUse records it), merges, uploads
  const live = join(dir, 'functions.php.live');
  writeFileSync(live, '<?php // v1: A\'s uncommitted helpers\n');
  recordFetchBaselines('B', `scp root@h1:${server} ${live}`, dir);
  writeFileSync(local, '<?php // v1: A\'s uncommitted helpers\n// B hunk\n');
  const ok = checkUploads('B', up);
  expect(ok.deny).toBeUndefined();
  expect(ok.nudges[0]).toContain('matched your fetched copy');
  // B's own edit-deploy-verify loop: the server now holds B's last upload
  writeFileSync(server, '<?php // v1: A\'s uncommitted helpers\n// B hunk\n');
  writeFileSync(local, '<?php // v1: A\'s uncommitted helpers\n// B hunk 2\n');
  expect(checkUploads('B', up).nudges[0]).toContain('matched your last upload');
});

test('a new server file is allowed; an ssh failure fails open with a nudge; a target the override covers is not checked', () => {
  const up = parseTransfers(`scp hr/functions.php root@h1:${join(dir, 'server/hr/new.php')}`, join(dir, 'repo'), noDir).uploads;
  expect(checkUploads('C', up).nudges[0]).toContain('is new');
  process.env.FAKE_SSH_FAIL = '1';
  const r = checkUploads('C', parseTransfers(`scp hr/functions.php root@h1:${join(dir, 'server/hr/functions.php')}`, join(dir, 'repo'), noDir).uploads);
  delete process.env.FAKE_SSH_FAIL;
  expect(r.deny).toBeUndefined();
  expect(r.nudges[0]).toContain('could not be checked');
  expect(checkUploads('C', up, { skip: (k) => k === remoteKey(up[0]!) })).toEqual({ nudges: [] });
});

test('incident replay through variables: HEAD + hunk built in a scratchpad is denied over a peer\'s deploy, allowed over HEAD', () => {
  const server = join(dir, 'server/hr/functions.php');
  const scratch = join(dir, 'scratch');
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'deploy.php'), '<?php // v0 committed\n// B hunk\n');
  const cmd = `S=${scratch}; R=${join(dir, 'server')}\nscp -q $S/deploy.php root@h1:$R/hr/functions.php`;
  const up = parseTransfers(cmd, join(dir, 'repo'), noDir).uploads;
  writeFileSync(server, '<?php // v0 committed\n');                    // live == HEAD: safe, and known through cwd's repo
  expect(checkUploads('B8', up, { cwd: join(dir, 'repo') }).nudges[0]).toContain('matched HEAD');
  writeFileSync(server, '<?php // v1: A\'s helpers\n');               // A deployed in between
  expect(checkUploads('B-2', up, { cwd: join(dir, 'repo') }).deny).toContain('DEPLOY BLOCKED');
  writeFileSync(join(dir, 'repo/hr/functions.php'), '<?php // v0 committed\n');
});

test('commit, then deploy: a server still on the file\'s previous committed version is replaced without a refusal', () => {
  const repo = join(dir, 'repo');
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf-8' });
  writeFileSync(join(repo, 'hr/functions.php'), '<?php // v2 committed\n');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'v2');
  writeFileSync(join(dir, 'server/hr/functions.php'), '<?php // v0 committed\n');   // the server lags one commit
  const up = parseTransfers(`scp hr/functions.php root@h1:${join(dir, 'server/hr/functions.php')}`, repo, noDir).uploads;
  const r = checkUploads('C2', up);
  expect(r.deny).toBeUndefined();
  expect(r.nudges[0]).toContain('matched a recent commit');
});

test('loop-body assignments are never pinned to the first iteration; quotes inside tokens are dropped', () => {
  // a per-file R inside `for f in a b`: the second file must not be paired with the first file's server path
  const c = `h=deploy2.example.com; for f in plugins/x/cron.php plugins/x/functions.php; do R=/var/www/app/$f; cur=$(ssh root@$h md5sum $R | cut -c1-8); scp -q $f root@$h:$R && ssh root@$h "php -l $R"; done`;
  const r = parseTransfers(c, '/repo', noDir);
  expect(r.uploads.filter((u) => u.local.endsWith('functions.php') && u.path.endsWith('cron.php'))).toEqual([]);
  expect(r.unchecked).toBeGreaterThan(0);
  // upload to "$f.deploytmp" then mv into place, with the quotes the shell needs
  const q = `cd /repo; f=core/hr/rpc.php; R=/var/www/app; for h in deploy2.example.com deploy.example.com; do scp -q "$f" root@$h:"$R/$f.deploytmp" && ssh root@$h "cd $R && php -l '$f.deploytmp' >/dev/null && mv -f '$f.deploytmp' '$f' && md5sum $f"; done`;
  expect(parseTransfers(q, '/', noDir).uploads.map((u) => [u.local, remoteKey(u)])).toEqual([
    ['/repo/core/hr/rpc.php', `root@deploy2.example.com:/var/www/app/core/hr/rpc.php`], ['/repo/core/hr/rpc.php', `root@deploy.example.com:/var/www/app/core/hr/rpc.php`],
  ]);
  expect(parseTransfers('S="/x/scratch"; scp -q $S/a.php root@h1:/srv/a.php', '/r', noDir).uploads[0]!.local).toBe('/x/scratch/a.php');
});
