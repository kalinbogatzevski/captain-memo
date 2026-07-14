import { test, expect } from 'bun:test';
import { createCodexTransport, CODEX_ACCOUNT_DEFAULT, type SpawnFn } from '../../src/worker/summarizer-codex.ts';

/** Stub `codex exec --json`: emits the given JSONL lines on stdout. */
function fakeSpawn(lines: string[], exitCode = 0): { spawn: SpawnFn; lastCmd: string[] | null } {
  let lastCmd: string[] | null = null;
  const spawn: SpawnFn = ({ cmd }) => {
    lastCmd = cmd;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(lines.join('\n')));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    return { stdout, stderr, exited: Promise.resolve(exitCode) };
  };
  return { spawn, get lastCmd() { return lastCmd; } } as { spawn: SpawnFn; lastCmd: string[] | null };
}

const OK_LINES = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"title\\":\\"hi\\"}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10702,"cached_input_tokens":4480,"output_tokens":16}}',
];

test('codex transport — extracts the agent_message and echoes the model', async () => {
  const fake = fakeSpawn(OK_LINES);
  const t = createCodexTransport({ spawn: fake.spawn });
  const out = await t({ model: 'gpt-5.4-mini', system: 'sys', user: 'usr', max_tokens: 800 });
  expect(out.content).toEqual([{ type: 'text', text: '{"title":"hi"}' }]);
  expect(out.model).toBe('gpt-5.4-mini');
});

test('codex transport — reports usage from turn.completed', async () => {
  const fake = fakeSpawn(OK_LINES);
  const t = createCodexTransport({ spawn: fake.spawn });
  const out = await t({ model: 'gpt-5.4-mini', system: 's', user: 'u', max_tokens: 800 });
  // Unlike the claude-code transport, codex reports real token counts — the
  // worker persists these as an observation's work-token cost.
  expect(out.usage).toEqual({ input_tokens: 10702, output_tokens: 16 });
});

test('codex transport — passes the isolation flags that keep summarize cheap', async () => {
  const fake = fakeSpawn(OK_LINES);
  const t = createCodexTransport({ spawn: fake.spawn });
  await t({ model: 'gpt-5.4-mini', system: 'SYS', user: 'USR', max_tokens: 800 });
  const cmd = fake.lastCmd!;
  expect(cmd).toContain('exec');
  expect(cmd).toContain('--json');
  // Without --ignore-user-config the user's ~/.codex/config.toml applies: a high
  // reasoning effort and, worse, their MCP servers get booted on every call.
  expect(cmd).toContain('--ignore-user-config');
  // Without --ephemeral every observation leaves a session file on disk forever.
  expect(cmd).toContain('--ephemeral');
  // The summarizer must never run model-authored writes.
  expect(cmd[cmd.indexOf('--sandbox') + 1]).toBe('read-only');
  expect(cmd[cmd.indexOf('-m') + 1]).toBe('gpt-5.4-mini');
  // Codex has no system-prompt flag — system and user ride the one positional.
  expect(cmd[cmd.length - 1]).toBe('SYS\n\nUSR');
});

test('codex transport — the "default" sentinel omits -m entirely', async () => {
  const fake = fakeSpawn(OK_LINES);
  const t = createCodexTransport({ spawn: fake.spawn });
  await t({ model: CODEX_ACCOUNT_DEFAULT, system: 's', user: 'u', max_tokens: 800 });
  // This is the terminal fallback: a ChatGPT account gates models server-side,
  // so "send no model" is the only candidate that can never 400.
  expect(fake.lastCmd!).not.toContain('-m');
});

test('codex transport — a rejected model maps to status 404 so the fallback chain walks', async () => {
  const inner = JSON.stringify({
    type: 'error', status: 400,
    error: { type: 'invalid_request_error', message: "The 'gpt-5.4-nano' model is not supported when using Codex with a ChatGPT account." },
  });
  const fake = fakeSpawn([
    '{"type":"turn.started"}',
    JSON.stringify({ type: 'error', message: inner }),
    JSON.stringify({ type: 'turn.failed', error: { message: inner } }),
  ], 1);
  const t = createCodexTransport({ spawn: fake.spawn });
  const err = await t({ model: 'gpt-5.4-nano', system: 's', user: 'u', max_tokens: 800 }).catch((e: Error & { status?: number }) => e);
  expect(err).toBeInstanceOf(Error);
  // Summarizer.summarize() only walks to the next candidate on status 404.
  expect((err as Error & { status?: number }).status).toBe(404);
});

test('codex transport — a non-model error does NOT get 404 (must not silently walk the chain)', async () => {
  const fake = fakeSpawn([
    '{"type":"turn.started"}',
    JSON.stringify({ type: 'error', message: 'stream disconnected before completion' }),
  ], 1);
  const t = createCodexTransport({ spawn: fake.spawn });
  const err = await t({ model: 'gpt-5.4-mini', system: 's', user: 'u', max_tokens: 800 }).catch((e: Error & { status?: number }) => e);
  expect((err as Error & { status?: number }).status).toBeUndefined();
  expect((err as Error).message).toContain('stream disconnected');
});

test('codex transport — empty stdout throws rather than returning an empty observation', async () => {
  const fake = fakeSpawn([], 127);
  const t = createCodexTransport({ spawn: fake.spawn });
  const err = await t({ model: 'gpt-5.4-mini', system: 's', user: 'u', max_tokens: 800 }).catch((e: Error) => e);
  expect((err as Error).message).toContain('no agent_message');
});

test('codex transport — tolerates non-JSON notice lines interleaved in the stream', async () => {
  const fake = fakeSpawn(['Reading additional input from stdin...', ...OK_LINES]);
  const t = createCodexTransport({ spawn: fake.spawn });
  const out = await t({ model: 'gpt-5.4-mini', system: 's', user: 'u', max_tokens: 800 });
  expect(out.content[0]!.text).toBe('{"title":"hi"}');
});
