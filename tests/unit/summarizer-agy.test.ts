import { test, expect } from 'bun:test';
import { createAgyTransport, AGY_ACCOUNT_DEFAULT, type SpawnFn } from '../../src/worker/summarizer-agy.ts';

function fakeSpawn(stdout: string, exitCode = 0, stderr = ''): {
  spawn: SpawnFn; lastCmd: string[] | null; lastEnv: Record<string, string> | null;
} {
  let lastCmd: string[] | null = null;
  let lastEnv: Record<string, string> | null = null;
  const stream = (t: string) => new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(t)); c.close(); },
  });
  const spawn: SpawnFn = ({ cmd, env }) => {
    lastCmd = cmd; lastEnv = env;
    return { stdout: stream(stdout), stderr: stream(stderr), exited: Promise.resolve(exitCode) };
  };
  return {
    spawn,
    get lastCmd() { return lastCmd; },
    get lastEnv() { return lastEnv; },
  } as { spawn: SpawnFn; lastCmd: string[] | null; lastEnv: Record<string, string> | null };
}

const JSON_OUT = '{"type":"feature","title":"t","narrative":"n","facts":[],"concepts":[]}';

test('agy transport — returns the printed text and echoes the model', async () => {
  const fake = fakeSpawn(JSON_OUT);
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true });
  const out = await t({ model: 'Gemini 3.5 Flash (Low)', system: 's', user: 'u', max_tokens: 800 });
  expect(out.content).toEqual([{ type: 'text', text: JSON_OUT }]);
  expect(out.model).toBe('Gemini 3.5 Flash (Low)');
});

test('REGRESSION: the prompt is -p\'s VALUE and every other flag comes BEFORE it', async () => {
  // `--print`/`-p` is a STRING flag, not a boolean. Get the order wrong —
  //     agy -p --model "<m>" "<prompt>"
  // and `-p` swallows the literal string "--model" as its prompt. agy then answers
  // "I am running on Gemini 3.5 Flash", discards the real prompt, and EXITS 0. It does
  // not fail; it succeeds against the wrong input. This test is the only thing standing
  // between that bug and someone "tidying" the flag order.
  const fake = fakeSpawn(JSON_OUT);
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true });
  await t({ model: 'Gemini 3.5 Flash (Low)', system: 'SYS', user: 'USR', max_tokens: 800 });
  const cmd = fake.lastCmd!;

  const pIdx = cmd.indexOf('-p');
  expect(pIdx).toBeGreaterThan(-1);
  // The prompt must be the value immediately after -p, and therefore the LAST element.
  expect(cmd[pIdx + 1]).toBe('SYS\n\nUSR');
  expect(pIdx + 1).toBe(cmd.length - 1);
  // Every other flag must precede -p.
  expect(cmd.indexOf('--model')).toBeLessThan(pIdx);
  expect(cmd.indexOf('--sandbox')).toBeLessThan(pIdx);
  expect(cmd[cmd.indexOf('--model') + 1]).toBe('Gemini 3.5 Flash (Low)');
});

test('agy transport — --sandbox is always passed (never execute model-authored commands)', async () => {
  const fake = fakeSpawn(JSON_OUT);
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true });
  await t({ model: AGY_ACCOUNT_DEFAULT, system: 's', user: 'u', max_tokens: 800 });
  expect(fake.lastCmd!).toContain('--sandbox');
});

test('agy transport — runs under an ISOLATED $HOME (protects the user\'s agy history)', async () => {
  // agy has no --ephemeral and no home override: every call persists a conversation
  // (~364 KB). Without this, the summarizer would grow ~/.gemini without bound AND
  // poison `agy --continue` — the user's next `agy -c` would resume a summarizer chat.
  const fake = fakeSpawn(JSON_OUT);
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true, agyHome: '/tmp/cm-agy-test' });
  await t({ model: AGY_ACCOUNT_DEFAULT, system: 's', user: 'u', max_tokens: 800 });
  expect(fake.lastEnv!.HOME).toBe('/tmp/cm-agy-test');
  expect(fake.lastEnv!.HOME).not.toBe(process.env.HOME);
});

test('agy transport — the "default" sentinel omits --model entirely', async () => {
  const fake = fakeSpawn(JSON_OUT);
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true });
  await t({ model: AGY_ACCOUNT_DEFAULT, system: 's', user: 'u', max_tokens: 800 });
  expect(fake.lastCmd!).not.toContain('--model');
});

test('agy transport — an unrecognised model maps to status 404 so the fallback chain walks', async () => {
  const err = 'Error: invalid --model "bogus": model bogus is not recognized as a known model\nAvailable models:\n  Gemini 3.5 Flash (Low)';
  const fake = fakeSpawn('', 1, err);
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true });
  const e = await t({ model: 'bogus', system: 's', user: 'u', max_tokens: 800 })
    .catch((x: Error & { status?: number }) => x);
  expect((e as Error & { status?: number }).status).toBe(404);
});

test('agy transport — a non-model failure does NOT get 404 (must not silently walk the chain)', async () => {
  const fake = fakeSpawn('', 1, 'network unreachable');
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true });
  const e = await t({ model: 'Gemini 3.5 Flash (Low)', system: 's', user: 'u', max_tokens: 800 })
    .catch((x: Error & { status?: number }) => x);
  expect((e as Error & { status?: number }).status).toBeUndefined();
  expect((e as Error).message).toContain('network unreachable');
});

test('agy transport — empty stdout on exit 0 throws rather than yielding an empty observation', async () => {
  const fake = fakeSpawn('', 0);
  const t = createAgyTransport({ spawn: fake.spawn, skipHomeSetup: true });
  const e = await t({ model: 'Gemini 3.5 Flash (Low)', system: 's', user: 'u', max_tokens: 800 })
    .catch((x: Error) => x);
  expect((e as Error).message).toContain('empty stdout');
});
