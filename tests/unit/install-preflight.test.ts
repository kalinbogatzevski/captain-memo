import { test, expect } from 'bun:test';
import { embedderChoices, gatherConfig, hardwareChecks, preflight, readProc, sidecarPlatformCheck } from '../../src/cli/commands/install.ts';
import { totalMemGb } from '../../src/shared/platform.ts';

// macOS has no /proc: the local-sidecar preflight read /proc/cpuinfo and /proc/meminfo unguarded and the installer
// died on ENOENT. Off Linux (null) the SIMD probe is skipped with a WARN and RAM comes from os.totalmem().
test('hardwareChecks — without /proc (macOS): a CPU WARN saying the probe is Linux-only, RAM from os.totalmem()', () => {
  const [cpu, ram] = hardwareChecks(null, null);
  expect(cpu).toMatchObject({ name: 'CPU', status: 'WARN' });
  expect(cpu!.detail).toContain('Linux only');
  expect(ram!.name).toBe('RAM');
  expect(ram!.detail.startsWith(`${totalMemGb().toFixed(1)} GB`)).toBe(true);
});

test('hardwareChecks — with /proc (Linux): the CPU flags and MemTotal are read as before', () => {
  const [cpu, ram] = hardwareChecks('processor\t: 0\nflags\t\t: fpu sse4_2 avx2\n', 'MemTotal:        3145728 kB\n');
  expect(cpu).toMatchObject({ name: 'CPU', status: 'OK', detail: 'x86_64 with AVX2 (fast path)' });
  expect(ram).toMatchObject({ name: 'RAM', status: 'WARN' });
  expect(ram!.detail.startsWith('3.0 GB')).toBe(true);
});

// The crash itself: readProc is what preflight() hands /proc paths to. A path that is not there (/proc on macOS) is null,
// not an ENOENT throw.
test('readProc — a missing /proc file is null, an existing file is its text', () => {
  expect(readProc('/nonexistent-dir/cpuinfo')).toBeNull();
  expect(readProc(import.meta.path)).toContain('readProc');
});

// macOS + local-sidecar could never finish: preflight then FAILed on GNU-only `df -BM /opt`, and install-embedder.sh has
// no Darwin branch. Now it FAILs first, saying what to pick instead, and the menu does not offer it on a Mac.
test('sidecarPlatformCheck — on macOS local-sidecar FAILs with the hosted embedders as the remedy; elsewhere no row', () => {
  const r = sidecarPlatformCheck(true);
  expect(r).toMatchObject({ name: 'Embedder', status: 'FAIL' });
  expect(r!.remedy).toContain('voyage-hosted');
  expect(r!.remedy).toContain('openai-compatible');
  expect(sidecarPlatformCheck(false)).toBeNull();
});

test('embedderChoices — macOS is not offered local-sidecar; Linux/Windows are, and hosted Voyage stays the default', () => {
  expect(embedderChoices(true).map((c) => c.value)).toEqual(['voyage-hosted', 'openai-compatible', 'skip']);
  expect(embedderChoices(false).map((c) => c.value)).toEqual(['voyage-hosted', 'local-sidecar', 'openai-compatible', 'skip']);
  expect(embedderChoices(true)[0]!.recommended).toBe(true);
});

// The wiring, not just the helpers: preflight stops at the Embedder FAIL on a Mac (the Python / CPU / RAM / Disk rows
// after it would fail for the wrong reason), and the wizard's menu is the per-OS one.
// preflight is the POSIX installer's (uname, systemctl); Windows installs through installWindows and never calls it.
test.skipIf(process.platform === 'win32')('preflight — macOS + local-sidecar: exactly one Embedder FAIL and no Python, CPU, RAM, Disk or Network rows', () => {
  const rows = preflight({ wantLocalEmbedder: true }, true);
  expect(rows.filter((r) => r.name === 'Embedder').map((r) => r.status)).toEqual(['FAIL']);
  expect(rows.filter((r) => ['Python', 'CPU', 'RAM', 'Disk (/opt)', 'Network'].includes(r.name))).toEqual([]);
});

test('gatherConfig — the embedder menu is embedderChoices(mac): answer 2 is openai-compatible on macOS, local-sidecar elsewhere', () => {
  const realPrompt = globalThis.prompt;
  const realLog = console.log;
  globalThis.prompt = ((q?: string) => (q?.startsWith('Choose') ? '2' : '')) as typeof prompt;   // '' = every default
  console.log = () => {};
  try {
    const opts = { yes: false, nonInteractive: false, summarizer: 'skip', watch: 'none' } as Parameters<typeof gatherConfig>[1];
    expect(gatherConfig(undefined, opts, true).embedder).toBe('openai-compatible');
    expect(gatherConfig(undefined, opts, false).embedder).toBe('local-sidecar');
  } finally {
    globalThis.prompt = realPrompt;
    console.log = realLog;
  }
});
