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
import { join as join2, resolve } from "path";
import { fileURLToPath } from "url";
function isMainModule(meta) {
  const entry = process.argv[1];
  if (entry && /(?:^|[\\/])captain-memo-hook(?:\.(?:js|ts))?$/.test(entry))
    return false;
  if (meta.main)
    return true;
  if (!entry)
    return false;
  try {
    const actual = resolve(entry);
    const expected = resolve(fileURLToPath(meta.url));
    return process.platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  } catch {
    return false;
  }
}
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
import { openSync, closeSync, readFileSync as readFileSync2, unlinkSync as unlinkSync2, writeSync } from "fs";
import { join as join4 } from "path";
function acquireHealLock(lockPath = HEAL_LOCK_PATH, now = Date.now()) {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(now));
    closeSync(fd);
    return true;
  } catch {
    try {
      const stamp = Number(readFileSync2(lockPath, "utf-8").trim());
      const age = now - (Number.isFinite(stamp) ? stamp : 0);
      if (age > HEAL_LOCK_TTL_MS) {
        unlinkSync2(lockPath);
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
    unlinkSync2(lockPath);
  } catch {}
}
var HEAL_LOCK_PATH, HEAL_LOCK_TTL_MS = 20000;
var init_worker_heal_lock = __esm(() => {
  init_paths();
  HEAL_LOCK_PATH = join4(DATA_DIR, ".worker-heal.lock");
});

// src/shared/worker-health-probe.ts
var exports_worker_health_probe = {};
__export(exports_worker_health_probe, {
  readWorkerInstance: () => readWorkerInstance,
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
async function readWorkerInstance(port, timeoutMs = 3000) {
  const ctl = new AbortController;
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/stats`, { signal: ctl.signal });
    if (!r.ok)
      return null;
    const body = await r.json().catch(() => null);
    const v = body?.worker?.started_at_epoch;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  } catch {
    return null;
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
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, rmSync, writeFileSync as writeFileSync2 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join5, resolve as resolve2 } from "path";
import { spawnSync } from "child_process";
function unitName(name) {
  return name.endsWith(".service") ? name : `${name}.service`;
}
function templateFor(name) {
  const bare = name.replace(/\.service$/, "");
  if (bare === "captain-memo-embed") {
    return join5(REPO_ROOT, "services/embed/systemd/captain-memo-embed.user.service");
  }
  return join5(REPO_ROOT, "services/worker/systemd/captain-memo-worker.user.service");
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
    const unit = readFileSync3(tpl, "utf-8").replaceAll("__INSTALL_DIR__", spec.workingDir).replaceAll("__ENV_FILE__", spec.envFile ?? "").replaceAll("__BUN__", bun);
    if (!existsSync2(USER_SYSTEMD_DIR))
      mkdirSync3(USER_SYSTEMD_DIR, { recursive: true });
    writeFileSync2(join5(USER_SYSTEMD_DIR, unitName(spec.name)), unit, { mode: 420 });
    systemctl(["daemon-reload"]);
    if (spec.autostart)
      systemctl(["enable", unitName(spec.name)]);
    systemctl(["restart", unitName(spec.name)]);
  }
  async remove(name) {
    systemctl(["stop", unitName(name)]);
    systemctl(["disable", unitName(name)]);
    const unitPath = join5(USER_SYSTEMD_DIR, unitName(name));
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
  REPO_ROOT = resolve2(import.meta.dir, "../../..");
  USER_SYSTEMD_DIR = join5(homedir3(), ".config/systemd/user");
});

// src/services/service-manager/launchd.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readFileSync as readFileSync4, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "fs";
import { homedir as homedir4, userInfo } from "os";
import { join as join6, resolve as resolve3 } from "path";
import { spawnSync as spawnSync2 } from "child_process";
function bareName(name) {
  return name.replace(/\.service$/, "");
}
function labelFor(name) {
  return `com.captainmemo.${bareName(name).replace(/^captain-memo-/, "")}`;
}
function plistPath(name) {
  return join6(LAUNCH_AGENTS_DIR, `${labelFor(name)}.plist`);
}
function domainTarget(name) {
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  return name ? `gui/${uid}/${labelFor(name)}` : `gui/${uid}`;
}
function templateFor2(name) {
  const bare = bareName(name);
  if (bare === "captain-memo-embed") {
    return join6(REPO_ROOT2, "services/embed/launchd/captain-memo-embed.plist");
  }
  return join6(REPO_ROOT2, "services/worker/launchd/captain-memo-worker.plist");
}
function xmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function programArgsXml(argv, indent = "    ") {
  return argv.map((a) => `${indent}<string>${xmlEscape(a)}</string>`).join(`
`);
}
function renderPlist(spec, template) {
  const logDir = spec.logDir || DEFAULT_LOG_DIR;
  return template.replaceAll("__LABEL__", xmlEscape(labelFor(spec.name))).replaceAll("__PROGRAM_ARGS__", programArgsXml(spec.exec)).replaceAll("__INSTALL_DIR__", xmlEscape(spec.workingDir)).replaceAll("__LOG_DIR__", xmlEscape(logDir)).replaceAll("__NAME__", xmlEscape(bareName(spec.name))).replaceAll("__RUN_AT_LOAD__", spec.autostart ? "<true/>" : "<false/>").replaceAll("__KEEP_ALIVE__", spec.restartOnFailure ? "<true/>" : "<false/>");
}
function launchctl(args) {
  const r = spawnSync2("launchctl", args, { encoding: "utf-8", timeout: LAUNCHCTL_TIMEOUT_MS });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    error: r.error,
    timedOut: r.error?.code === "ETIMEDOUT"
  };
}
function must(r, what) {
  if (r.status === 0)
    return;
  const detail = r.stderr.trim() || r.stdout.trim() || r.error?.message || "no output";
  throw new Error(`launchctl ${what} failed (status ${r.status ?? "?"}): ${detail}`);
}
async function settled(check, ms = 20000) {
  const deadline = Date.now() + ms;
  let last = "stopped";
  for (;; ) {
    last = await check();
    if (last === "running" || Date.now() > deadline)
      return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

class LaunchdServiceManager {
  async install(spec) {
    const tpl = templateFor2(spec.name);
    if (!existsSync3(tpl))
      throw new Error(`missing launchd plist template: ${tpl}`);
    const plist = renderPlist(spec, readFileSync4(tpl, "utf-8"));
    if (!existsSync3(LAUNCH_AGENTS_DIR))
      mkdirSync4(LAUNCH_AGENTS_DIR, { recursive: true });
    const logDir = spec.logDir || DEFAULT_LOG_DIR;
    if (!existsSync3(logDir))
      mkdirSync4(logDir, { recursive: true });
    const path = plistPath(spec.name);
    writeFileSync3(path, plist, { mode: 420 });
    launchctl(["bootout", domainTarget(spec.name)]);
    must(launchctl(["bootstrap", domainTarget(), path]), `bootstrap ${path}`);
    if (spec.autostart)
      launchctl(["enable", domainTarget(spec.name)]);
    if (!spec.autostart) {
      must(launchctl(["kickstart", domainTarget(spec.name)]), `kickstart ${domainTarget(spec.name)}`);
      return;
    }
    const state = await settled(() => this.status(spec.name));
    if (state !== "running") {
      throw new Error(`the LaunchAgent loaded but is not running (state: ${state}). ` + `Inspect it with: launchctl print ${domainTarget(spec.name)}` + (spec.logDir ? `  \xB7  logs: ${spec.logDir}` : ""));
    }
  }
  async remove(name) {
    launchctl(["bootout", domainTarget(name)]);
    const path = plistPath(name);
    if (existsSync3(path))
      rmSync2(path, { force: true });
  }
  async start(name) {
    if (!await this.isLoaded(name)) {
      const path = plistPath(name);
      if (!existsSync3(path))
        throw new Error(`launchd plist not found: ${path} (run install first)`);
      must(launchctl(["bootstrap", domainTarget(), path]), `bootstrap ${path}`);
    }
    must(launchctl(["kickstart", domainTarget(name)]), `kickstart ${domainTarget(name)}`);
  }
  async restart(name, _opts) {
    if (!await this.isLoaded(name))
      return this.start(name);
    const r = launchctl(["kickstart", "-k", domainTarget(name)]);
    if (r.status === 0)
      return;
    if (r.timedOut && await settled(() => this.status(name)) === "running")
      return;
    must(r, `kickstart -k ${domainTarget(name)}`);
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
    if (!await this.isLoaded(name))
      return;
    must(launchctl(["bootout", domainTarget(name)]), `bootout ${labelFor(name)}`);
  }
  async isLoaded(name) {
    return launchctl(["print", domainTarget(name)]).status === 0;
  }
  async status(name) {
    const r = launchctl(["print", domainTarget(name)]);
    if (r.status !== 0) {
      return existsSync3(plistPath(name)) ? "stopped" : "not-installed";
    }
    if (/\bstate\s*=\s*running\b/.test(r.stdout))
      return "running";
    const m = r.stdout.match(/\blast exit (?:code|status)\s*=\s*(\d+)/);
    if (m && m[1] !== "0")
      return "failed";
    return "stopped";
  }
  async isActive(name) {
    return await this.status(name) === "running";
  }
  async enable(name) {
    launchctl(["enable", domainTarget(name)]);
  }
  async disable(name) {
    launchctl(["disable", domainTarget(name)]);
  }
}
function createLaunchdServiceManager() {
  return new LaunchdServiceManager;
}
var REPO_ROOT2, LAUNCH_AGENTS_DIR, DEFAULT_LOG_DIR, LAUNCHCTL_TIMEOUT_MS = 90000;
var init_launchd = __esm(() => {
  init_paths();
  REPO_ROOT2 = resolve3(import.meta.dir, "../../..");
  LAUNCH_AGENTS_DIR = join6(homedir4(), "Library/LaunchAgents");
  DEFAULT_LOG_DIR = LOGS_DIR;
});

// src/services/service-manager/windows-scheduled-task.ts
import { writeFileSync as writeFileSync4, rmSync as rmSync3 } from "fs";
import { tmpdir } from "os";
import { join as join7 } from "path";
function psSingleQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
function xmlEscape2(value) {
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
    `      <Command>${xmlEscape2(exe)}</Command>`
  ];
  if (argString.length > 0)
    execLines.push(`      <Arguments>${xmlEscape2(argString)}</Arguments>`);
  execLines.push(`      <WorkingDirectory>${xmlEscape2(spec.workingDir)}</WorkingDirectory>`);
  execLines.push("    </Exec>");
  const userId = xmlEscape2(`${process.env.USERDOMAIN ?? process.env.COMPUTERNAME ?? ""}\\${process.env.USERNAME ?? ""}`);
  const watchdogInterval = isoDuration(spec.watchdogIntervalSec ?? 300);
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${xmlEscape2(spec.description)}</Description>`,
    `    <URI>\\${xmlEscape2(spec.name)}</URI>`,
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
    const xmlPath = join7(tmpdir(), `captain-memo-task-${spec.name}-${process.pid}-${Date.now()}.xml`);
    writeFileSync4(xmlPath, toTaskXmlBuffer(xml));
    try {
      const r = await runSchtasks(["/Create", "/TN", spec.name, "/XML", xmlPath, "/F"]);
      if (r.exitCode !== 0) {
        throw new Error(`schtasks /Create failed for ${spec.name}: ${r.stderr.trim() || r.stdout.trim()}`);
      }
    } finally {
      try {
        rmSync3(xmlPath, { force: true });
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
  if (process.platform === "win32")
    return createWindowsScheduledTaskServiceManager();
  if (process.platform === "darwin")
    return createLaunchdServiceManager();
  return createSystemdServiceManager();
}
var init_service_manager = __esm(() => {
  init_systemd();
  init_launchd();
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

// src/shared/plugin-cache.ts
import { existsSync as existsSync4, readFileSync as readFileSync6, readdirSync as readdirSync2, statSync as statSync3 } from "fs";
import { homedir as homedir5 } from "os";
import { join as join9 } from "path";
function normalizePath(p) {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}
function parseInstalledPaths(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const plugins = parsed?.plugins;
  if (!plugins || typeof plugins !== "object")
    return null;
  const out = new Set;
  for (const installs of Object.values(plugins)) {
    if (!Array.isArray(installs))
      continue;
    for (const install of installs) {
      const p = install?.installPath;
      if (typeof p === "string" && p.length > 0)
        out.add(normalizePath(p));
    }
  }
  if (out.size === 0 && Object.keys(plugins).length > 0)
    return null;
  return out;
}
function readPluginManifest(root) {
  try {
    const m = JSON.parse(readFileSync6(join9(root, ".claude-plugin", "plugin.json"), "utf-8"));
    if (typeof m.name !== "string")
      return null;
    return { name: m.name, version: typeof m.version === "string" ? m.version : null };
  } catch {
    return null;
  }
}
function readInstalledPaths(file = INSTALLED_PLUGINS_PATH) {
  try {
    return parseInstalledPaths(readFileSync6(file, "utf-8"));
  } catch {
    return null;
  }
}
var CACHE_ROOT, INSTALLED_PLUGINS_PATH;
var init_plugin_cache = __esm(() => {
  CACHE_ROOT = join9(homedir5(), ".claude", "plugins", "cache");
  INSTALLED_PLUGINS_PATH = join9(homedir5(), ".claude", "plugins", "installed_plugins.json");
});

// src/shared/ansi.ts
var init_ansi = () => {};

// src/cli/banner.ts
var init_banner = __esm(() => {
  init_ansi();
});

// src/shared/platform.ts
var isWindows, isMac, isLinux;
var init_platform = __esm(() => {
  isWindows = process.platform === "win32";
  isMac = process.platform === "darwin";
  isLinux = process.platform === "linux";
});

// src/shared/sqlite-extensions.ts
var MACOS_SQLITE_REMEDY;
var init_sqlite_extensions = __esm(() => {
  init_platform();
  MACOS_SQLITE_REMEDY = `macOS ships SQLite without extension support, so the vector index cannot load.
` + `  Fix:  brew install sqlite
` + `  Then: captain-memo restart
` + '  (Or install with the embedder set to "skip" for keyword-only retrieval, which needs no extension.)';
});

// src/shared/worker-env.ts
var init_worker_env = __esm(() => {
  init_paths();
});

// src/shared/summarizer-login.ts
var init_summarizer_login = () => {};

// src/cli/commands/install-hooks.ts
var init_install_hooks = () => {};

// src/services/embedder-installer/bash.ts
import { join as join10, resolve as resolve4 } from "path";
var REPO_ROOT3, SCRIPT;
var init_bash = __esm(() => {
  REPO_ROOT3 = resolve4(import.meta.dir, "../../..");
  SCRIPT = join10(REPO_ROOT3, "scripts/install-embedder.sh");
});

// src/services/embedder-installer/powershell.ts
import { join as join11, resolve as resolve5 } from "path";
var REPO_ROOT4, SCRIPT2;
var init_powershell = __esm(() => {
  REPO_ROOT4 = resolve5(import.meta.dir, "../../..");
  SCRIPT2 = join11(REPO_ROOT4, "scripts/install-embedder.ps1");
});

// src/services/embedder-installer/index.ts
var init_embedder_installer = __esm(() => {
  init_platform();
  init_bash();
  init_powershell();
});

// src/cli/cross-ai.ts
var PROBE_CLEAR, bunYaml, OPENCODE_LOCAL_PROVIDERS, OPENCODE_LOCAL_PROVIDER_KEYS;
var init_cross_ai = __esm(() => {
  init_platform();
  PROBE_CLEAR = process.stdout.isTTY === true ? "\r\x1B[2K" : "\r";
  bunYaml = globalThis.Bun?.YAML;
  OPENCODE_LOCAL_PROVIDERS = {
    ollama: { name: "Ollama (local)", baseURL: "http://localhost:11434/v1" },
    vllm: { name: "vLLM (local)", baseURL: "http://localhost:8000/v1" },
    lmstudio: { name: "LM Studio (local)", baseURL: "http://127.0.0.1:1234/v1" }
  };
  OPENCODE_LOCAL_PROVIDER_KEYS = Object.keys(OPENCODE_LOCAL_PROVIDERS);
});

// src/shared/ai-memory-sources.ts
import { homedir as homedir6 } from "os";
var H;
var init_ai_memory_sources = __esm(() => {
  H = homedir6();
});

// src/cli/commands/install.ts
import { dirname as dirname2, join as join12, resolve as resolve6 } from "path";
import { homedir as homedir7 } from "os";
function pluginRegistrationSteps(repoRoot) {
  return [
    ["plugin", "marketplace", "remove", "captain-memo", "--scope", "user"],
    ["plugin", "marketplace", "add", repoRoot],
    ["plugin", "install", "captain-memo@captain-memo"]
  ];
}
var REPO_ROOT5, PLUGIN_LINK, MANAGED_ENV_KEYS;
var init_install = __esm(() => {
  init_banner();
  init_platform();
  init_sqlite_extensions();
  init_paths();
  init_worker_env();
  init_summarizer_login();
  init_service_manager();
  init_install_hooks();
  init_embedder_installer();
  init_cross_ai();
  init_ai_memory_sources();
  REPO_ROOT5 = resolve6(import.meta.dir, "../../..");
  PLUGIN_LINK = join12(homedir7(), ".claude", "plugins", "captain-memo");
  MANAGED_ENV_KEYS = new Set([
    "CAPTAIN_MEMO_DATA_DIR",
    "CAPTAIN_MEMO_PROJECT_ID",
    "CAPTAIN_MEMO_WORKER_PORT",
    "CAPTAIN_MEMO_HOOK_TIMEOUT_MS",
    "CAPTAIN_MEMO_SUMMARIZER_PROVIDER",
    "CAPTAIN_MEMO_SUMMARIZER_MODEL",
    "ANTHROPIC_API_KEY",
    "CAPTAIN_MEMO_OPENAI_ENDPOINT",
    "CAPTAIN_MEMO_OPENAI_API_KEY",
    "CAPTAIN_MEMO_SKIP_EMBED",
    "CAPTAIN_MEMO_EMBEDDER_ENDPOINT",
    "CAPTAIN_MEMO_EMBEDDER_MODEL",
    "CAPTAIN_MEMO_EMBEDDING_DIM",
    "CAPTAIN_MEMO_EMBEDDER_API_KEY",
    "CAPTAIN_MEMO_WATCH_MEMORY",
    "CAPTAIN_MEMO_WATCH_SKILLS"
  ]);
});

// src/cli/plugin-cache-refresh.ts
var exports_plugin_cache_refresh = {};
__export(exports_plugin_cache_refresh, {
  refreshPluginCacheIfStale: () => refreshPluginCacheIfStale,
  needsCacheRefresh: () => needsCacheRefresh,
  marketplacePointsAtCheckout: () => marketplacePointsAtCheckout,
  activeCachedVersion: () => activeCachedVersion,
  REPO_ROOT: () => REPO_ROOT6,
  CACHE_REFRESH_LOCK: () => CACHE_REFRESH_LOCK
});
import { spawnSync as spawnSync3 } from "child_process";
import { readFileSync as readFileSync7 } from "fs";
import { homedir as homedir8 } from "os";
import { join as join13 } from "path";
function marketplacePointsAtCheckout(repoRoot, home = homedir8()) {
  try {
    const file = join13(home, ".claude", "plugins", "known_marketplaces.json");
    const parsed = JSON.parse(readFileSync7(file, "utf-8"));
    const src = parsed["captain-memo"]?.source;
    return src?.source === "directory" && typeof src.path === "string" && normalizePath(src.path) === normalizePath(repoRoot);
  } catch {
    return false;
  }
}
function activeCachedVersion(home = homedir8()) {
  const installed = readInstalledPaths(join13(home, ".claude", "plugins", "installed_plugins.json"));
  if (installed === null)
    return null;
  for (const path of installed) {
    const m = readPluginManifest(path);
    if (m?.name === "captain-memo")
      return m.version;
  }
  return null;
}
function needsCacheRefresh(cachedVersion, runningVersion) {
  return cachedVersion !== null && cachedVersion !== runningVersion;
}
function refreshPluginCacheIfStale(runningVersion, repoRoot = REPO_ROOT6, deps = {}) {
  const cachedVersion = (deps.cachedVersion ?? activeCachedVersion)();
  if (!needsCacheRefresh(cachedVersion, runningVersion))
    return { refreshed: false, skipped: "cache is in step" };
  const pointsAt = deps.pointsAtCheckout ?? ((r) => marketplacePointsAtCheckout(r));
  if (!pointsAt(repoRoot))
    return { refreshed: false, skipped: "not a directory marketplace on this checkout" };
  const run = deps.run ?? ((args) => {
    const r = spawnSync3("claude", args, { stdio: "pipe", timeout: 120000 });
    return r.status ?? 1;
  });
  const steps = pluginRegistrationSteps(repoRoot);
  run(steps[0]);
  if (run(steps[1]) !== 0)
    return { refreshed: false, skipped: "marketplace add failed" };
  if (run(steps[2]) !== 0)
    return { refreshed: false, skipped: "plugin install failed" };
  return { refreshed: true, from: cachedVersion };
}
var REPO_ROOT6, CACHE_REFRESH_LOCK = ".plugin-cache-refresh.lock";
var init_plugin_cache_refresh = __esm(() => {
  init_plugin_cache();
  init_install();
  REPO_ROOT6 = join13(import.meta.dir, "..", "..");
});

// src/worker/branch.ts
import { spawnSync as spawnSync4 } from "child_process";
import { existsSync as existsSync5 } from "fs";
function detectBranchSync(cwd) {
  if (!existsSync5(cwd))
    return null;
  try {
    const result = spawnSync4("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0)
      return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
function detectRepoRootSync(cwd) {
  if (!existsSync5(cwd))
    return null;
  try {
    const result = spawnSync4("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", timeout: 2000 });
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
    return null;
  const root = detectRepoRootSync(payload.cwd);
  if (!root || root.includes("/claude-1000/"))
    return null;
  const res = await workerFetch(`/worknote/repo-active?repo_root=${encodeURIComponent(root)}`, { method: "GET", timeoutMs: HOOK_TIMEOUT_MS });
  if (!res.ok || !res.body?.holders)
    return null;
  const peers = res.body.holders.filter((h) => h.session_id !== payload.session_id);
  if (peers.length === 0)
    return null;
  const who = peers.map((h) => `${(h.session_id ?? "").slice(0, 12)} (${h.agent ?? "?"})${h.branch ? ` on ${h.branch}` : ""}${h.is_dirty ? ", dirty" : ""}`).join(" ; ");
  return `WORK-BOARD SHARED CHECKOUT: peer session(s) are using ${root} \u2014 ${who}. Running \`git ${op}\` here changes that shared working tree for them. Isolate instead: \`git worktree add ../<name> <branch>\` and work there. (advisory)`;
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

// src/worker/homework.ts
var HOMEWORK_DONE_KEEP_MS = 7 * 24 * 3600000;
function parseHomeworkPrompt(prompt2) {
  const m = /^\s*(?:idea|todo|homework|later|\u0438\u0434\u0435\u044F|\u0437\u0430 \u043F\u043E\u0441\u043B\u0435)\s*[:\-\u2014]\s*(\S[\s\S]*)$/i.exec(String(prompt2));
  return m ? m[1].trim() : null;
}
function homeworkFiledLine(it) {
  return `\uD83D\uDCDD Filed as homework #${it.id} on this captain (not for now): ${it.text.split(`
`)[0].slice(0, 160)} \u2014 todo_list() shows the list; the user may just want a short "noted".`;
}

// src/shared/worker-transition.ts
init_paths();
import { mkdirSync as mkdirSync2, readFileSync, readdirSync, renameSync as renameSync2, statSync as statSync2, unlinkSync, writeFileSync } from "fs";
import { dirname, join as join3 } from "path";
var TRANSITION_PATH = join3(DATA_DIR, ".worker-transition");
var TRANSITION_TTL_MS = 120000;
function markTransition(t, path = TRANSITION_PATH, now = Date.now()) {
  try {
    const live = readTransition(path, now);
    const entry = {
      ...t,
      ...t.from === undefined && live?.from !== undefined ? { from: live.from } : {},
      ...t.to === undefined && live?.to !== undefined ? { to: live.to } : {},
      ts: live?.ts ?? now
    };
    mkdirSync2(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(entry), "utf-8");
    renameSync2(tmp, path);
    return true;
  } catch {
    return false;
  }
}
function readTransition(path = TRANSITION_PATH, now = Date.now()) {
  try {
    const t = JSON.parse(readFileSync(path, "utf-8"));
    if (t.phase !== "booting" && t.phase !== "updating")
      return null;
    if (!Number.isFinite(t.ts) || Math.abs(now - t.ts) > TRANSITION_TTL_MS)
      return null;
    return t;
  } catch {
    return null;
  }
}
function clearTransition(path = TRANSITION_PATH) {
  try {
    unlinkSync(path);
  } catch {}
}
var DEGRADED_PREFIX = ".degraded-";
var DEGRADED_MAX_AGE_MS = 24 * 60 * 60000;
function degradedPath(sessionId, dataDir) {
  return join3(dataDir, `${DEGRADED_PREFIX}${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`);
}
function markSessionDegraded(sessionId, dataDir = DATA_DIR) {
  if (!sessionId)
    return false;
  const now = Date.now();
  try {
    mkdirSync2(dataDir, { recursive: true });
    writeFileSync(degradedPath(sessionId, dataDir), new Date(now).toISOString(), "utf-8");
    for (const f of readdirSync(dataDir)) {
      if (!f.startsWith(DEGRADED_PREFIX))
        continue;
      const p = join3(dataDir, f);
      try {
        if (now - statSync2(p).mtimeMs > DEGRADED_MAX_AGE_MS)
          unlinkSync(p);
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}
function consumeSessionDegraded(sessionId, dataDir = DATA_DIR) {
  if (!sessionId)
    return false;
  try {
    const p = degradedPath(sessionId, dataDir);
    statSync2(p);
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// src/hooks/user-prompt-submit.ts
async function main(options = {}) {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("UserPromptSubmit", err);
    return;
  }
  const prompt2 = payload.prompt ?? "";
  const timeoutMs = Number(process.env[ENV_HOOK_TIMEOUT_MS] ?? DEFAULT_HOOK_TIMEOUT_MS);
  const homework = parseHomeworkPrompt(prompt2);
  if (homework) {
    const filed = await workerFetch("/homework/add", { method: "POST", body: { text: homework, by: payload.session_id ?? "hook", project: resolveProjectId(payload.cwd) }, timeoutMs: 6000 });
    const line = filed.ok && filed.body ? homeworkFiledLine(filed.body.item) + ` (${filed.body.open} open)` : '\uD83D\uDCDD The worker did not confirm filing this as homework in time \u2014 it may still have landed: todo_list() shows; if it is not there, say "noted" and todo_add it yourself.';
    logWorkerFailure("UserPromptSubmit", "/homework/add", filed);
    if (options.structuredContextJson)
      writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: options.contextEventName ?? "UserPromptSubmit", additionalContext: line } }));
    else {
      writeStdout(line);
      writeStdout(`

`);
    }
    if (options.emitOriginalPrompt !== false)
      writeStdout(prompt2);
    return;
  }
  const result = await workerFetch("/inject/context", {
    method: "POST",
    body: {
      prompt: prompt2,
      top_k: 5,
      session_id: payload.session_id,
      project_id: resolveProjectId(payload.cwd)
    },
    timeoutMs
  });
  logWorkerFailure("UserPromptSubmit", "/inject/context", result);
  const transition = result.ok ? null : readTransition();
  if (transition) {
    logHookError("UserPromptSubmit", new Error(`worker is ${transition.phase} \u2014 skipping the reclaim`));
  }
  if (!result.ok && process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL !== "1" && !transition) {
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
    if (options.structuredContextJson) {
      writeStdout(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: options.contextEventName ?? "UserPromptSubmit",
          additionalContext: result.body.envelope
        }
      }));
    } else {
      writeStdout(result.body.envelope);
      writeStdout(`

`);
    }
  }
  if (options.emitOriginalPrompt !== false)
    writeStdout(prompt2);
}
if (isMainModule(import.meta)) {
  try {
    await main();
  } catch (err) {
    logHookError("UserPromptSubmit", err);
    process.exit(0);
  }
}

// src/hooks/session-start.ts
init_shared();
init_paths();
import { mkdirSync as mkdirSync6, readFileSync as readFileSync8, statSync as statSync4, writeFileSync as writeFileSync6 } from "fs";
import { join as join14 } from "path";
// package.json
var package_default = {
  name: "captain-memo",
  version: "0.44.0",
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
    test: "bun test --timeout 15000",
    "test:unit": "bun test --timeout 15000 tests/unit/",
    "test:integration": "bun test --timeout 15000 tests/integration/",
    "test:hooks": "bun test --timeout 15000 tests/hooks/",
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
    nanoid: "^5.1.16",
    "sqlite-vec": "^0.1.9",
    zod: "^3.24.0"
  },
  overrides: {
    qs: "^6.16.0",
    hono: "^4.13.5",
    "body-parser": "^2.3.0",
    "@hono/node-server": "^2.0.5",
    "fast-uri": "^3.1.6",
    "ip-address": "^10.4.0"
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
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, writeFileSync as writeFileSync5, renameSync as renameSync3 } from "fs";
import { join as join8 } from "path";
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
function formatAutoUpdateBanner(from, to, installFailed) {
  const lines = [
    `\u2693 Captain Memo auto-updated: v${from} \u2192 v${to}`,
    "  Fast-forwarded your checkout to the latest stable tag and restarted the worker."
  ];
  if (installFailed)
    lines.push("  \u26A0 `bun install` failed \u2014 run it in your checkout if the worker misbehaves.");
  lines.push("  Opt out with CAPTAIN_MEMO_AUTO_UPDATE=0.");
  return lines.join(`
`);
}
function formatRollbackBanner(from, attempted, rolledBack) {
  return rolledBack ? [
    `\u2693 Captain Memo auto-update to v${attempted} FAILED to start \u2014 rolled back to v${from}.`,
    "  Your worker is running the previous version again. The bad tag is skipped until it changes."
  ].join(`
`) : [
    `\u2693 Captain Memo auto-update to v${attempted} FAILED to start AND rollback failed.`,
    "  Run `git status` in your checkout and `captain-memo install` to recover."
  ].join(`
`);
}
function markerPath(dataDir) {
  return join8(dataDir, MARKER_FILENAME);
}
function readMarker(dataDir) {
  try {
    const raw = readFileSync5(markerPath(dataDir), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
function writeMarker(dataDir, version) {
  try {
    mkdirSync5(dataDir, { recursive: true });
    const final = markerPath(dataDir);
    const tmp = `${final}.tmp-${process.pid}`;
    writeFileSync5(tmp, `${version}
`, "utf-8");
    renameSync3(tmp, final);
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

// src/worker/self-updater.ts
var DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
function isUpdateCheckDue(lastCheckMs, nowMs, intervalMs) {
  if (lastCheckMs === null)
    return true;
  return nowMs - lastCheckMs >= intervalMs;
}
function isSafeRefName(name) {
  return name.length > 0 && !name.startsWith("-");
}
function originTagNames(port, installDir) {
  const names = new Set;
  const ls = port.run(["git", "ls-remote", "--tags", "origin"], installDir);
  if (ls.code !== 0)
    return names;
  for (const line of ls.stdout.split(`
`)) {
    const m = /\trefs\/tags\/(.+?)(\^\{\})?$/.exec(line);
    if (m && m[1])
      names.add(m[1]);
  }
  return names;
}
function isGitCheckout(port, installDir) {
  const top = port.run(["git", "rev-parse", "--show-toplevel"], installDir);
  return top.code === 0 && top.stdout.trim().length > 0;
}
function originUrl(port, installDir) {
  const r = port.run(["git", "remote", "get-url", "origin"], installDir);
  const url = r.code === 0 ? r.stdout.trim() : "";
  return url.length > 0 ? url : null;
}
function pickUpdateTarget(port, installDir, runningVersion) {
  const branchRes = port.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], installDir);
  const branch = branchRes.stdout.trim();
  if (branchRes.code !== 0 || !branch || branch === "HEAD")
    return null;
  if (!isSafeRefName(branch))
    return null;
  port.run(["git", "fetch", "--tags", "--force", "origin"], installDir, 20000);
  const originTags = originTagNames(port, installDir);
  if (originTags.size === 0)
    return null;
  let best = null;
  for (const tag of originTags) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag))
      continue;
    if (compareSemver(tag, runningVersion) !== 1)
      continue;
    if (best && compareSemver(tag, best.version) !== 1)
      continue;
    const anc = port.run(["git", "merge-base", "--is-ancestor", "HEAD", tag], installDir);
    if (anc.code !== 0)
      continue;
    best = { ref: tag, version: tag };
  }
  return best;
}
function resetBuildOutput(port, installDir) {
  port.run(["git", "checkout", "--", "plugin/dist"], installDir);
}
function applyUpdateToRef(port, installDir, ref, fromVersion) {
  if (!isGitCheckout(port, installDir))
    return { ok: false, from: fromVersion, code: "not_a_checkout", reason: "not a git checkout" };
  if (!isSafeRefName(ref))
    return { ok: false, from: fromVersion, code: "pull_failed", reason: "unsafe ref name" };
  resetBuildOutput(port, installDir);
  const status = port.run(["git", "status", "--porcelain"], installDir);
  if (status.code !== 0)
    return { ok: false, from: fromVersion, code: "dirty_tree", reason: "git status failed" };
  if (status.stdout.trim().length > 0)
    return { ok: false, from: fromVersion, code: "dirty_tree", reason: "working tree not clean \u2014 refusing to auto-update over local edits" };
  const branchRes = port.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], installDir);
  const branch = branchRes.stdout.trim();
  if (branchRes.code !== 0 || !branch || branch === "HEAD")
    return { ok: false, from: fromVersion, code: "detached_head", reason: "detached HEAD or unknown branch" };
  const headRes = port.run(["git", "rev-parse", "HEAD"], installDir);
  const priorSha = headRes.code === 0 ? headRes.stdout.trim() : "";
  const merge = port.run(["git", "merge", "--ff-only", ref], installDir);
  if (merge.code !== 0)
    return { ok: false, from: fromVersion, code: "pull_failed", reason: (merge.stderr || merge.stdout || "").slice(0, 240) };
  const to = port.readPackageVersion(installDir);
  return { ok: true, from: fromVersion, ...to ? { to } : {}, ...priorSha ? { priorSha } : {} };
}
function installDeps(port, installDir, bunPath) {
  return port.run([bunPath, "install"], installDir, 300000);
}
function rollbackTo(port, installDir, sha, bunPath) {
  if (!isSafeRefName(sha))
    return false;
  const reset = port.run(["git", "reset", "--hard", sha], installDir);
  if (reset.code !== 0)
    return false;
  installDeps(port, installDir, bunPath);
  return true;
}
function runAutoUpdate(port, installDir, runningVersion, bunPath) {
  try {
    if (!isGitCheckout(port, installDir))
      return null;
    if (port.readPackageName(installDir) !== "captain-memo")
      return null;
    if (originUrl(port, installDir) === null)
      return null;
    const target = pickUpdateTarget(port, installDir, runningVersion);
    if (!target)
      return null;
    const applied = applyUpdateToRef(port, installDir, target.ref, runningVersion);
    if (!applied.ok)
      return applied;
    const deps = installDeps(port, installDir, bunPath);
    return deps.code === 0 ? applied : { ...applied, installFailed: true };
  } catch {
    return null;
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
function readPkgField(dir, field) {
  try {
    return JSON.parse(readFileSync8(join14(dir, "package.json"), "utf-8"))[field] ?? null;
  } catch {
    return null;
  }
}
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
function formatBanner(stats, homework = []) {
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
  if (homework.length > 0) {
    const shown = homework.slice(0, 3).map((h) => `#${h.id} ${h.text.split(`
`)[0].slice(0, 70)}${h.claimed_by ? ` (claimed by ${h.claimed_by})` : ""}`);
    lines.push(`  Homework   ${homework.length} open \u2014 todo_list() for all, todo_claim(id) before starting one`);
    for (const s of shown)
      lines.push(`             ${s}`);
    if (homework.length > 3)
      lines.push(`             \u2026 ${homework.length - 3} more`);
  }
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
function formatTransitionBanner(t, willAnnounce, now = Date.now()) {
  const secs = Math.max(1, Math.round((now - t.ts) / 1000));
  const versions = t.from && t.to ? ` (v${t.from} \u2192 v${t.to})` : t.to ? ` (\u2192 v${t.to})` : "";
  return [
    "",
    "",
    t.phase === "updating" ? `\u2693 Captain Memo \u2014 updating${versions}` : "\u2693 Captain Memo \u2014 worker still starting up",
    "\u2500".repeat(60),
    t.phase === "updating" ? `  The worker restarted itself onto the new version ${secs}s ago and is coming back up.` : `  The worker started ${secs}s ago and hasn't opened its port yet (a cold start takes a few seconds).`,
    willAnnounce ? "  Memory resumes by itself \u2014 no need to restart Claude. This session says so when it is back." : "  Memory resumes by itself \u2014 no need to restart Claude.",
    ""
  ].join(`
`);
}
async function main2() {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("SessionStart", err);
  }
  const timeoutMs = Number(process.env.CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS ?? process.env[ENV_HOOK_TIMEOUT_MS] ?? 1e4);
  async function probeStats() {
    return workerFetch("/stats", { method: "GET", timeoutMs });
  }
  let stats = await probeStats();
  async function waitWorkerHealthy(budgetMs = 15000) {
    const deadline = Date.now() + budgetMs;
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
  let autoUpdateNotice = "";
  let updatedThisSession = false;
  let wroteTransition = false;
  if (process.env.CAPTAIN_MEMO_AUTO_UPDATE === "1") {
    const AUTO_UPDATE_LOCK = join14(DATA_DIR, ".auto-update.lock");
    try {
      const port = {
        run: (argv, cwd, timeoutMs2) => {
          const r = Bun.spawnSync(argv, {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            timeout: timeoutMs2 ?? 20000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10" }
          });
          return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
        },
        readPackageVersion: (dir) => readPkgField(dir, "version"),
        readPackageName: (dir) => readPkgField(dir, "name")
      };
      const intervalMs = Number(process.env.CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS);
      try {
        mkdirSync6(DATA_DIR, { recursive: true });
      } catch {}
      const stampPath = join14(DATA_DIR, ".last-update-check");
      let lastCheck = null;
      try {
        lastCheck = statSync4(stampPath).mtimeMs;
      } catch {}
      if (isUpdateCheckDue(lastCheck, Date.now(), intervalMs) && acquireHealLock(AUTO_UPDATE_LOCK)) {
        try {
          try {
            writeFileSync6(stampPath, `${new Date().toISOString()}
`);
          } catch {}
          const top = port.run(["git", "rev-parse", "--show-toplevel"], import.meta.dir);
          const installDir = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : import.meta.dir;
          const res = runAutoUpdate(port, installDir, VERSION, process.execPath);
          if (res?.ok) {
            const { getServiceManager: getServiceManager2 } = await Promise.resolve().then(() => (init_service_manager(), exports_service_manager));
            const sm = getServiceManager2();
            const wport = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
            wroteTransition = true;
            markTransition({ phase: "updating", from: res.from, ...res.to ? { to: res.to } : {} });
            await restartWorker(sm, "captain-memo-worker", { port: wport, graceful: true });
            const healthy = await waitWorkerHealthy();
            if (healthy) {
              updatedThisSession = true;
              if (res.to)
                writeMarker(DATA_DIR, res.to);
              autoUpdateNotice = formatAutoUpdateBanner(res.from, res.to ?? "?", res.installFailed);
            } else {
              const rolled = res.priorSha ? rollbackTo(port, installDir, res.priorSha, process.execPath) : false;
              markTransition({ phase: "updating", to: res.from });
              await restartWorker(sm, "captain-memo-worker", { port: wport });
              const backOnOld = await waitWorkerHealthy();
              if (!backOnOld) {
                clearTransition();
                wroteTransition = false;
              }
              stats = await probeStats();
              updatedThisSession = true;
              autoUpdateNotice = formatRollbackBanner(res.from, res.to ?? "?", rolled);
              logHookError("SessionStart", new Error(`auto-update to ${res.to} failed to boot; rolled back=${rolled}`));
            }
          } else if (res && !res.ok) {
            logHookError("SessionStart", new Error(`auto-update skipped: ${res.code} \u2014 ${res.reason}`));
          }
        } finally {
          releaseHealLock(AUTO_UPDATE_LOCK);
        }
      }
    } catch (err) {
      if (wroteTransition) {
        clearTransition();
        wroteTransition = false;
      }
      logHookError("SessionStart", err);
    }
  }
  const selfHealOff = process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL === "1";
  let running = stats.ok && !!stats.body;
  const transition = running ? null : readTransition();
  if (transition) {
    await waitWorkerHealthy(Number(process.env.CAPTAIN_MEMO_SESSION_START_TRANSITION_WAIT_MS ?? 20000));
    running = stats.ok && !!stats.body;
  }
  const inTransition = running ? null : transition;
  const stale = !updatedThisSession && !transition && running && stats.body.version !== undefined && stats.body.version !== VERSION;
  if (!selfHealOff && !inTransition && (!running || stale)) {
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
  try {
    const { refreshPluginCacheIfStale: refreshPluginCacheIfStale2, CACHE_REFRESH_LOCK: CACHE_REFRESH_LOCK2 } = await Promise.resolve().then(() => (init_plugin_cache_refresh(), exports_plugin_cache_refresh));
    const lock = join14(DATA_DIR, CACHE_REFRESH_LOCK2);
    if (acquireHealLock(lock)) {
      try {
        const r = refreshPluginCacheIfStale2(VERSION);
        if (r.refreshed)
          logHookError("SessionStart", new Error(`plugin cache re-snapshotted from v${r.from} to v${VERSION}`));
        else if (r.skipped && r.skipped !== "cache is in step") {
          logHookError("SessionStart", new Error(`plugin cache is stale and was not refreshed: ${r.skipped}`));
        }
      } finally {
        releaseHealLock(lock);
      }
    }
  } catch (err) {
    logHookError("SessionStart", err);
  }
  const upgradeNotice = consumeUpgradeNotice(DATA_DIR, VERSION);
  const notices = [autoUpdateNotice, upgradeNotice].filter(Boolean).join(`

`);
  const withNotice = (banner) => notices ? `${notices}

${banner}` : banner;
  const hw = stats.ok && stats.body ? await workerFetch("/homework/list?status=open", { method: "GET", timeoutMs: 1500 }) : null;
  const homework = hw?.ok && hw.body ? hw.body.items : [];
  if (stats.ok && stats.body) {
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: withNotice(formatBanner(stats.body, homework))
    }));
  } else if (inTransition) {
    const willAnnounce = markSessionDegraded(payload.session_id ?? "");
    logHookError("SessionStart", new Error(`worker ${inTransition.phase} (breadcrumb ${Math.round((Date.now() - inTransition.ts) / 1000)}s old) \u2014 still unreachable after the transition wait; self-heal skipped`));
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: withNotice(formatTransitionBanner(inTransition, willAnnounce))
    }));
  } else {
    logHookError("SessionStart", new Error(workerFailureMessage("/stats", stats) ?? "worker /stats returned no body"));
    markSessionDegraded(payload.session_id ?? "");
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: withNotice(formatDegradedBanner(stats.timedOut ? "worker timed out" : "worker not reachable"))
    }));
  }
}
if (isMainModule(import.meta)) {
  try {
    await main2();
  } catch (err) {
    logHookError("SessionStart", err);
    process.exit(0);
  }
}

// src/hooks/pre-tool-use.ts
init_shared();

// src/hooks/shell-writes.ts
import { resolve as resolve7 } from "path";
var MAX_SHELL_FILES = 25;
function coarseClaimFor(cwd) {
  return `${cwd}/**`;
}
function isCoarseClaim(paths, cwd) {
  return paths.length === 1 && paths[0] === coarseClaimFor(cwd);
}
var NOT_A_FILE = /^(\/dev\/(null|stdout|stderr|tty)|nul:?|con)$/i;
var REDIRECT = /(?:^|[\s;|&])(\d?)(>>?)(?!=)\s*("[^"]*"|'[^']*'|[^\s;|&<>]+)/g;
var PS_VALUE_FLAGS = new Set(["-value", "-itemtype", "-encoding", "-force", "-pattern", "-filter"]);
var PS_PATH_FLAGS = new Set(["-path", "-filepath", "-literalpath", "-destination"]);
var PS_WRITE_CMDLETS = new Set([
  "set-content",
  "add-content",
  "out-file",
  "new-item",
  "copy-item",
  "move-item",
  "set-itemproperty",
  "remove-item",
  "rename-item",
  "clear-content"
]);
var PS_MOVES = new Set(["move-item", "rename-item"]);
function tokenize(seg) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(seg)) !== null)
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}
var CMD_PREFIXES = new Set([
  "do",
  "then",
  "else",
  "elif",
  "!",
  "time",
  "exec",
  "nohup",
  "command",
  "builtin",
  "sudo",
  "doas",
  "env",
  "xargs",
  "nice",
  "ionice"
]);
var WRAPPER_VALUE_FLAGS = new Set(["-u", "-g", "-n", "-c", "-p", "-I", "-P", "-L", "-s"]);
function cmdName(toks) {
  let i = 0;
  for (;; ) {
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]))
      i++;
    const tok = toks[i];
    if (tok === undefined)
      break;
    const base0 = (tok.split(/[\\/]/).pop() ?? tok).toLowerCase();
    if (!CMD_PREFIXES.has(base0))
      break;
    i++;
    while (i < toks.length && toks[i].startsWith("-")) {
      const flag = toks[i];
      i++;
      if (WRAPPER_VALUE_FLAGS.has(flag))
        i++;
    }
  }
  const raw = toks[i] ?? "";
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return { name: base.toLowerCase(), rest: toks.slice(i + 1) };
}
function positionals(rest, valueFlags = new Set) {
  const out = [];
  for (let i = 0;i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("-")) {
      if (valueFlags.has(t))
        i++;
      continue;
    }
    out.push(t);
  }
  return out;
}
function sedTargets(rest) {
  const inPlace = rest.some((t) => /^-i/.test(t) || t === "--in-place" || t.startsWith("--in-place="));
  if (!inPlace)
    return [];
  const scriptFlags = new Set(["-e", "-f", "--expression", "--file"]);
  const sawScriptFlag = rest.some((t) => scriptFlags.has(t));
  const pos = positionals(rest, scriptFlags);
  return sawScriptFlag ? pos : pos.slice(1);
}
function psTargets(name, rest) {
  const out = [];
  const pos = [];
  for (let i = 0;i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("-")) {
      const f = t.toLowerCase();
      const val = rest[i + 1];
      const takesValue = PS_PATH_FLAGS.has(f) || PS_VALUE_FLAGS.has(f);
      if (PS_PATH_FLAGS.has(f) && val && !val.startsWith("-"))
        out.push(val);
      if (takesValue && val && !val.startsWith("-"))
        i++;
      continue;
    }
    pos.push(t);
  }
  if (out.length > 0)
    return PS_MOVES.has(name) ? [...pos, ...out] : out;
  return pos.slice(0, 1);
}
function segmentTargets(seg, shell) {
  const toks = tokenize(seg);
  if (toks.length === 0)
    return { targets: [], mutates: false };
  const { name, rest } = cmdName(toks);
  if (shell === "powershell" && PS_WRITE_CMDLETS.has(name)) {
    return { targets: psTargets(name, rest), mutates: true };
  }
  switch (name) {
    case "sed": {
      const t = sedTargets(rest);
      const inPlace = rest.some((x) => /^-i/.test(x) || x.startsWith("--in-place"));
      return { targets: t, mutates: inPlace };
    }
    case "tee":
      return { targets: positionals(rest), mutates: true };
    case "cp":
    case "install": {
      const pos = positionals(rest);
      return { targets: pos.slice(-1), mutates: true };
    }
    case "mv":
      return { targets: positionals(rest), mutates: true };
    case "dd": {
      const of = rest.find((t) => t.startsWith("of="));
      return { targets: of ? [of.slice(3)] : [], mutates: true };
    }
    case "truncate":
      return { targets: positionals(rest, new Set(["-s", "--size"])), mutates: true };
    case "rm":
    case "shred":
      return { targets: positionals(rest), mutates: true };
    default:
      return { targets: [], mutates: false };
  }
}
function unresolvable(t) {
  return t === "" || t === "-" || t.includes("$") || t.includes("`") || t.includes("%");
}
function parseWrittenPaths(command, cwd, shell = "posix") {
  try {
    if (typeof command !== "string" || command.trim() === "" || !cwd)
      return [];
    const raw = [];
    let unresolved = false;
    for (const seg of command.split(/&&|\|\||;|\||\n/)) {
      const { targets, mutates } = segmentTargets(seg, shell);
      if (mutates && targets.length === 0)
        unresolved = true;
      raw.push(...targets);
    }
    REDIRECT.lastIndex = 0;
    let m;
    while ((m = REDIRECT.exec(command)) !== null) {
      const tok = m[3] ?? "";
      if ((tok.match(/["']/g) ?? []).length % 2 === 1)
        continue;
      raw.push(tok.replace(/^["']|["']$/g, ""));
    }
    const out = [];
    const seen = new Set;
    for (const t of raw) {
      if (NOT_A_FILE.test(t))
        continue;
      if (unresolvable(t)) {
        unresolved = true;
        continue;
      }
      const abs = resolve7(cwd, shell === "powershell" ? t.replace(/\\/g, "/") : t);
      if (seen.has(abs))
        continue;
      seen.add(abs);
      out.push(abs);
      if (out.length >= MAX_SHELL_FILES)
        break;
    }
    if (out.length === 0 && unresolved)
      return [coarseClaimFor(cwd)];
    return out;
  } catch {
    return [];
  }
}

// src/hooks/pre-tool-use.ts
init_branch();
var HOOK_TIMEOUT_MS2 = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
var MAX_FILES = 25;
var SHELL_TOOLS = { Bash: "posix", PowerShell: "powershell" };
async function publishClaim(sid, cwd, touched) {
  const project = resolveProjectId(cwd);
  let files = [...touched];
  const cur = await workerFetch(`/worknote/active?session_id=${encodeURIComponent(sid)}`, { method: "GET", timeoutMs: HOOK_TIMEOUT_MS2 });
  if (cur.ok && cur.body?.claims) {
    const mine = cur.body.claims.find((c) => c.session_id === sid);
    if (mine?.files?.length)
      files = [...new Set([...mine.files, ...touched])];
  }
  if (files.length > MAX_FILES)
    files = files.slice(-MAX_FILES);
  const set = await workerFetch("/worknote/set", {
    method: "POST",
    body: { session_id: sid, agent: "claude", what: `editing ${files.length} file(s) in ${project}`, files, enrich_from_observations: true },
    timeoutMs: HOOK_TIMEOUT_MS2
  });
  logWorkerFailure("PreToolUse", "/worknote/set", set);
  if (!set.ok || !set.body)
    return null;
  const overlaps = set.body.overlaps ?? [];
  if (overlaps.length === 0)
    return null;
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
  return `WORK-BOARD OVERLAP: another captain is ${parts.join("; and is ")}. Check the captain-memo work board (work_active) and coordinate, or pick a different area, before continuing.`;
}
async function main3() {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("PreToolUse", err);
    return;
  }
  const sid = payload.session_id;
  const shell = SHELL_TOOLS[payload.tool_name ?? ""];
  const advisories = [];
  if (shell) {
    try {
      const gitWarn = await (await Promise.resolve().then(() => (init_pre_git(), exports_pre_git))).runPreGit(payload);
      if (gitWarn)
        advisories.push(gitWarn);
    } catch (err) {
      logHookError("PreToolUse", err);
    }
    const cmd = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
    let written = parseWrittenPaths(cmd, payload.cwd ?? "", shell);
    if (payload.cwd && isCoarseClaim(written, payload.cwd)) {
      const root = detectRepoRootSync(payload.cwd);
      written = root && !root.includes("/claude-1000/") ? [`${root}/**`] : [];
    }
    if (sid && written.length > 0) {
      try {
        const warn = await publishClaim(sid, payload.cwd, written);
        if (warn)
          advisories.push(warn);
      } catch (err) {
        logHookError("PreToolUse", err);
      }
    }
  } else {
    const ip = payload.tool_input ?? {};
    const fp = typeof ip.file_path === "string" ? ip.file_path : typeof ip.notebook_path === "string" ? ip.notebook_path : undefined;
    if (!sid || !fp)
      return;
    try {
      const warn = await publishClaim(sid, payload.cwd, [fp]);
      if (warn)
        advisories.push(warn);
    } catch (err) {
      logHookError("PreToolUse", err);
    }
  }
  if (advisories.length === 0)
    return;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: advisories.join(`

`) } }));
}
if (isMainModule(import.meta)) {
  try {
    await main3();
  } catch (err) {
    logHookError("PreToolUse", err);
    process.exit(0);
  }
}

// src/hooks/post-tool-use.ts
init_shared();
init_branch();

// src/shared/origin-agent.ts
var ORIGIN_AGENTS = [
  "claude-code",
  "codex",
  "cursor",
  "gemini",
  "agy",
  "opencode",
  "kimi",
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
var WRITING_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebookedit",
  "apply_patch",
  "write_file",
  "writefile",
  "replace",
  "replace_file",
  "strreplacefile"
]);
function promptNumberFromTurnId(turnId) {
  if (!turnId)
    return 0;
  let hash = 2166136261;
  for (let i = 0;i < turnId.length; i++) {
    hash ^= turnId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function patchFiles(input) {
  const value = typeof input === "string" ? input : input && typeof input === "object" ? String(input.patch ?? input.input ?? "") : "";
  const files = [];
  for (const line of value.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/.exec(line);
    if (match?.[1])
      files.push(match[1].trim());
  }
  return files;
}
function extractFiles(toolName, input, _response) {
  const read = [];
  const modified = [];
  const ip = input ?? {};
  if (typeof ip.file_path === "string") {
    if (WRITING_TOOLS.has(toolName.toLowerCase()))
      modified.push(ip.file_path);
    else
      read.push(ip.file_path);
  }
  if (typeof ip.notebook_path === "string")
    modified.push(ip.notebook_path);
  if (toolName.toLowerCase() === "apply_patch")
    modified.push(...patchFiles(input));
  return { read, modified };
}
async function main4(options = {}) {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("PostToolUse", err);
    return;
  }
  if (!payload.tool_name)
    return;
  const toolResponse = payload.tool_response ?? payload.tool_output;
  const { read, modified } = extractFiles(payload.tool_name, payload.tool_input, toolResponse);
  const event = {
    session_id: payload.session_id ?? "unknown",
    project_id: resolveProjectId(payload.cwd),
    prompt_number: payload.prompt_number ?? promptNumberFromTurnId(payload.turn_id),
    tool_name: payload.tool_name,
    tool_input_summary: summarize(payload.tool_input, 1500),
    tool_result_summary: summarize(toolResponse, 1500),
    files_read: read,
    files_modified: modified,
    ts_epoch: Math.floor(Date.now() / 1000),
    branch: detectBranchSync(payload.cwd ?? process.cwd()),
    origin_agent: options.originAgent ?? detectOriginAgent(),
    ...options.source ? { source: options.source } : {}
  };
  const res = await workerFetch("/observation/enqueue", {
    method: "POST",
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS3
  });
  logWorkerFailure("PostToolUse", "/observation/enqueue", res);
}
if (isMainModule(import.meta)) {
  try {
    await main4();
  } catch (err) {
    logHookError("PostToolUse", err);
    process.exit(0);
  }
}

// src/hooks/stop.ts
init_shared();
init_paths();
async function main5(options = {}) {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("Stop", err);
    if (options.emitJson)
      writeStdout("{}");
    return;
  }
  if (!payload.session_id) {
    if (options.emitJson)
      writeStdout("{}");
    return;
  }
  const res = await workerFetch("/observation/flush", {
    method: "POST",
    body: { session_id: payload.session_id, max: 200 },
    timeoutMs: DEFAULT_STOP_DRAIN_BUDGET_MS
  });
  logWorkerFailure("Stop", "/observation/flush", res);
  if (options.emitJson) {
    writeStdout("{}");
    return;
  }
  if (res.ok && consumeSessionDegraded(payload.session_id)) {
    writeStdout(JSON.stringify({
      systemMessage: "\u2693 Captain Memo is back online \u2014 memory is active again for this session."
    }));
  }
}
if (isMainModule(import.meta)) {
  try {
    await main5();
  } catch (err) {
    logHookError("Stop", err);
    process.exit(0);
  }
}

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
if (isMainModule(import.meta)) {
  try {
    await main6();
  } catch (err) {
    logHookError("PreCompact", err);
    process.exit(0);
  }
}

// src/hooks/dispatcher.ts
var EVENTS = {
  UserPromptSubmit: main,
  SessionStart: main2,
  PreToolUse: main3,
  PostToolUse: main4,
  Stop: main5,
  PreCompact: main6,
  CodexUserPromptSubmit: () => main({ emitOriginalPrompt: false, structuredContextJson: true }),
  CodexPostToolUse: () => main4({ originAgent: "codex", source: "hook:codex" }),
  CodexStop: () => main5({ emitJson: true }),
  GeminiBeforeAgent: () => main({ emitOriginalPrompt: false, structuredContextJson: true, contextEventName: "BeforeAgent" }),
  GeminiAfterTool: () => main4({ originAgent: "gemini", source: "hook:gemini" }),
  GeminiAfterAgent: () => main5({ emitJson: true }),
  KimiUserPromptSubmit: () => main({ emitOriginalPrompt: false }),
  KimiPostToolUse: () => main4({ originAgent: "kimi", source: "hook:kimi" }),
  KimiStop: () => main5()
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
