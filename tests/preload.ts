// Preloaded before every test file (bunfig.toml [test] preload): keep `bun test` off this machine's REAL state.
//
// Without it, tests ran against the developer's own home: in-process workers loaded the paired-device
// gateway.json (a gateway listener in every worker test) and appended to the real recall-audit.jsonl, digesting
// it at boot (a 6-8 s event-loop block on a 31 MB log); importing mcp-server.ts seeded the real worker.env into
// process.env; spawned SessionStart hooks overwrote the real ~/.codex, ~/.gemini, ~/.cursor skill copies and
// read the live worker's .worker-transition breadcrumb; spawned workers scanned ~/.claude/projects and resolved
// the real summarizer login; and a UserPromptSubmit hook whose /inject/context timed out ran self-heal and
// restarted the LIVE worker (`systemctl --user restart`, seen 2026-09-25). And a developer who had
// CAPTAIN_MEMO_DATA_DIR or CAPTAIN_MEMO_CONFIG_DIR exported in their shell had a plain `bun test` read and write the
// LIVE data and config dirs, because DATA_DIR / CONFIG_DIR honour those variables before the home.
//
// Two halves, because Bun's os.homedir() honours HOME only when the process STARTS (assigning process.env.HOME
// later is ignored, checked on bun 1.4.2):
//   - children (hooks, workers, CLIs spawned with `...process.env`) get HOME / USERPROFILE and self-heal off;
//     a Bun.spawn with no `env` would get the ORIGINAL environment, and no test spawns that way;
//   - this process gets the same scratch home through a module mock of `os`, before any src module imports it.
// And a third thing, because DATA_DIR and CONFIG_DIR derive from that home exactly as in production EXCEPT that an exported
// CAPTAIN_MEMO_DATA_DIR / CAPTAIN_MEMO_CONFIG_DIR wins over the home: both are pinned to the scratch home below. Pinned, not
// deleted, so this process and every child spawned with `...process.env` get the same answer without depending on how each
// resolves a home. NOT covered: a Bun Worker thread started inside a test (src/worker/index.ts notes a threaded writer does
// not see a runtime-set CAPTAIN_MEMO_DATA_DIR), and a Bun.spawn with its own `env`. A test that wants other dirs sets its
// own, as the worker-booting tests do.
import { mock, afterAll } from 'bun:test';
import * as os from 'os';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

const home = mkdtempSync(join(os.tmpdir(), 'cm-test-home-'));
process.env.CAPTAIN_MEMO_TEST_REAL_HOME = os.homedir();   // for tests/unit/test-isolation.test.ts: the one thing it must not reach
process.env.HOME = home;
process.env.USERPROFILE = home;
if (process.platform === 'win32') {
  process.env.APPDATA = join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = join(home, 'AppData', 'Local');
}
process.env.CAPTAIN_MEMO_DATA_DIR = join(home, '.captain-memo');
process.env.CAPTAIN_MEMO_CONFIG_DIR = process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'captain-memo') : join(home, '.config', 'captain-memo');
process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL = '1';
// An opted-in developer environment would make every spawned hook run a real update pass (git, bun install, a service restart).
delete process.env.CAPTAIN_MEMO_AUTO_UPDATE;

const scratchOs = { ...os, homedir: () => home };
mock.module('os', () => ({ ...scratchOs, default: scratchOs }));
mock.module('node:os', () => ({ ...scratchOs, default: scratchOs }));

// A preload-level afterAll runs once after the last file; process 'exit' listeners never fire under `bun test` (1.4.2).
afterAll(() => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ } });
