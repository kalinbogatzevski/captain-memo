import { test, expect } from 'bun:test';
import { createClaudeCodeTransport, type SpawnFn } from '../../src/worker/summarizer-claude-code.ts';

function fakeSpawn(stdoutText: string, exitCode = 0): { spawn: SpawnFn; lastCmd: string[] | null } {
  let lastCmd: string[] | null = null;
  const spawn: SpawnFn = ({ cmd }) => {
    lastCmd = cmd;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdoutText));
        controller.close();
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    return { stdout, stderr, exited: Promise.resolve(exitCode) };
  };
  return { spawn, get lastCmd() { return lastCmd; } } as { spawn: SpawnFn; lastCmd: string[] | null };
}

test('claude-code transport — happy path returns content + echoes model', async () => {
  const fake = fakeSpawn(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: 'hello from claude-code',
  }));
  const t = createClaudeCodeTransport({ spawn: fake.spawn });
  const out = await t({
    model: 'claude-haiku-4-6',
    system: 'sys',
    user: 'usr',
    max_tokens: 200,
  });
  expect(out.content).toEqual([{ type: 'text', text: 'hello from claude-code' }]);
  expect(out.model).toBe('claude-haiku-4-6');
});

test('claude-code transport — passes correct CLI flags', async () => {
  const fake = fakeSpawn(JSON.stringify({ is_error: false, result: 'ok' }));
  const t = createClaudeCodeTransport({ spawn: fake.spawn });
  await t({ model: 'claude-haiku-4-6', system: 'SYS', user: 'USR', max_tokens: 200 });
  const cmd = fake.lastCmd!;
  expect(cmd).toContain('-p');
  expect(cmd).toContain('--model');
  expect(cmd[cmd.indexOf('--model') + 1]).toBe('claude-haiku-4-6');
  expect(cmd[cmd.indexOf('--append-system-prompt') + 1]).toBe('SYS');
  expect(cmd[cmd.indexOf('--output-format') + 1]).toBe('json');
  // user prompt is the last arg
  expect(cmd[cmd.length - 1]).toBe('USR');
});

test('claude-code transport — is_error throws with descriptive message', async () => {
  const fake = fakeSpawn(JSON.stringify({
    is_error: true,
    result: 'something went wrong',
  }));
  const t = createClaudeCodeTransport({ spawn: fake.spawn });
  await expect(t({
    model: 'claude-haiku-4-6', system: '', user: '', max_tokens: 200,
  })).rejects.toThrow(/something went wrong/);
});

test('claude-code transport — model_not_found error maps to status=404', async () => {
  const fake = fakeSpawn(JSON.stringify({
    is_error: true,
    result: 'Error: model_not_found — claude-haiku-9-9 is not a valid model',
  }));
  const t = createClaudeCodeTransport({ spawn: fake.spawn });
  try {
    await t({ model: 'claude-haiku-9-9', system: '', user: '', max_tokens: 200 });
    throw new Error('should have thrown');
  } catch (err) {
    const e = err as Error & { status?: number };
    expect(e.status).toBe(404);
  }
});

test('claude-code transport — empty stdout throws cleanly', async () => {
  const fake = fakeSpawn('', 1);
  const t = createClaudeCodeTransport({ spawn: fake.spawn });
  await expect(t({
    model: 'claude-haiku-4-6', system: '', user: '', max_tokens: 200,
  })).rejects.toThrow(/empty stdout/);
});

test('claude-code transport — invalid JSON throws cleanly', async () => {
  const fake = fakeSpawn('not json at all');
  const t = createClaudeCodeTransport({ spawn: fake.spawn });
  await expect(t({
    model: 'claude-haiku-4-6', system: '', user: '', max_tokens: 200,
  })).rejects.toThrow(/parse JSON/);
});
