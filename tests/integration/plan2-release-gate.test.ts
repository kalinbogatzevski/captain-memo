import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'bun';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

const PORT = 39920;
let worker: WorkerHandle;
let workDir: string;
const HOOK = (name: string) => join(import.meta.dir, `../../src/hooks/${name}.ts`);

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-rg-'));
  const memDir = join(workDir, 'memory');
  mkdirSync(memDir, { recursive: true });
  writeFileSync(
    join(memDir, 'feedback_seed.md'),
    `---\ntype: feedback\ndescription: seed\n---\nNo NULL — use sentinels.`,
  );

  worker = await startWorker({
    port: PORT,
    projectId: 'release-gate',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(memDir, '*.md')],
    watchChannel: 'memory',
    hookBudgetTokens: 2000,
    observationQueueDbPath: join(workDir, 'queue.db'),
    observationsDbPath: join(workDir, 'obs.db'),
    pendingEmbedDbPath: join(workDir, 'pending.db'),
    summarize: async (events) => ({
      type: 'feature',
      title: `Plan-2 stub for ${events.length} events`,
      narrative: 'session test summary',
      facts: events.map(e => `tool=${e.tool_name}`),
      concepts: ['plan-2'],
    }),
    observationTickMs: 0,
  });
  await new Promise(r => setTimeout(r, 600));
});

afterAll(async () => {
  await worker.stop();
  rmSync(workDir, { recursive: true, force: true });
});

async function runHook(script: string, payload: unknown): Promise<{ stdout: string; exitCode: number }> {
  const proc = spawn({
    cmd: ['bun', script],
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: {
      ...process.env,
      CAPTAIN_MEMO_WORKER_PORT: String(PORT),
      // Bun cold-start + fetch may exceed 250ms on dev hardware; loosen for
      // this end-to-end test (production cap remains 250ms).
      CAPTAIN_MEMO_HOOK_TIMEOUT_MS: '2000',
    },
  });
  proc.stdin.write(JSON.stringify(payload));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
}

test('plan2 release-gate — full session round trip', async () => {
  const session_id = 'ses-rg-1';

  // 1. SessionStart
  let r = await runHook(HOOK('session-start'), { session_id, hook_event_name: 'SessionStart', cwd: workDir });
  expect(r.exitCode).toBe(0);

  // 2. UserPromptSubmit — should produce a non-empty envelope
  r = await runHook(HOOK('user-prompt-submit'), {
    session_id, hook_event_name: 'UserPromptSubmit', cwd: workDir,
    prompt: 'when do I use NULL in this codebase?',
    prompt_number: 1,
  });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain('<memory-context');
  expect(r.stdout).toContain('when do I use NULL');

  // 3. PostToolUse × 2
  for (const i of [1, 2]) {
    const x = await runHook(HOOK('post-tool-use'), {
      session_id, hook_event_name: 'PostToolUse', cwd: workDir,
      prompt_number: 1,
      tool_name: i === 1 ? 'Read' : 'Edit',
      tool_input: { file_path: `/tmp/foo-${i}.ts` },
      tool_response: { success: true },
    });
    expect(x.exitCode).toBe(0);
  }

  // 4. Stop — drains
  r = await runHook(HOOK('stop'), { session_id, hook_event_name: 'Stop' });
  expect(r.exitCode).toBe(0);

  // Verify observations landed
  const recent = await fetch(`http://localhost:${PORT}/observations/recent?limit=10`).then(r2 => r2.json()) as any;
  expect(recent.items.length).toBeGreaterThan(0);
  expect(recent.items[0].title).toMatch(/Plan-2 stub/);

  // Stats should now show observation chunks too
  const stats = await fetch(`http://localhost:${PORT}/stats`).then(r2 => r2.json()) as any;
  expect(stats.by_channel.observation ?? 0).toBeGreaterThan(0);
}, 30_000);
