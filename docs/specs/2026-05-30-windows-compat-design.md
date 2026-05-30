# Captain Memo — Windows Compatibility (v0.2.0)

- **Date:** 2026-05-30
- **Target version:** v0.2.0 (next minor from 0.1.16)
- **Status:** Approved design → implementation
- **Author:** Kalin Bogatzevski (design assisted)

## 1. Summary

Captain Memo's runtime is already portable (Bun, `bun:sqlite` + `sqlite-vec`,
all CLI↔worker↔embedder IPC over **localhost HTTP**, chokidar v4). The work is
almost entirely in the **operational layer** — install / supervise / uninstall /
upgrade / doctor — which is hard-wired to systemd + POSIX shell + GNU coreutils,
plus four concrete blockers. This spec adds a **native Windows** install path
(Bun on PATH, no WSL) supervised by a per-user **Scheduled Task**, defaulting to
**hosted Voyage** embeddings with an **optional local Python sidecar**, and
documents **WSL2** as the fallback. macOS is explicitly out of scope but the
abstractions introduced here are macOS-ready (launchd drops in as one more impl).

## 2. Decisions (locked)

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Target | **Native Windows primary + WSL2 documented fallback** | Native is what the Windows CLI validates; WSL2 covers users who want the local sidecar with zero native work. |
| 2 | Supervision | **Per-user Scheduled Task at logon** (one per daemon) | No admin/UAC; mirrors the rootless `systemd --user` default; autostart + restart-on-failure without a wrapper binary. |
| 3 | Embedder | **Hosted Voyage default; local sidecar ported to PowerShell as opt-in** | Worker reaches embedder purely by HTTP endpoint; `installEmbedder()` only runs for `local-sidecar`. Idiot-proof default = no Python to misconfigure. |
| 4 | Credentials | **`loadWorkerEnv()` env-file loader + `icacls` ACL + `CLAUDE_CODE_OAUTH_TOKEN` override** | Replaces systemd `EnvironmentFile`; guaranteed escape hatch. Credential Manager/DPAPI deferred to v0.3. |
| 5 | Runtime | **Bun-on-Windows only** | Codebase leans on `bun:sqlite`, `Bun.serve`, `Bun.spawn`, `Bun.Glob`, direct `.ts` exec. Node would force a transpile step + SQLite reimplementation for no benefit. |
| 6 | Scope | **Full v0.2.0 incl. local embedder**; defer Credential Manager, WinSW/NSSM Service, `win32-arm64` | User-selected. |

## 3. Architecture — abstraction seams (B+C: interfaces for big seams, helpers for probes)

New modules, each single-purpose, selected by a factory on `process.platform`.
The five management commands call **only** these interfaces — never the OS.

| Module (new) | Interface | Linux impl | Windows impl |
|---|---|---|---|
| `src/services/service-manager/` | `ServiceManager` | `systemd.ts` (`systemctl`) | `windows-scheduled-task.ts` (PowerShell `Register-ScheduledTask`) |
| `src/services/embedder-installer/` | `EmbedderInstaller` | `bash.ts` (wraps `scripts/install-embedder.sh`) | `powershell.ts` (wraps `scripts/install-embedder.ps1`) |
| `src/shared/worker-env.ts` | `loadWorkerEnv()` | reads `worker.env` → `process.env` (both OSes) | same |
| `src/shared/platform.ts` | `isWindows`, `totalMemGb`, `cpuCount`, `diskFreeGb`, `whichBun` | `os.*` / Bun | `os.*` / Bun |

### Interface contracts

```ts
// src/services/service-manager/types.ts
export interface ServiceSpec {
  name: string;            // e.g. 'captain-memo-worker'
  description: string;
  exec: string[];          // argv, e.g. [bunPath, 'src/worker/index.ts']
  workingDir: string;
  envFile?: string;        // Linux: systemd EnvironmentFile; Windows: recorded (loaded in-proc)
  autostart: boolean;      // start at logon/boot
  restartOnFailure: boolean;
  logDir: string;          // where stdout/stderr go (Windows has no journal)
}
export type ServiceState = 'running' | 'stopped' | 'not-installed' | 'failed';
export interface ServiceManager {
  install(spec: ServiceSpec): Promise<void>;
  remove(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string, opts?: { graceful?: boolean; port?: number }): Promise<void>;
  status(name: string): Promise<ServiceState>;
  isActive(name: string): Promise<boolean>;
  enable(name: string): Promise<void>;
  disable(name: string): Promise<void>;
}
// src/services/service-manager/index.ts
export function getServiceManager(): ServiceManager; // systemd on linux, scheduled-task on win32
```

```ts
// src/services/embedder-installer/types.ts
export interface EmbedderInstallOpts { installDir: string; model: string; port: number; }
export interface EmbedderInstaller {
  install(opts: EmbedderInstallOpts): Promise<void>;
  remove(installDir: string): Promise<void>;
}
export function getEmbedderInstaller(): EmbedderInstaller;
```

```ts
// src/shared/worker-env.ts
export function workerEnvPath(): string;   // CONFIG_DIR/worker.env (+ /etc fallback on linux)
export function loadWorkerEnv(): void;      // parse KEY=VAL lines, seed process.env WITHOUT overwriting already-set vars
```

```ts
// src/shared/paths.ts  (additions; DATA_DIR unchanged — already homedir()+join, Windows-correct)
export const CONFIG_DIR = process.env.CAPTAIN_MEMO_CONFIG_DIR ?? (
  process.platform === 'win32'
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'captain-memo')
    : join(homedir(), '.config', 'captain-memo')
);
export const WORKER_ENV_PATH = join(CONFIG_DIR, 'worker.env');
```

## 4. The four blockers → fixes

### 4.1 Supervision (no systemd)
- `WindowsScheduledTaskServiceManager` shells out to PowerShell (prefer `pwsh`,
  fall back to `powershell`) via `Bun.spawn`. `install()` builds:
  `New-ScheduledTaskAction -Execute <bun> -Argument 'src/worker/index.ts' -WorkingDirectory <installDir>`,
  `New-ScheduledTaskTrigger -AtLogOn`,
  `New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit 0`,
  `Register-ScheduledTask -TaskName <name> -Force` (user context, RunLevel Limited — no admin).
- `start/stop` → `Start-ScheduledTask` / `Stop-ScheduledTask`. `stop({graceful,port})`
  first `POST /shutdown` to the worker, waits briefly, then `Stop-ScheduledTask`.
- `status/isActive` → `Get-ScheduledTask`/`Get-ScheduledTaskInfo`, but **liveness for
  doctor uses the HTTP `/health` probe** (authoritative).
- `remove` → `Unregister-ScheduledTask -Confirm:$false`.
- Two daemons when local sidecar is chosen: `captain-memo-worker` + `captain-memo-embed`.
- **Logging:** no journal on Windows → the worker writes its own rotating log file
  in `LOGS_DIR`; the task action runs `bun` directly (no redirect wrapper needed).

### 4.2 Installer hard-fails on non-Linux (`install.ts:142,149,…`)
- Branch on `process.platform`. The win32 path skips `uname`/`which systemctl`/
  `/proc`/`df -BM /opt`/`sudo`/`getent`/`id`; uses `platform.ts` for mem/cpu/disk;
  requires only **Bun on PATH** (+ Python **only if** `local-sidecar` selected).
- Service registration → `getServiceManager().install(...)`.
- Embedder install → `getEmbedderInstaller().install(...)` (only for `local-sidecar`).
- Symlink-into-PATH → drop a `captain-memo.cmd` shim into a user-writable PATH dir
  (e.g. `%LOCALAPPDATA%\captain-memo\bin`, added to user PATH) instead of `symlinkSync`.
- `worker.env` written to `CONFIG_DIR`, locked with `icacls` (NTFS — `0600` is meaningless).

### 4.3 Hook entrypoints use shebang dispatch (`hooks.json`, `bin/captain-memo-hook`)
- Rename `bin/captain-memo-hook` → `bin/captain-memo-hook.ts` (content unchanged —
  preserves the deliberate explicit `main()` call documented in the file header).
- Rewrite all 5 hook commands in `plugin/hooks/hooks.json` to
  `bun "${CLAUDE_PLUGIN_ROOT}/bin/captain-memo-hook.ts" <Event>` and **remove** the
  `"shell": "bash"` pin on SessionStart. Interpreter-explicit, no shebang/extension
  dependence — identical on Linux/Windows.
- `install-hooks.ts` emits the same `bun "<path>.ts" <Event>` form into settings.json.
- MCP entry in `plugin/.claude-plugin/plugin.json` is already correct (`command:bun, args:[...mcp-server.ts]`) — no change.

### 4.4 Secrets never reach the worker (no in-process loader)
- `loadWorkerEnv()` runs at the **top of worker bootstrap** (`src/worker/index.ts`)
  and at MCP/CLI boot, parsing `worker.env` from `WORKER_ENV_PATH` (then
  `/etc/captain-memo/worker.env` on Linux only), seeding `process.env` **without
  overwriting** vars already set (so systemd `EnvironmentFile` and shells still win).
- `summarizer-claude-oauth.ts`: honor a `CLAUDE_CODE_OAUTH_TOKEN` env override
  before falling back to reading `~/.claude/.credentials.json`.
- Default summarizer provider stays `claude-oauth` (its credentials-file read is
  already path-portable); the env override + `anthropic`/`openai-compatible`
  remain the documented escape hatches if the token lives in Credential Manager.

## 5. Smaller portability fixes
- `resolveProjectId` (`src/hooks/shared.ts:124`): split on `/[\\/]/` (or `path.basename`)
  so a Windows `C:\Users\…` cwd keys to the folder name, not the whole path.
- `src/worker/watcher.ts`: build chokidar globs with forward slashes (v4 normalizes).
- Centralize the `worker.env`/config path in `paths.ts` (today hardcoded in
  `install`/`uninstall`/`doctor`).
- `doctor.ts`: replace `systemctl is-active`/`curl` with `ServiceManager.isActive()` +
  `fetch()` `/health`; replace `du`/`df`/`getent` with `platform.ts` / `fs`.
- `vacuum.ts` / `upgrade.ts`: route the stop→mutate→restart dance through
  `ServiceManager` (a third dividend of the abstraction — untangles pre-existing
  inline `systemctl` coupling).
- Optionally bind `Bun.serve` to `127.0.0.1` to avoid the Windows Defender firewall prompt.

## 6. Native dependency
- `sqlite-vec` publishes `sqlite-vec-windows-x64` (`vec0.dll`); the loader already
  maps `win32→dll`. **Constraint:** `bun install` MUST run on the Windows x64 target
  (a Linux-built `node_modules` lacks the DLL). **`win32-arm64` is unsupported** —
  document running x64 Bun under emulation.

## 7. Testing & validation
- **Unit (cross-platform; mock the shell):** `loadWorkerEnv` parser; `resolveProjectId`
  on Windows paths; `windows-scheduled-task` PowerShell command construction;
  `powershell` embedder-installer command construction.
- **CI:** add a `windows-latest` job → `bun install` + a `Database`+`sqliteVec.load`
  smoke test + the unit suite. (Create `.github/workflows/` entry if none exists.)
- **Linux regression:** `systemd` impl must reproduce current `systemctl` behavior
  bit-for-bit; `bun test` + `bun run typecheck` stay green.
- **Manual on the Windows CLI (the real proof):** native `install` (hosted) →
  worker Scheduled Task running → a `UserPromptSubmit`/`Stop` hook fires and writes
  an observation → `/health` green / `doctor` all green → search returns the
  observation → `project_id` equals the folder name. Then optionally repeat with
  `local-sidecar`.

## 8. WSL2 fallback (docs)
README section: enable WSL2, run the **unchanged** Linux installer inside the
distro, run Claude Code inside WSL too. The escape hatch for local-sidecar-heavy
users with zero native-Windows work.

## 9. File change inventory

**New:** `src/shared/platform.ts`, `src/shared/worker-env.ts`,
`src/services/service-manager/{types,systemd,windows-scheduled-task,index}.ts`,
`src/services/embedder-installer/{types,bash,powershell,index}.ts`,
`scripts/install-embedder.ps1`, `bin/captain-memo.cmd`,
`bin/captain-memo-hook.ts` (renamed from `bin/captain-memo-hook`),
tests under `tests/unit/`, this spec.

**Modified:** `src/shared/paths.ts`, `src/cli/commands/{install,uninstall,upgrade,vacuum,doctor,install-hooks}.ts`,
`plugin/hooks/hooks.json`, `src/worker/index.ts` (loadWorkerEnv + `/shutdown` + win logging),
`src/hooks/shared.ts`, `src/worker/watcher.ts`, `src/worker/summarizer-claude-oauth.ts`,
`package.json` (version 0.2.0), `README.md`, `CHANGELOG.md`.

## 10. Risks
- `node_modules` is per-platform → `bun install` must run on Windows (documented).
- `services/embed/requirements.txt` may pin POSIX-only `uvloop`/`httptools` →
  verify/relax for Windows (pip skips them under `uvicorn[standard]` but a hard pin breaks).
- Scheduled Task at logon doesn't run while logged off (acceptable; matches
  `systemd --user` without lingering).
- PowerShell quoting for paths with spaces — construct args as arrays, not string concat.
- `claude-oauth` token may live in Credential Manager on Windows → mitigated by
  the env override + HTTP-key default.

## 11. Acceptance criteria
1. `captain-memo install` completes on Windows x64 (hosted) with **no** systemd/POSIX errors.
2. Worker Scheduled Task is registered, running, survives logoff→logon, restarts on crash.
3. `/health` returns OK; `captain-memo doctor` reports all green via the HTTP probe.
4. A lifecycle hook fires; an observation is written and is retrievable by search.
5. `project_id` equals the project folder name (not the backslash path).
6. (Optional path) `local-sidecar` installs via PowerShell; embedder task alive; embeddings flow.
7. **Linux unchanged:** `bun test` + `bun run typecheck` green; `install/doctor/uninstall`
   behave exactly as before via the `systemd` impl.

## 12. Deferred (v0.3+)
Windows Credential Manager (PowerShell `PasswordVault`/`cmdkey`) + optional DPAPI
key-at-rest; true Windows Service via WinSW/NSSM (the "system tier"); `win32-arm64`
native build; macOS launchd impl (the abstraction is ready for it).
