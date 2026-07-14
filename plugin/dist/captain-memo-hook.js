#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/shared/paths.ts
import { homedir } from "os";
import { join } from "path";
var DATA_DIR, META_DB_PATH, QUEUE_DB_PATH, OBSERVATIONS_DB_PATH, PENDING_EMBED_DB_PATH, VECTOR_DB_DIR, LOGS_DIR, ARCHIVE_DIR, CONFIG_PATH, CONFIG_DIR, WORKER_ENV_PATH, DEFAULT_WORKER_PORT = 39888, ENV_HOOK_TIMEOUT_MS = "CAPTAIN_MEMO_HOOK_TIMEOUT_MS", DEFAULT_HOOK_TIMEOUT_MS = 1500, DEFAULT_STOP_DRAIN_BUDGET_MS = 5000, DEFAULT_REMEMBER_DIR;
var init_paths = __esm(() => {
  DATA_DIR = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), ".captain-memo");
  META_DB_PATH = join(DATA_DIR, "meta.sqlite3");
  QUEUE_DB_PATH = join(DATA_DIR, "queue.db");
  OBSERVATIONS_DB_PATH = join(DATA_DIR, "observations.db");
  PENDING_EMBED_DB_PATH = join(DATA_DIR, "pending_embed.db");
  VECTOR_DB_DIR = join(DATA_DIR, "vector-db");
  LOGS_DIR = join(DATA_DIR, "logs");
  ARCHIVE_DIR = join(DATA_DIR, "archive");
  CONFIG_PATH = join(DATA_DIR, "config.json");
  CONFIG_DIR = process.env.CAPTAIN_MEMO_CONFIG_DIR ?? (process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "captain-memo") : join(homedir(), ".config", "captain-memo"));
  WORKER_ENV_PATH = join(CONFIG_DIR, "worker.env");
  DEFAULT_REMEMBER_DIR = join(homedir(), ".claude", "memory");
});

// src/hooks/shared.ts
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
function rotateIfNeeded() {
  try {
    if (!existsSync(HOOK_LOG_FILE))
      return;
    const sz = statSync(HOOK_LOG_FILE).size;
    if (sz < HOOK_LOG_ROTATE_BYTES)
      return;
    renameSync(HOOK_LOG_FILE, HOOK_LOG_FILE + ".1");
  } catch {}
}
function logHookError(event, err) {
  try {
    mkdirSync(HOOK_LOG_DIR, { recursive: true });
    rotateIfNeeded();
    const e = err;
    const line = `${new Date().toISOString()} [${event}] ${e?.name ?? "Error"}: ${e?.message ?? String(err)}
${e?.stack ?? ""}
`;
    appendFileSync(HOOK_LOG_FILE, line);
    if (process.env.CAPTAIN_MEMO_HOOK_DEBUG === "1") {
      process.stderr.write(line);
    }
  } catch {}
}
async function readStdinJson() {
  const text = await Bun.stdin.text();
  if (!text || !text.trim())
    return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`hook: failed to parse stdin JSON: ${err.message}`);
  }
}
function writeStdout(s) {
  process.stdout.write(s);
}
async function workerFetch(path, opts) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const init = {
      method: opts.method ?? "GET",
      signal: controller.signal
    };
    if (opts.body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(`${WORKER_BASE}${path}`, init);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, body: null, timedOut: false, errorMessage: `${res.status}: ${txt}` };
    }
    const body = await res.json();
    return { ok: true, status: res.status, body, timedOut: false, errorMessage: null };
  } catch (err) {
    const e = err;
    const timedOut = e.name === "AbortError" || /aborted/i.test(e.message);
    return { ok: false, status: 0, body: null, timedOut, errorMessage: e.message };
  } finally {
    clearTimeout(timer);
  }
}
function workerFailureMessage(path, res) {
  if (res.ok)
    return null;
  const detail = res.timedOut ? "timed out" : res.errorMessage ?? `status ${res.status}`;
  return `worker ${path} failed: ${detail}`;
}
function logWorkerFailure(event, path, res) {
  const msg = workerFailureMessage(path, res);
  if (msg)
    logHookError(event, new Error(msg));
}
function resolveProjectId(cwd) {
  if (process.env.CAPTAIN_MEMO_PROJECT_ID)
    return process.env.CAPTAIN_MEMO_PROJECT_ID;
  if (!cwd)
    return "default";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "default";
}
function clamp(s, max) {
  if (typeof s !== "string")
    return "";
  const points = [...s];
  if (points.length <= max)
    return s;
  return points.slice(0, max - 1).join("") + "\u2026";
}
function summarize(value, max = 1500) {
  try {
    return clamp(typeof value === "string" ? value : JSON.stringify(value), max);
  } catch {
    return "[unserializable]";
  }
}
var HOOK_LOG_DIR, HOOK_LOG_FILE, HOOK_LOG_ROTATE_BYTES, WORKER_BASE;
var init_shared = __esm(() => {
  init_paths();
  HOOK_LOG_DIR = join2(homedir2(), ".captain-memo", "logs");
  HOOK_LOG_FILE = join2(HOOK_LOG_DIR, "hook.log");
  HOOK_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
  WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;
});

// src/shared/worker-heal-lock.ts
var exports_worker_heal_lock = {};
__export(exports_worker_heal_lock, {
  releaseHealLock: () => releaseHealLock,
  acquireHealLock: () => acquireHealLock,
  HEAL_LOCK_TTL_MS: () => HEAL_LOCK_TTL_MS,
  HEAL_LOCK_PATH: () => HEAL_LOCK_PATH
});
import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from "fs";
import { join as join3 } from "path";
function acquireHealLock(lockPath = HEAL_LOCK_PATH, now = Date.now()) {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(now));
    closeSync(fd);
    return true;
  } catch {
    try {
      const stamp = Number(readFileSync(lockPath, "utf-8").trim());
      const age = now - (Number.isFinite(stamp) ? stamp : 0);
      if (age > HEAL_LOCK_TTL_MS) {
        unlinkSync(lockPath);
        const fd = openSync(lockPath, "wx");
        writeSync(fd, String(now));
        closeSync(fd);
        return true;
      }
    } catch {}
    return false;
  }
}
function releaseHealLock(lockPath = HEAL_LOCK_PATH) {
  try {
    unlinkSync(lockPath);
  } catch {}
}
var HEAL_LOCK_PATH, HEAL_LOCK_TTL_MS = 20000;
var init_worker_heal_lock = __esm(() => {
  init_paths();
  HEAL_LOCK_PATH = join3(DATA_DIR, ".worker-heal.lock");
});

// src/shared/worker-health-probe.ts
var exports_worker_health_probe = {};
__export(exports_worker_health_probe, {
  probeHealthyWithRetries: () => probeHealthyWithRetries,
  probeHealthOnce: () => probeHealthOnce
});
async function probeHealthOnce(port, timeoutMs = 3000) {
  const ctl = new AbortController;
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
    if (!r.ok)
      return false;
    const body = await r.json().catch(() => null);
    return body?.healthy === true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}
async function probeHealthyWithRetries(probeOnce, attempts = 3, gapMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let i = 0;i < attempts; i++) {
    if (await probeOnce())
      return true;
    if (i < attempts - 1)
      await sleep(gapMs);
  }
  return false;
}

// src/services/service-manager/systemd.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync, writeFileSync } from "fs";
import { homedir as homedir3 } from "os";
import { join as join4, resolve } from "path";
import { spawnSync } from "child_process";
function unitName(name) {
  return name.endsWith(".service") ? name : `${name}.service`;
}
function templateFor(name) {
  const bare = name.replace(/\.service$/, "");
  if (bare === "captain-memo-embed") {
    return join4(REPO_ROOT, "services/embed/systemd/captain-memo-embed.user.service");
  }
  return join4(REPO_ROOT, "services/worker/systemd/captain-memo-worker.user.service");
}
function systemctl(args) {
  const userR = spawnSync("systemctl", ["--user", ...args], { encoding: "utf-8", timeout: 1e4 });
  if (userR.status === 0)
    return userR;
  const stderr = userR.stderr ?? "";
  const noUserManager = userR.error != null || /Failed to connect to (the )?bus/i.test(stderr) || /No medium found/i.test(stderr);
  if (!noUserManager)
    return userR;
  return spawnSync("systemctl", [...args], { encoding: "utf-8", timeout: 1e4 });
}

class SystemdServiceManager {
  async install(spec) {
    const tpl = templateFor(spec.name);
    if (!existsSync2(tpl))
      throw new Error(`missing systemd unit template: ${tpl}`);
    const bun = spec.exec[0] ?? "bun";
    const unit = readFileSync2(tpl, "utf-8").replaceAll("__INSTALL_DIR__", spec.workingDir).replaceAll("__ENV_FILE__", spec.envFile ?? "").replaceAll("__BUN__", bun);
    if (!existsSync2(USER_SYSTEMD_DIR))
      mkdirSync2(USER_SYSTEMD_DIR, { recursive: true });
    writeFileSync(join4(USER_SYSTEMD_DIR, unitName(spec.name)), unit, { mode: 420 });
    systemctl(["daemon-reload"]);
    if (spec.autostart)
      systemctl(["enable", unitName(spec.name)]);
    systemctl(["restart", unitName(spec.name)]);
  }
  async remove(name) {
    systemctl(["stop", unitName(name)]);
    systemctl(["disable", unitName(name)]);
    const unitPath = join4(USER_SYSTEMD_DIR, unitName(name));
    if (existsSync2(unitPath))
      rmSync(unitPath, { force: true });
    systemctl(["daemon-reload"]);
  }
  async start(name) {
    const r = systemctl(["start", unitName(name)]);
    if (r.status !== 0) {
      throw new Error(`systemctl start ${unitName(name)} failed (status ${r.status ?? "?"}): ` + `${(r.stderr ?? "").trim() || r.error?.message || "no stderr"}`);
    }
  }
  async restart(name, _opts) {
    const r = systemctl(["restart", unitName(name)]);
    if (r.status !== 0) {
      throw new Error(`systemctl restart ${unitName(name)} failed (status ${r.status ?? "?"}): ` + `${(r.stderr ?? "").trim() || r.error?.message || "no stderr"}`);
    }
  }
  async stop(name, opts) {
    if (opts?.graceful) {
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      const ctl = new AbortController;
      const t = setTimeout(() => ctl.abort(), 3000);
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", signal: ctl.signal });
      } catch {} finally {
        clearTimeout(t);
      }
    }
    const r = systemctl(["stop", unitName(name)]);
    if (r.status !== 0) {
      throw new Error(`systemctl stop ${unitName(name)} failed (status ${r.status ?? "?"}): ` + `${(r.stderr ?? "").trim() || r.error?.message || "no stderr"}`);
    }
  }
  async status(name) {
    if (await this.isActive(name))
      return "running";
    const lu = systemctl(["list-unit-files", unitName(name)]);
    const installed = (lu.stdout ?? "").includes(unitName(name));
    if (!installed)
      return "not-installed";
    const failed = systemctl(["is-failed", unitName(name)]);
    if ((failed.stdout ?? "").trim() === "failed")
      return "failed";
    return "stopped";
  }
  async isActive(name) {
    const r = systemctl(["is-active", unitName(name)]);
    return (r.stdout ?? "").trim() === "active";
  }
  async enable(name) {
    systemctl(["enable", unitName(name)]);
  }
  async disable(name) {
    systemctl(["disable", unitName(name)]);
  }
}
function createSystemdServiceManager() {
  return new SystemdServiceManager;
}
var REPO_ROOT, USER_SYSTEMD_DIR;
var init_systemd = __esm(() => {
  init_paths();
  REPO_ROOT = resolve(import.meta.dir, "../../..");
  USER_SYSTEMD_DIR = join4(homedir3(), ".config/systemd/user");
});

// src/services/service-manager/windows-scheduled-task.ts
import { writeFileSync as writeFileSync2, rmSync as rmSync2 } from "fs";
import { tmpdir } from "os";
import { join as join5 } from "path";
function psSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function isoDuration(totalSeconds) {
  const s = Math.max(1, Math.floor(totalSeconds));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  let out = "PT";
  if (mins > 0)
    out += `${mins}M`;
  if (secs > 0 || mins === 0)
    out += `${secs}S`;
  return out;
}
function buildArgumentString(exec) {
  return exec.slice(1).map((tok) => /\s/.test(tok) ? `"${tok}"` : tok).join(" ");
}
function buildTaskXml(spec) {
  const exe = spec.exec[0] ?? "bun";
  const argString = buildArgumentString(spec.exec);
  const settings = spec.restartOnFailure ? [
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <Enabled>true</Enabled>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>3</Count>",
    "    </RestartOnFailure>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "  </Settings>"
  ] : [
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <Enabled>true</Enabled>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "  </Settings>"
  ];
  const execLines = [
    "    <Exec>",
    `      <Command>${xmlEscape(exe)}</Command>`
  ];
  if (argString.length > 0)
    execLines.push(`      <Arguments>${xmlEscape(argString)}</Arguments>`);
  execLines.push(`      <WorkingDirectory>${xmlEscape(spec.workingDir)}</WorkingDirectory>`);
  execLines.push("    </Exec>");
  const userId = xmlEscape(`${process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? ""}\\${process.env.USERNAME ?? ""}`);
  const watchdogInterval = isoDuration(spec.watchdogIntervalSec ?? 300);
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEscape(spec.description)}</Description>`,
    `    <URI>\\${xmlEscape(spec.name)}</URI>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    `      <UserId>${userId}</UserId>`,
    "    </LogonTrigger>",
    "    <TimeTrigger>",
    "      <Enabled>true</Enabled>",
    "      <StartBoundary>2020-01-01T00:00:00</StartBoundary>",
    "      <Repetition>",
    `        <Interval>${watchdogInterval}</Interval>`,
    "        <StopAtDurationEnd>false</StopAtDurationEnd>",
    "      </Repetition>",
    "    </TimeTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    `      <UserId>${userId}</UserId>`,
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    ...settings,
    '  <Actions Context="Author">',
    ...execLines,
    "  </Actions>",
    "</Task>"
  ];
  return lines.join(`
`);
}
async function runPowerShell(command) {
  for (const shell of ["pwsh", "powershell"]) {
    try {
      const proc = Bun.spawn([shell, ...PS_PREFIX_ARGS, command], {
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text()
      ]);
      const exitCode = await proc.exited;
      return { exitCode, stdout, stderr };
    } catch {
      continue;
    }
  }
  throw new Error("neither pwsh nor powershell is available on PATH");
}
async function runSchtasks(args) {
  const proc = Bun.spawn(["schtasks", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}
function buildReclaimPortCommand(port, timeoutMs = 5000) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`buildReclaimPortCommand: invalid port ${port} (expected integer 1-65535)`);
  }
  const deadlineMs = Math.max(0, Math.floor(timeoutMs));
  return [
    `$ErrorActionPreference='SilentlyContinue'`,
    `$deadline=(Get-Date).AddMilliseconds(${deadlineMs})`,
    `do {`,
    `  $owners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)`,
    `  if ($owners.Count -eq 0) { break }`,
    `  foreach ($ownerPid in $owners) {`,
    `    $proc=Get-Process -Id $ownerPid -ErrorAction SilentlyContinue`,
    `    if ($proc -and $proc.ProcessName -eq 'bun') { Stop-Process -Id $ownerPid -Force }`,
    `  }`,
    `  Start-Sleep -Milliseconds 200`,
    `} while ((Get-Date) -lt $deadline)`
  ].join(`
`);
}
function toTaskXmlBuffer(xml) {
  return Buffer.from("\uFEFF" + xml, "utf16le");
}

class WindowsScheduledTaskServiceManager {
  async install(spec) {
    const xml = buildTaskXml(spec);
    const xmlPath = join5(tmpdir(), `captain-memo-task-${spec.name}-${process.pid}-${Date.now()}.xml`);
    writeFileSync2(xmlPath, toTaskXmlBuffer(xml));
    try {
      const r = await runSchtasks(["/Create", "/TN", spec.name, "/XML", xmlPath, "/F"]);
      if (r.exitCode !== 0) {
        throw new Error(`schtasks /Create failed for ${spec.name}: ${r.stderr.trim() || r.stdout.trim()}`);
      }
    } finally {
      try {
        rmSync2(xmlPath, { force: true });
      } catch {}
    }
  }
  async remove(name) {
    await runPowerShell(`Unregister-ScheduledTask -TaskName ${psSingleQuote(name)} -Confirm:$false -ErrorAction SilentlyContinue`);
  }
  async start(name) {
    const r = await runPowerShell(`Start-ScheduledTask -TaskName ${psSingleQuote(name)}`);
    if (r.exitCode !== 0) {
      throw new Error(`Start-ScheduledTask ${name} failed (exit ${r.exitCode}): ${r.stderr.trim() || "no stderr"}`);
    }
  }
  async restart(name, opts) {
    await this.stop(name, { ...opts, force: true });
    await this.start(name);
  }
  async stop(name, opts) {
    if (opts?.graceful) {
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      const ctl = new AbortController;
      const t = setTimeout(() => ctl.abort(), 3000);
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", signal: ctl.signal });
      } catch {} finally {
        clearTimeout(t);
      }
    }
    const r = await runPowerShell(`Stop-ScheduledTask -TaskName ${psSingleQuote(name)}`);
    if (r.exitCode !== 0) {
      throw new Error(`Stop-ScheduledTask ${name} failed (exit ${r.exitCode}): ${r.stderr.trim() || "no stderr"}`);
    }
    if (opts?.force) {
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      try {
        await runPowerShell(buildReclaimPortCommand(port));
      } catch {}
    }
  }
  async status(name) {
    const q = psSingleQuote(name);
    const command = `$ErrorActionPreference='Stop'; ` + `try { $t = Get-ScheduledTask -TaskName ${q}; ` + `Get-ScheduledTaskInfo -TaskName ${q} | Out-Null; ` + `Write-Output $t.State } ` + `catch { Write-Output 'NotInstalled' }`;
    const r = await runPowerShell(command);
    const state = r.stdout.trim();
    if (state === "NotInstalled")
      return "not-installed";
    if (state === "Running")
      return "running";
    return "stopped";
  }
  async isActive(name) {
    return await this.status(name) === "running";
  }
  async enable(name) {
    await runPowerShell(`Enable-ScheduledTask -TaskName ${psSingleQuote(name)}`);
  }
  async disable(name) {
    await runPowerShell(`Disable-ScheduledTask -TaskName ${psSingleQuote(name)}`);
  }
}
function createWindowsScheduledTaskServiceManager() {
  return new WindowsScheduledTaskServiceManager;
}
var PS_PREFIX_ARGS;
var init_windows_scheduled_task = __esm(() => {
  init_paths();
  PS_PREFIX_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];
});

// src/services/service-manager/index.ts
var exports_service_manager = {};
__export(exports_service_manager, {
  getServiceManager: () => getServiceManager
});
function getServiceManager() {
  return process.platform === "win32" ? createWindowsScheduledTaskServiceManager() : createSystemdServiceManager();
}
var init_service_manager = __esm(() => {
  init_systemd();
  init_windows_scheduled_task();
});

// src/shared/worker-control.ts
var exports_worker_control = {};
__export(exports_worker_control, {
  restartWorker: () => restartWorker
});
async function restartWorker(sm, name, opts) {
  await sm.restart(name, { graceful: opts.graceful ?? false, port: opts.port, force: true });
}

// src/worker/branch.ts
import { spawnSync as spawnSync2 } from "child_process";
import { existsSync as existsSync3 } from "fs";
function detectBranchSync(cwd) {
  if (!existsSync3(cwd))
    return null;
  try {
    const result = spawnSync2("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0)
      return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
function detectRepoRootSync(cwd) {
  if (!existsSync3(cwd))
    return null;
  try {
    const result = spawnSync2("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0)
      return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
var branchCache, repoRootCache, dirtyCache;
var init_branch = __esm(() => {
  branchCache = new Map;
  repoRootCache = new Map;
  dirtyCache = new Map;
});

// src/hooks/pre-git.ts
var exports_pre_git = {};
__export(exports_pre_git, {
  runPreGit: () => runPreGit,
  parseGitOp: () => parseGitOp
});
function parseGitOp(command) {
  if (typeof command !== "string")
    return null;
  for (const seg of command.split(/&&|\|\||;|\|/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]))
      i++;
    if (toks[i] !== "git")
      continue;
    let j = i + 1;
    while (j < toks.length && toks[j].startsWith("-")) {
      const flag = toks[j];
      j++;
      if (flag === "-C" || flag === "-c")
        j++;
    }
    const sub = toks[j];
    if (sub && MUTATING.test(sub))
      return sub;
  }
  return null;
}
async function runPreGit(payload) {
  const op = parseGitOp(typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "");
  if (!op || !payload.cwd)
    return;
  const root = detectRepoRootSync(payload.cwd);
  if (!root || root.includes("/claude-1000/"))
    return;
  const res = await workerFetch(`/worknote/repo-active?repo_root=${encodeURIComponent(root)}`, { method: "GET", timeoutMs: HOOK_TIMEOUT_MS });
  if (!res.ok || !res.body?.holders)
    return;
  const peers = res.body.holders.filter((h) => h.session_id !== payload.session_id);
  if (peers.length === 0)
    return;
  const who = peers.map((h) => `${(h.session_id ?? "").slice(0, 12)} (${h.agent ?? "?"})${h.branch ? ` on ${h.branch}` : ""}${h.is_dirty ? ", dirty" : ""}`).join(" ; ");
  const warning = `WORK-BOARD SHARED CHECKOUT: peer session(s) are using ${root} \u2014 ${who}. Running \`git ${op}\` here changes that shared working tree for them. Isolate instead: \`git worktree add ../<name> <branch>\` and work there. (advisory)`;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warning } }));
}
var MUTATING, HOOK_TIMEOUT_MS;
var init_pre_git = __esm(() => {
  init_shared();
  init_branch();
  MUTATING = /^(checkout|switch|commit|reset|stash|rebase|merge|cherry-pick|clean|restore)$/;
  HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
});

// src/hooks/dispatcher.ts
init_shared();

// src/hooks/user-prompt-submit.ts
init_shared();
init_paths();
async function main() {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("UserPromptSubmit", err);
    return;
  }
  const prompt = payload.prompt ?? "";
  const timeoutMs = Number(process.env[ENV_HOOK_TIMEOUT_MS] ?? DEFAULT_HOOK_TIMEOUT_MS);
  const result = await workerFetch("/inject/context", {
    method: "POST",
    body: {
      prompt,
      top_k: 5,
      session_id: payload.session_id,
      project_id: resolveProjectId(payload.cwd)
    },
    timeoutMs
  });
  logWorkerFailure("UserPromptSubmit", "/inject/context", result);
  if (!result.ok && process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL !== "1") {
    try {
      const { acquireHealLock: acquireHealLock2, releaseHealLock: releaseHealLock2 } = await Promise.resolve().then(() => (init_worker_heal_lock(), exports_worker_heal_lock));
      if (acquireHealLock2()) {
        try {
          const { probeHealthOnce: probeHealthOnce2, probeHealthyWithRetries: probeHealthyWithRetries2 } = await Promise.resolve().then(() => exports_worker_health_probe);
          const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
          const reachable = await probeHealthyWithRetries2(() => probeHealthOnce2(port, 1500), 2, 1000);
          if (!reachable) {
            const { getServiceManager: getServiceManager2 } = await Promise.resolve().then(() => (init_service_manager(), exports_service_manager));
            const { restartWorker: restartWorker2 } = await Promise.resolve().then(() => exports_worker_control);
            await restartWorker2(getServiceManager2(), "captain-memo-worker", { port });
          }
        } finally {
          releaseHealLock2();
        }
      }
    } catch (err) {
      logHookError("UserPromptSubmit", err);
    }
  }
  if (result.ok && result.body && result.body.envelope) {
    writeStdout(result.body.envelope);
    writeStdout(`

`);
  }
  writeStdout(prompt);
}
if (false) {}

// src/hooks/session-start.ts
init_shared();
init_paths();
// package.json
var package_default = {
  name: "captain-memo",
  version: "0.24.0",
  description: "Cross-AI local memory layer (Claude Code, Codex, Gemini, Cursor) \u2014 Voyage-embedded, hybrid search",
  type: "module",
  private: true,
  license: "Apache-2.0",
  author: {
    name: "Kalin Bogatzevski",
    url: "https://github.com/kalinbogatzevski"
  },
  homepage: "https://github.com/kalinbogatzevski/captain-memo",
  repository: {
    type: "git",
    url: "https://github.com/kalinbogatzevski/captain-memo.git"
  },
  bugs: {
    url: "https://github.com/kalinbogatzevski/captain-memo/issues"
  },
  keywords: [
    "claude-code",
    "claude-code-plugin",
    "memory",
    "rag",
    "embeddings",
    "voyage-ai",
    "sqlite-vec",
    "mcp",
    "anthropic"
  ],
  engines: {
    bun: ">=1.1.14"
  },
  bin: {
    "captain-memo": "./bin/captain-memo"
  },
  scripts: {
    test: "bun test",
    "test:unit": "bun test tests/unit/",
    "test:integration": "bun test tests/integration/",
    "test:hooks": "bun test tests/hooks/",
    typecheck: "tsc --noEmit",
    "worker:start": "bun src/worker/index.ts",
    "worker:dev": "CAPTAIN_MEMO_DATA_DIR=./.captain-memo.dev bun --watch src/worker/index.ts",
    "mcp:start": "bun src/mcp-server.ts",
    cli: "bun bin/captain-memo",
    hook: "bun bin/captain-memo-hook.ts",
    "build:plugin": "bun build src/mcp-server.ts --target bun --outfile plugin/dist/mcp-server.js && bun build bin/captain-memo-hook.ts --target bun --outfile plugin/dist/captain-memo-hook.js"
  },
  dependencies: {
    "@anthropic-ai/sdk": "^0.95.0",
    "@modelcontextprotocol/sdk": "^1.25.1",
    chokidar: "^4.0.3",
    "gpt-tokenizer": "^2.5.1",
    nanoid: "^5.0.7",
    "sqlite-vec": "^0.1.9",
    zod: "^3.24.0"
  },
  devDependencies: {
    "@types/bun": "^1.1.0",
    "@types/node": "^20.0.0",
    typescript: "^5.6.0"
  }
};

// src/shared/version.ts
var VERSION = package_default.version;

// src/shared/self-update.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3, renameSync as renameSync2 } from "fs";
import { join as join6 } from "path";
var MARKER_FILENAME = ".install-version";
function compareSemver(a, b) {
  const parse = (v) => v.replace(/^v/i, "").split("+")[0].split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0;i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db)
      return 1;
    if (da < db)
      return -1;
  }
  return 0;
}
function decideUpdateAction(running, marker) {
  if (marker === null)
    return "first-run";
  return compareSemver(running, marker) > 0 ? "upgraded" : "same-or-older";
}
function formatUpgradeBanner(from, to) {
  return [
    `\u2693 Captain Memo self-upgraded: v${from} \u2192 v${to}`,
    "  The worker restarts automatically to pick up the new version.",
    "  Run `captain-memo install` if you want a full refresh (hooks/MCP/services)."
  ].join(`
`);
}
function markerPath(dataDir) {
  return join6(dataDir, MARKER_FILENAME);
}
function readMarker(dataDir) {
  try {
    const raw = readFileSync3(markerPath(dataDir), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
function writeMarker(dataDir, version) {
  try {
    mkdirSync3(dataDir, { recursive: true });
    const final = markerPath(dataDir);
    const tmp = `${final}.tmp-${process.pid}`;
    writeFileSync3(tmp, `${version}
`, "utf-8");
    renameSync2(tmp, final);
  } catch {}
}
function consumeUpgradeNotice(dataDir, runningVersion) {
  try {
    const marker = readMarker(dataDir);
    const action = decideUpdateAction(runningVersion, marker);
    if (action === "same-or-older")
      return "";
    writeMarker(dataDir, runningVersion);
    return action === "upgraded" ? formatUpgradeBanner(marker, runningVersion) : "";
  } catch {
    return "";
  }
}

// src/shared/worker-health.ts
async function ensureWorkerHealthy(deps) {
  const version = await deps.probeVersion();
  if (version !== null && version === deps.diskVersion) {
    return { action: "none", reason: "healthy" };
  }
  if (!deps.acquireLock()) {
    return { action: "skipped", reason: "lock-held" };
  }
  try {
    if (version === null) {
      try {
        await deps.start();
      } catch (e) {
        return { action: "failed", reason: "unreachable", error: e.message };
      }
      return { action: "started", reason: "unreachable", healthy: await deps.waitHealthy() };
    }
    try {
      await deps.restart();
    } catch (e) {
      return { action: "failed", reason: "stale", error: e.message };
    }
    return {
      action: "restarted",
      reason: "stale",
      fromVersion: version,
      toVersion: deps.diskVersion,
      healthy: await deps.waitHealthy()
    };
  } finally {
    deps.releaseLock();
  }
}

// src/hooks/session-start.ts
init_worker_heal_lock();
function fmtNum(n) {
  return n.toLocaleString("en-US");
}
function fmtBytes(bytes) {
  if (bytes < 1024)
    return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[i]}`;
}
function formatBanner(stats) {
  const ver = stats.version ? ` v${stats.version}` : "";
  const ed = stats.edition === "federation" ? " (Federation)" : stats.edition === "oss" ? " (OSS)" : "";
  const lines = [
    "",
    "",
    `\u2693 Captain Memo${ver}${ed}`,
    "\u2500".repeat(60)
  ];
  const byCh = Object.entries(stats.by_channel).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${fmtNum(v)}`).join(", ");
  const corpusLine = byCh ? `${fmtNum(stats.total_chunks)} chunks (${byCh})` : `${fmtNum(stats.total_chunks)} chunks`;
  const host = stats.embedder.endpoint.replace(/^https?:\/\//, "").split("/")[0] ?? "?";
  lines.push(`  Project    ${stats.project_id}`);
  lines.push(`  Corpus     ${corpusLine}`);
  if (stats.disk) {
    lines.push(`  Disk       ${fmtBytes(stats.disk.bytes)}  (${stats.disk.path})`);
  }
  lines.push(`  Embedder   ${stats.embedder.model} @ ${host}`);
  lines.push(`  Retrieval  silent envelope on each prompt (top-5)`);
  const idx = stats.indexing;
  if (idx.status === "indexing") {
    lines.push(`  Indexing   ${fmtNum(idx.done)}/${fmtNum(idx.total)} (${idx.percent}%)`);
  } else if (idx.status === "error") {
    lines.push(`  Indexing   error \u2014 ${idx.errors} files failed`);
  }
  const o = stats.observations;
  if (o.queue_pending > 0 || o.queue_processing > 0) {
    lines.push(`  Obs queue  pending=${o.queue_pending} processing=${o.queue_processing} (drains every 5s)`);
  }
  lines.push("");
  return lines.join(`
`);
}
function formatDegradedBanner(detail) {
  return [
    "",
    "",
    "\u2693 Captain Memo \u2014 worker unreachable",
    "\u2500".repeat(60),
    `  Memory is paused this session (${detail}).`,
    "  Search and observation capture resume automatically once the worker is back.",
    "  Details: ~/.captain-memo/logs/hook.log",
    ""
  ].join(`
`);
}
async function main2() {
  try {
    await readStdinJson();
  } catch (err) {
    logHookError("SessionStart", err);
  }
  const timeoutMs = Number(process.env.CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS ?? process.env[ENV_HOOK_TIMEOUT_MS] ?? 1e4);
  async function probeStats() {
    return workerFetch("/stats", { method: "GET", timeoutMs });
  }
  let stats = await probeStats();
  const selfHealOff = process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL === "1";
  const running = stats.ok && !!stats.body;
  const stale = running && stats.body.version !== undefined && stats.body.version !== VERSION;
  if (!selfHealOff && (!running || stale)) {
    try {
      const { getServiceManager: getServiceManager2 } = await Promise.resolve().then(() => (init_service_manager(), exports_service_manager));
      const sm = getServiceManager2();
      const WORKER = "captain-memo-worker";
      const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
      const outcome = await ensureWorkerHealthy({
        diskVersion: VERSION,
        probeVersion: async () => running ? stats.body.version ?? null : null,
        acquireLock: () => acquireHealLock(),
        releaseLock: () => releaseHealLock(),
        start: () => restartWorker(sm, WORKER, { port }),
        restart: () => restartWorker(sm, WORKER, { port, graceful: true }),
        waitHealthy: async () => {
          const deadline = Date.now() + Number(process.env.CAPTAIN_MEMO_SESSION_START_WAIT_HEALTHY_MS ?? 15000);
          while (Date.now() < deadline) {
            const r = await workerFetch("/stats", { method: "GET", timeoutMs: 1500 });
            if (r.ok) {
              stats = r;
              return true;
            }
            await new Promise((res) => setTimeout(res, 500));
          }
          return false;
        }
      });
      if (outcome.action === "skipped") {
        await new Promise((res) => setTimeout(res, 1500));
        stats = await probeStats();
      } else if (outcome.action === "failed") {
        logHookError("SessionStart", new Error(`self-heal ${outcome.reason} failed: ${outcome.error}`));
      } else if ((outcome.action === "started" || outcome.action === "restarted") && !outcome.healthy) {
        logHookError("SessionStart", new Error(`self-heal ${outcome.action} the worker but it did not become healthy within 8s (reason: ${outcome.reason})`));
      }
    } catch (err) {
      logHookError("SessionStart", err);
    }
  }
  const upgradeNotice = consumeUpgradeNotice(DATA_DIR, VERSION);
  const withNotice = (banner) => upgradeNotice ? `${upgradeNotice}

${banner}` : banner;
  if (stats.ok && stats.body) {
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: withNotice(formatBanner(stats.body))
    }));
  } else {
    logHookError("SessionStart", new Error(workerFailureMessage("/stats", stats) ?? "worker /stats returned no body"));
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: withNotice(formatDegradedBanner(stats.timedOut ? "worker timed out" : "worker not reachable"))
    }));
  }
}
if (false) {}

// src/hooks/pre-tool-use.ts
init_shared();
var HOOK_TIMEOUT_MS2 = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
var MAX_FILES = 25;
async function main3() {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("PreToolUse", err);
    return;
  }
  if (payload.tool_name === "Bash") {
    try {
      await (await Promise.resolve().then(() => (init_pre_git(), exports_pre_git))).runPreGit(payload);
    } catch (err) {
      logHookError("PreToolUse", err);
    }
    return;
  }
  const sid = payload.session_id;
  const ip = payload.tool_input ?? {};
  const fp = typeof ip.file_path === "string" ? ip.file_path : typeof ip.notebook_path === "string" ? ip.notebook_path : undefined;
  if (!sid || !fp)
    return;
  const project = resolveProjectId(payload.cwd);
  let files = [fp];
  const cur = await workerFetch(`/worknote/active?session_id=${encodeURIComponent(sid)}`, { method: "GET", timeoutMs: HOOK_TIMEOUT_MS2 });
  if (cur.ok && cur.body?.claims) {
    const mine = cur.body.claims.find((c) => c.session_id === sid);
    if (mine?.files?.length) {
      files = [...new Set([...mine.files, fp])];
      if (files.length > MAX_FILES)
        files = files.slice(-MAX_FILES);
    }
  }
  const set = await workerFetch("/worknote/set", {
    method: "POST",
    body: { session_id: sid, agent: "claude", what: `editing ${files.length} file(s) in ${project}`, files, enrich_from_observations: true },
    timeoutMs: HOOK_TIMEOUT_MS2
  });
  logWorkerFailure("PreToolUse", "/worknote/set", set);
  if (!set.ok || !set.body)
    return;
  const overlaps = set.body.overlaps ?? [];
  if (overlaps.length === 0)
    return;
  const fileHits = overlaps.filter((o) => o.kind !== "semantic");
  const semHits = overlaps.filter((o) => o.kind === "semantic");
  const parts = [];
  if (fileHits.length > 0) {
    const who = fileHits.map((o) => `${(o.session_id ?? "").slice(0, 12)} (${o.agent ?? "?"}) on ${(o.overlapping ?? o.files ?? []).join(", ")}`).join(" ; ");
    parts.push(`editing the same files: ${who}`);
  }
  if (semHits.length > 0) {
    const who = semHits.map((o) => `${(o.session_id ?? "").slice(0, 12)} (${o.agent ?? "?"}) on "${(o.what ?? "").slice(0, 80)}"${typeof o.similarity === "number" ? ` (~${o.similarity.toFixed(2)})` : ""}`).join(" ; ");
    parts.push(`working on the same thing by meaning: ${who}`);
  }
  const warning = `WORK-BOARD OVERLAP: another captain is ${parts.join("; and is ")}. Check the captain-memo work board (work_active) and coordinate, or pick a different area, before continuing.`;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: warning } }));
}
if (false) {}

// src/hooks/post-tool-use.ts
init_shared();
init_branch();

// src/shared/origin-agent.ts
var ORIGIN_AGENTS = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "opencode",
  "vibe",
  "vscode",
  "jetbrains",
  "unknown"
];
var UNKNOWN_ORIGIN_AGENT = "unknown";
function asOriginAgent(v) {
  return typeof v === "string" && ORIGIN_AGENTS.includes(v) ? v : null;
}
function detectOriginAgent(env = process.env) {
  const e = env ?? {};
  const explicit = asOriginAgent((e.AI_AGENT ?? "").trim().toLowerCase());
  if (explicit)
    return explicit;
  if ((e.CLAUDECODE ?? "").length > 0)
    return "claude-code";
  if ((e.CLAUDE_CODE_ENTRYPOINT ?? "").length > 0)
    return "claude-code";
  return UNKNOWN_ORIGIN_AGENT;
}

// src/hooks/post-tool-use.ts
var HOOK_TIMEOUT_MS3 = Number(process.env.CAPTAIN_MEMO_POST_TOOL_USE_TIMEOUT_MS ?? 1000);
function extractFiles(input, response) {
  const read = [];
  const modified = [];
  const ip = input ?? {};
  const rp = response ?? {};
  if (typeof ip.file_path === "string") {
    if (rp && typeof rp === "object" && "success" in rp)
      modified.push(ip.file_path);
    else
      read.push(ip.file_path);
  }
  if (typeof ip.notebook_path === "string")
    modified.push(ip.notebook_path);
  return { read, modified };
}
async function main4() {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("PostToolUse", err);
    return;
  }
  if (!payload.tool_name)
    return;
  const { read, modified } = extractFiles(payload.tool_input, payload.tool_response);
  const event = {
    session_id: payload.session_id ?? "unknown",
    project_id: resolveProjectId(payload.cwd),
    prompt_number: payload.prompt_number ?? 0,
    tool_name: payload.tool_name,
    tool_input_summary: summarize(payload.tool_input, 1500),
    tool_result_summary: summarize(payload.tool_response, 1500),
    files_read: read,
    files_modified: modified,
    ts_epoch: Math.floor(Date.now() / 1000),
    branch: detectBranchSync(process.cwd()),
    origin_agent: detectOriginAgent()
  };
  const res = await workerFetch("/observation/enqueue", {
    method: "POST",
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS3
  });
  logWorkerFailure("PostToolUse", "/observation/enqueue", res);
}
if (false) {}

// src/hooks/stop.ts
init_shared();
init_paths();
async function main5() {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("Stop", err);
    return;
  }
  if (!payload.session_id)
    return;
  const res = await workerFetch("/observation/flush", {
    method: "POST",
    body: { session_id: payload.session_id, max: 200 },
    timeoutMs: DEFAULT_STOP_DRAIN_BUDGET_MS
  });
  logWorkerFailure("Stop", "/observation/flush", res);
}
if (false) {}

// src/hooks/pre-compact.ts
init_shared();
init_branch();
var HOOK_TIMEOUT_MS4 = Number(process.env.CAPTAIN_MEMO_PRE_COMPACT_TIMEOUT_MS ?? 5000);
async function main6() {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("PreCompact", err);
    return;
  }
  const event = {
    session_id: payload.session_id ?? "unknown",
    project_id: resolveProjectId(payload.cwd),
    prompt_number: 0,
    tool_name: "pre-compact",
    tool_input_summary: "",
    tool_result_summary: summarize(payload, 2000),
    files_read: [],
    files_modified: [],
    ts_epoch: Math.floor(Date.now() / 1000),
    branch: detectBranchSync(process.cwd()),
    origin_agent: detectOriginAgent(),
    source: "pre-compact"
  };
  const res = await workerFetch("/observation/enqueue", {
    method: "POST",
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS4
  });
  logWorkerFailure("PreCompact", "/observation/enqueue", res);
}
if (false) {}

// src/hooks/dispatcher.ts
var EVENTS = {
  UserPromptSubmit: main,
  SessionStart: main2,
  PreToolUse: main3,
  PostToolUse: main4,
  Stop: main5,
  PreCompact: main6
};
async function main7() {
  const event = process.argv[2] ?? process.env.CLAUDE_HOOK_EVENT_NAME ?? process.env.CAPTAIN_MEMO_HOOK_EVENT;
  if (!event || !(event in EVENTS)) {
    process.exit(0);
  }
  const handler = EVENTS[event];
  try {
    await handler();
  } catch (err) {
    logHookError(event, err);
    process.exit(0);
  }
}
if (false) {}

// bin/captain-memo-hook.ts
init_shared();
try {
  await main7();
} catch (err) {
  logHookError(process.argv[2] ?? "unknown", err);
  process.exit(0);
}
