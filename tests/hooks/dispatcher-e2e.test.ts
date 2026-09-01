// End-to-end test for the production hook entry chain:
//   bin/captain-memo-hook.ts EVENT  →  src/hooks/dispatcher.ts  →  src/hooks/<event>.ts
//
// Per-handler tests spawn `bun src/hooks/<event>.ts` directly, which makes
// the handler the main module — its `import.meta.main` guard is true and
// main() runs as a side-effect of import. That code path is NOT what runs
// in production. This test invokes the real entry file `bin/captain-memo-hook.ts`
// — NOT the legacy extensionless `bin/captain-memo-hook` symlink, which a Windows
// checkout (core.symlinks=false) materializes as a 20-byte text file that `bun`
// then runs as JS (→ "captain is not defined"). It asserts the dispatcher chain
// delivers payloads to the worker, catching any regression where dynamic-import +
// main-guard shape break the wiring. The production-bundled entry
// (dist/captain-memo-hook.js) is covered separately by tests/unit/hook-bundle.test.ts.

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';

// Each hook runs in a THROWAWAY data dir. These hooks write state (the .degraded-<session_id> flag,
// the .worker-transition breadcrumb, .install-version) and default to the real ~/.captain-memo —
// which is how test litter reached a developer's live data dir once already.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'captain-memo-hooktest-'));

import { readFileSync } from 'fs';
import { spawn } from 'bun';

const HOOK_BIN = join(import.meta.dir, '../../bin/captain-memo-hook.ts');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let received: Array<{ path: string; body: any }> = [];
let server: ReturnType<typeof Bun.serve>;
let port = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));
        received.push({ path: url.pathname, body });
        if (url.pathname === '/observation/enqueue') return Response.json({ id: 1, queued: true });
        if (url.pathname === '/observation/flush')   return Response.json({ flushed: 0 });
        if (url.pathname === '/inject/context')      return Response.json({ envelope: '<memory-context></memory-context>' });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ healthy: true });
      }
      return new Response('not found', { status: 404 });
    },
  });
  port = server.port ?? 0;
});

afterAll(() => server.stop());

async function runDispatcher(event: string, input: string) {
  received = [];
  const proc = spawn({
    cmd: ['bun', HOOK_BIN, event],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    // Disable worker self-heal: these tests exercise the dispatch/delivery wiring,
    // not recovery. Without this, the SessionStart case would find /stats unhandled
    // by the stub (404), attempt a real `systemctl start`, and block on the health
    // poll until the test times out.
    env: { ...process.env, CAPTAIN_MEMO_DATA_DIR: TEST_DATA_DIR, CAPTAIN_MEMO_WORKER_PORT: String(port), CAPTAIN_MEMO_DISABLE_SELF_HEAL: '1' },
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

test('dispatcher → PostToolUse delivers RawObservationEvent to /observation/enqueue', async () => {
  const fixture = readFileSync(
    join(import.meta.dir, '../fixtures/hooks/post-tool-use.input.json'),
    'utf-8',
  );
  const { exitCode } = await runDispatcher('PostToolUse', fixture);
  expect(exitCode).toBe(0);
  expect(received).toHaveLength(1);
  expect(received[0]?.path).toBe('/observation/enqueue');
  expect(received[0]?.body.tool_name).toBe('Edit');
});

test('dispatcher → Stop delivers session_id to /observation/flush', async () => {
  const payload = JSON.stringify({ session_id: 'ses_test', stop_hook_active: true });
  const { exitCode } = await runDispatcher('Stop', payload);
  expect(exitCode).toBe(0);
  expect(received).toHaveLength(1);
  expect(received[0]?.path).toBe('/observation/flush');
  expect(received[0]?.body.session_id).toBe('ses_test');
});

test('dispatcher → UserPromptSubmit calls /inject/context AND writes the prompt to stdout', async () => {
  const payload = JSON.stringify({ prompt: 'how does ingest work?', session_id: 'ses_test', cwd: '/tmp' });
  const { exitCode, stdout } = await runDispatcher('UserPromptSubmit', payload);
  expect(exitCode).toBe(0);
  expect(received[0]?.path).toBe('/inject/context');
  // The hook MUST always echo the user's prompt to stdout so Claude Code can
  // forward it to the model — even if the envelope is empty.
  expect(stdout).toContain('how does ingest work?');
});

test('dispatcher → SessionStart pings /health', async () => {
  const payload = JSON.stringify({ session_id: 'ses_test', cwd: '/tmp', source: 'startup' });
  const { exitCode } = await runDispatcher('SessionStart', payload);
  expect(exitCode).toBe(0);
  // SessionStart hits /health (a GET, not a POST). Our stub records POSTs;
  // GETs land but aren't counted in `received`. Exit 0 + no crash is the
  // contract here.
});

test('dispatcher → native Codex aliases use Codex semantics and provenance', async () => {
  const prompt = await runDispatcher('CodexUserPromptSubmit', JSON.stringify({
    session_id: 'codex-session', turn_id: 'turn-1', cwd: '/tmp', prompt: 'original prompt',
  }));
  const promptOutput = JSON.parse(prompt.stdout);
  expect(promptOutput).toMatchObject({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: '<memory-context></memory-context>',
    },
  });
  expect(prompt.stdout).not.toContain('original prompt');

  const post = await runDispatcher('CodexPostToolUse', JSON.stringify({
    session_id: 'codex-session', turn_id: 'turn-1', cwd: '/tmp',
    tool_name: 'apply_patch',
    tool_input: { patch: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' },
    tool_response: { output: 'Done' },
  }));
  expect(post.exitCode).toBe(0);
  expect(received[0]?.body).toMatchObject({
    origin_agent: 'codex', source: 'hook:codex', tool_name: 'apply_patch',
    files_modified: ['src/a.ts'],
  });
  expect(received[0]?.body.prompt_number).toBeGreaterThan(0);

  const stop = await runDispatcher('CodexStop', JSON.stringify({ session_id: 'codex-session' }));
  expect(stop.exitCode).toBe(0);
  expect(stop.stdout).toBe('{}');
});

test('dispatcher → Gemini and Kimi native aliases normalize their vendor payloads', async () => {
  const geminiPrompt = await runDispatcher('GeminiBeforeAgent', JSON.stringify({
    session_id: 'gemini-session', cwd: '/tmp', prompt: 'remember this',
  }));
  expect(JSON.parse(geminiPrompt.stdout).hookSpecificOutput.hookEventName).toBe('BeforeAgent');

  await runDispatcher('GeminiAfterTool', JSON.stringify({
    session_id: 'gemini-session', cwd: '/tmp', tool_name: 'write_file',
    tool_input: { file_path: '/tmp/gemini.ts' }, tool_response: { output: 'ok' },
  }));
  expect(received[0]?.body).toMatchObject({ origin_agent: 'gemini', source: 'hook:gemini' });

  const kimiPrompt = await runDispatcher('KimiUserPromptSubmit', JSON.stringify({
    session_id: 'kimi-session', cwd: '/tmp', prompt: 'remember this too',
  }));
  expect(kimiPrompt.stdout).toBe('<memory-context></memory-context>\n\n');
  expect(kimiPrompt.stdout).not.toContain('remember this too');

  await runDispatcher('KimiPostToolUse', JSON.stringify({
    session_id: 'kimi-session', cwd: '/tmp', tool_name: 'WriteFile',
    tool_input: { file_path: '/tmp/kimi.ts' }, tool_output: 'written',
  }));
  expect(received[0]?.body).toMatchObject({
    origin_agent: 'kimi', source: 'hook:kimi', tool_result_summary: 'written',
  });
  const kimiStop = await runDispatcher('KimiStop', JSON.stringify({ session_id: 'kimi-session' }));
  expect(kimiStop.stdout).toBe('');
});

test('dispatcher → unknown event → exit 0 silently', async () => {
  const { exitCode } = await runDispatcher('NotARealEvent', '{}');
  expect(exitCode).toBe(0);
  expect(received).toHaveLength(0);
});
