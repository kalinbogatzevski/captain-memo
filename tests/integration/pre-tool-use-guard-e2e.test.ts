// Replays the 2026-09-30 overwrite through the REAL hook entry (bin/captain-memo-hook.ts) against a real in-process
// worker: Claude session A holds hr/functions.php, Claude session B tries to write it.
//   (a) A live: B's Edit is denied, naming A;                             (b) A stale: B is warned, not blocked;
//   (c) B scp's the file while A holds it live: denied;                   (d) an unnamed shell edit claims no file,
//       and an old whole-repo claim no longer warns;                       (e) the user's `override:` lets B write,
//       the board and A's next overlap line show it;                       (f) worker down: nothing blocks.
// Plus Codex and Gemini: their claims warn but never block an edit (no pid, see guardContested), and a deploy refusal
// reaches Gemini as {decision, reason}. No real host is contacted: ssh on PATH is a stub (fails, or prints an md5).
import { test, expect, beforeAll, afterAll, setSystemTime } from 'bun:test';
import { join, delimiter } from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { spawn } from 'bun';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const HOOK_BIN = join(import.meta.dir, '../../bin/captain-memo-hook.ts');
let worker: WorkerHandle;
let port = 0;
let root = '';        // a real git checkout, standing in for the shared repo
// ssh on PATH is a #!/bin/sh stub; on Windows the real ssh.exe would run, so the tests that need the stub's answer skip there.
const sshTest = process.platform === 'win32' ? test.skip : test;
let dataDir = '';
let binDir = '';
const FILE = () => join(root, 'hr/functions.php');

beforeAll(async () => {
  worker = await startWorker({
    port: 0, projectId: 'test-project', metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused', embedderModel: 'fake',
    vectorDbPath: ':memory:', embeddingDimension: 8, skipEmbed: true,
  });
  port = worker.port;
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'guard-e2e-')));   // .native: the long name git reports, not RUNNER~1
  root = join(base, 'repo');
  dataDir = join(base, 'data');
  binDir = join(base, 'bin');
  mkdirSync(join(root, 'hr'), { recursive: true });
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'ssh'), '#!/bin/sh\nexit 255\n');
  chmodSync(join(binDir, 'ssh'), 0o755);
  mkdirSync(join(base, 'bin-md5'));
  writeFileSync(join(base, 'bin-md5', 'ssh'), '#!/bin/sh\necho "0123456789abcdef0123456789abcdef  /srv/functions.php"\n');
  chmodSync(join(base, 'bin-md5', 'ssh'), 0o755);
  writeFileSync(FILE(), '<?php\n');
  spawnSync('git', ['-C', root, 'init', '-q']);
});
afterAll(async () => { setSystemTime(); await worker.stop(); });

async function hook(event: string, payload: unknown, env: Record<string, string> = {}) {
  const proc = spawn({
    cmd: ['bun', HOOK_BIN, event], stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}`, CAPTAIN_MEMO_DATA_DIR: dataDir, CAPTAIN_MEMO_WORKER_PORT: String(port), CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1', ...env },
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  let json = null;
  try { json = stdout.trim() ? JSON.parse(stdout) : null; } catch { /* UserPromptSubmit on Claude prints text, not JSON */ }
  return { code: await proc.exited, stdout, json };
}
const edit = (sid: string, file: string, pid: number, event = 'PreToolUse', tool = 'Edit') =>
  hook(event, { session_id: sid, cwd: root, tool_name: tool, tool_input: { file_path: file } }, { CLAUDE_PID: String(pid) });
const bash = (sid: string, command: string, pid: number) =>
  hook('PreToolUse', { session_id: sid, cwd: root, tool_name: 'Bash', tool_input: { command } }, { CLAUDE_PID: String(pid) });
const active = async (sid: string) => (await (await fetch(`http://localhost:${port}/worknote/active?session_id=${sid}`)).json()) as
  { claims: Array<{ session_id: string; files: string[]; repo_root?: string; override?: { files: string[] } }>; my_override?: { files: string[] } };

test('(a) B edits hr/functions.php while A holds it live: blocked, naming A and the user\'s decision', async () => {
  expect((await edit('sess-A', FILE(), process.pid)).json).toBeNull();   // A claims it, nothing to say
  const b = await edit('sess-B', FILE(), 4_000_001);
  expect(b.code).toBe(0);
  expect(b.json.hookSpecificOutput.permissionDecision).toBe('deny');
  const reason: string = b.json.hookSpecificOutput.permissionDecisionReason;
  expect(reason).toStartWith(`WORK-BOARD: BLOCKED. ${FILE()} is held by another session on this captain (`);
  expect(reason).toContain('(sess-A, claude, last edit');
  expect(reason).toContain('Stop and tell the user which session holds it');
  expect(b.json.hookSpecificOutput.additionalContext).toBeUndefined();
  expect((await active('sess-B')).claims.find((c) => c.session_id === 'sess-B')?.files ?? []).not.toContain(FILE());
});

test('(c) B uploads hr/functions.php with scp while A holds it live: blocked (the server check fails open, the claim decides)', async () => {
  const r = await bash('sess-B', 'scp -P 30043 hr/functions.php root@deploy.example.com:/var/www/app/hr/functions.php', 4_000_001);
  expect(r.json.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(r.json.hookSpecificOutput.permissionDecisionReason).toContain(`WORK-BOARD: BLOCKED. ${FILE()}`);
});

test('Codex apply_patch and Gemini write_file (relative path) claim the file and are warned, never blocked (no pid)', async () => {
  const patch = `*** Begin Patch\n*** Update File: hr/functions.php\n@@\n-a\n+b\n*** End Patch\n`;
  // CLAUDE_PID set on purpose: a Codex started from a Claude shell inherits it, and must not send it
  const cx = await hook('CodexPreToolUse', { session_id: 'codex-B', cwd: root, tool_name: 'apply_patch', tool_input: { command: patch } }, { CLAUDE_PID: String(process.pid) });
  expect(cx.json.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(cx.json.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
  expect(cx.json.hookSpecificOutput.additionalContext).toContain('WORK-BOARD OVERLAP');
  const gm = await hook('GeminiBeforeTool', { session_id: 'gem-B', cwd: root, tool_name: 'write_file', tool_input: { file_path: 'hr/functions.php', content: 'x' } });
  expect(gm.json.decision).toBeUndefined();
  expect(gm.json.hookSpecificOutput).toMatchObject({ hookEventName: 'BeforeTool' });
  expect(gm.json.hookSpecificOutput.additionalContext).toContain(FILE());
  expect((await active('gem-B')).claims.find((c) => c.session_id === 'gem-B')?.files).toContain(FILE());
});

sshTest('a deploy refusal reaches Gemini as {decision, reason}: the server copy matches nothing this session knows', async () => {
  writeFileSync(join(root, 'up.php'), '<?php // mine\n');
  const gm = await hook('GeminiBeforeTool', { session_id: 'gem-D', cwd: root, tool_name: 'run_shell_command', tool_input: { command: 'scp up.php root@deploy.example.com:/srv/functions.php' } },
    { PATH: `${binDir.replace(/bin$/, 'bin-md5')}${delimiter}${process.env.PATH}` });
  expect(gm.json.decision).toBe('deny');
  expect(gm.json.reason).toStartWith('DEPLOY BLOCKED: root@deploy.example.com:/srv/functions.php on the server (md5 01234567)');
  expect(gm.json.hookSpecificOutput).toBeUndefined();
});

test('(e) B\'s user types `override: hr/functions.php`: recorded, B\'s edit goes through, the board and A see it', async () => {
  const ups = await hook('UserPromptSubmit', { session_id: 'sess-B', cwd: root, prompt: 'override: hr/functions.php' });
  // Codex and Gemini claims (shape test above) count as holders too: an override is shown to every live holder
  expect(ups.stdout).toContain(`Override recorded for ${FILE()} (30 min); holder(s) `);
  expect(ups.stdout).toMatch(/holder\(s\) [^\n]*sess-A[^\n]* will see it on the work board\./);
  const b = await edit('sess-B', FILE(), 4_000_001);
  expect(b.json.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(b.json.hookSpecificOutput.additionalContext).toContain(`WORK-BOARD OVERRIDE (by the user) in force: writing ${FILE()}`);
  expect((await active('sess-B')).my_override?.files).toEqual([FILE()]);
  const a = await edit('sess-A', FILE(), process.pid);
  expect(a.json.hookSpecificOutput.additionalContext).toContain('its user typed `override:`');
  // words that do not open the prompt are not an override
  expect((await hook('UserPromptSubmit', { session_id: 'sess-C', cwd: root, prompt: 'please override: hr/functions.php' })).stdout).not.toContain('Override recorded');
});

test('(d) a shell edit with no nameable file claims no file (repo presence only), and an old whole-repo claim does not warn', async () => {
  await bash('sess-D', `for f in hr/*.php; do sed -i 's/a/b/' "$f"; done`, 4_000_004);
  const d = (await active('sess-D')).claims.find((c) => c.session_id === 'sess-D')!;
  expect(d.files).toEqual([]);
  expect(d.repo_root?.replaceAll('\\', '/')).toBe(root.replaceAll('\\', '/'));   // git prints C:/..., join() C:\...
  // a whole-repo claim from an older captain-memo version
  await fetch(`http://localhost:${port}/worknote/set`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'sess-OLD', agent: 'claude', what: 'x', files: [`${root}/**`] }) });
  const e = await edit('sess-E', join(root, 'hr/rpc.php'), 4_000_005);
  expect(JSON.stringify(e.json ?? {})).not.toContain('sess-OLD');
});

test('(b) A has gone quiet past the stale ceiling: B is warned, not blocked', async () => {
  await edit('sess-A2', join(root, 'hr/post.php'), process.pid);
  setSystemTime(new Date(Date.now() + 11 * 60_000));
  const b = await edit('sess-B2', join(root, 'hr/post.php'), 4_000_002);
  setSystemTime();
  expect(b.json.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(b.json.hookSpecificOutput.additionalContext).toContain('Every overlapping claim is stale');
  expect(b.json.hookSpecificOutput.additionalContext).toContain('sess-A2');
});

test('(f) worker down: nothing blocks, nothing printed, exit 0', async () => {
  const r = await hook('PreToolUse', { session_id: 'sess-B', cwd: root, tool_name: 'Edit', tool_input: { file_path: FILE() } }, { CAPTAIN_MEMO_WORKER_PORT: '1' });
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe('');
});

test('the kill switch CAPTAIN_MEMO_WORKBOARD_ENFORCE=0 turns the block back into a warning', async () => {
  await edit('sess-K1', join(root, 'hr/k.php'), process.pid);
  const r = await hook('PreToolUse', { session_id: 'sess-K2', cwd: root, tool_name: 'Edit', tool_input: { file_path: join(root, 'hr/k.php') } }, { CAPTAIN_MEMO_WORKBOARD_ENFORCE: '0' });
  expect(r.json.hookSpecificOutput.permissionDecision).toBeUndefined();
  expect(r.json.hookSpecificOutput.additionalContext).toContain('WORK-BOARD OVERLAP');
});

sshTest('a deploy whose paths are in same-line shell variables and a for-loop is checked too', async () => {
  writeFileSync(join(root, 'up.php'), '<?php // mine\n');
  const gm = await hook('GeminiBeforeTool', { session_id: 'gem-V', cwd: root, tool_name: 'run_shell_command', tool_input: { command: 'S=.; R=/srv\nfor box in deploy.example.com; do scp -q $S/up.php root@$box:$R/functions.php; done' } },
    { PATH: `${binDir.replace(/bin$/, 'bin-md5')}${delimiter}${process.env.PATH}` });
  expect(gm.json.decision).toBe('deny');
  expect(gm.json.reason).toStartWith('DEPLOY BLOCKED: root@deploy.example.com:/srv/functions.php');
});

test('two sessions writing the same /tmp scratch file never block each other', async () => {
  const f = `/tmp/cm-guard-scratch-${process.pid}.txt`;
  await bash('tmpA', `echo a > ${f}`, 5_100_001);
  const b = await bash('tmpB', `echo b > ${f}`, 5_100_002);
  expect(b.json?.hookSpecificOutput?.permissionDecision).toBeUndefined();
});

// #227: `scp f host:/dir` with no trailing slash, where /dir is a directory on the server: the file inside it is the target.
sshTest('an upload into a server directory is claimed and reported under the file it lands on', async () => {
  const bin = join(binDir, '..', 'bin-dir');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ssh'), '#!/bin/sh\necho "cm-is-dir /srv/app"\n');
  chmodSync(join(bin, 'ssh'), 0o755);
  writeFileSync(join(root, 'up2.php'), '<?php // mine\n');
  const r = await hook('PreToolUse', { session_id: 'dir-A', cwd: root, tool_name: 'Bash', tool_input: { command: 'scp -q up2.php root@h9:/srv/app' } },
    { CLAUDE_PID: '5200001', PATH: `${bin}${delimiter}${process.env.PATH}` });
  expect(r.json.hookSpecificOutput.additionalContext).toContain('server copy of /srv/app/up2.php is new');
  const files = (await active('dir-A')).claims.find((c) => c.session_id === 'dir-A')!.files;
  expect(files).toContain('root@h9:/srv/app/up2.php');
  expect(files).not.toContain('root@h9:/srv/app');
});
