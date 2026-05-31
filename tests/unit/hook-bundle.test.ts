import { test, expect } from 'bun:test';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync, rmSync } from 'fs';

const ROOT = join(import.meta.dir, '../..');
const BUNDLE = join(ROOT, 'plugin/dist/captain-memo-hook.js');

// End-to-end proof that the committed hook bundle actually DISPATCHES to a
// handler — not merely that the file exists (that's covered elsewhere).
//
// Regression 8295f08 shipped a bundle whose dispatcher dynamic-imported handler
// SOURCES by a variable specifier; Bun left those as runtime imports resolving
// to non-existent `../hooks/*.ts` beside the bundle, so every hook failed
// `Cannot find module` and silently no-op'd — the SessionStart banner vanished
// and observations froze for hours before anyone noticed (fail-open exit 0 hid it).
//
// UserPromptSubmit is the ideal worker-free probe: regardless of whether the
// worker answers, the handler ALWAYS echoes the original prompt back on stdout
// (`writeStdout(prompt)` runs unconditionally). If the handler never executes,
// stdout is empty. We point the worker at a closed port so the fetch fails fast
// and the test stays hermetic (never touches a real running worker).
test('committed hook bundle dispatches end-to-end (UserPromptSubmit echoes the prompt)', async () => {
  const TOKEN = 'CAPTAIN_MEMO_DISPATCH_PROBE_42';
  const proc = Bun.spawn(['bun', BUNDLE, 'UserPromptSubmit'], {
    stdin: new TextEncoder().encode(JSON.stringify({ prompt: TOKEN })),
    env: {
      ...process.env,
      CAPTAIN_MEMO_WORKER_PORT: '1', // closed port → fetch fails fast, no real worker
      CAPTAIN_MEMO_HOOK_TIMEOUT_MS: '300',
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain(TOKEN);
});

// Degraded-banner contract (v0.2.13): when the worker is unreachable, SessionStart
// must no longer fall silent — it emits a "worker unreachable" banner so the user
// can tell "worker is down" from "the hook regressed" (the ambiguity that made the
// v0.2.3 outage so confusing). Closed worker port (1) forces /stats to fail fast.
test('SessionStart emits a degraded banner (not silence) when the worker is unreachable', async () => {
  const proc = Bun.spawn(['bun', BUNDLE, 'SessionStart'], {
    stdin: new TextEncoder().encode(JSON.stringify({ source: 'startup' })),
    env: {
      ...process.env,
      CAPTAIN_MEMO_WORKER_PORT: '1', // closed → /stats fails fast
      CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS: '300',
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  expect(out).toContain('systemMessage');
  expect(out).toContain('worker unreachable');
});

// Drift guard: the COMMITTED bundle could rot relative to src/hooks/dispatcher.ts
// if someone edits the source and forgets `bun run build:plugin`. The committed-
// bundle test catches a stale/broken artifact; this one catches a regressed
// SOURCE by building fresh from bin/captain-memo-hook.ts into a temp file and
// asserting the same self-contained invariants. It builds its own copy, so it is
// immune to CI's pre-test rebuild (which only runs on Linux) and runs identically
// on every OS. Together the two directions are covered without a brittle byte-for-
// byte comparison (bun's output varies across bun versions).
test('hook bundle built fresh from source is self-contained (guards source regression)', async () => {
  const out = join(tmpdir(), `cm-hook-build-${process.pid}.js`);
  const proc = Bun.spawn(
    ['bun', 'build', join(ROOT, 'bin/captain-memo-hook.ts'), '--target', 'bun', '--outfile', out],
    { cwd: ROOT, stdout: 'ignore', stderr: 'ignore' },
  );
  const code = await proc.exited;
  expect(code).toBe(0);
  try {
    const bundle = readFileSync(out, 'utf-8');
    expect(bundle).toContain('silent envelope on each prompt');
    expect(bundle).toContain('/observation/enqueue');
    expect(bundle).toContain('/inject/context');
    expect(bundle).not.toContain('../hooks/');
  } finally {
    rmSync(out, { force: true });
  }
});
