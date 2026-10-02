#!/usr/bin/env bun
// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};

// src/shared/paths.ts
import { homedir } from "os";
import { join } from "path";
var DATA_DIR, META_DB_PATH, QUEUE_DB_PATH, OBSERVATIONS_DB_PATH, PENDING_EMBED_DB_PATH, VECTOR_DB_DIR, LOGS_DIR, ARCHIVE_DIR, CONFIG_PATH, CONFIG_DIR, WORKER_ENV_PATH, DEFAULT_WORKER_PORT = 39888, ENV_HOOK_TIMEOUT_MS = "CAPTAIN_MEMO_HOOK_TIMEOUT_MS", DEFAULT_HOOK_TIMEOUT_MS = 1500, NATIVE_PROMPT_HOOK_TIMEOUT_S = 5, DEFAULT_STOP_DRAIN_BUDGET_MS = 5000, DEFAULT_REMEMBER_DIR;
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

// src/worker/branch.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
function detectBranchSync(cwd) {
  if (!existsSync(cwd))
    return null;
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8", timeout: 2000 });
    if (result.status !== 0)
      return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
function detectRepoRootSync(cwd) {
  if (!existsSync(cwd))
    return null;
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf-8", timeout: 2000 });
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

// src/shared/worker-env.ts
function workerEnvLoadedKeys() {
  return loadedKeys;
}
var loadedKeys;
var init_worker_env = __esm(() => {
  init_paths();
  loadedKeys = new Set;
});

// src/shared/worker-auth.ts
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { dirname, join as join2 } from "path";
function readWorkerToken(path = WORKER_TOKEN_PATH) {
  try {
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}
function workerAuthHeaders(path = WORKER_TOKEN_PATH) {
  const t = readWorkerToken(path);
  return t ? { [WORKER_TOKEN_HEADER]: t } : {};
}
var WORKER_TOKEN_HEADER = "x-captain-memo-worker-token", WORKER_TOKEN_PATH;
var init_worker_auth = __esm(() => {
  init_paths();
  init_worker_env();
  WORKER_TOKEN_PATH = join2(CONFIG_DIR, "worker.token");
});

// src/hooks/shared.ts
import { appendFileSync, mkdirSync as mkdirSync2, statSync as statSync2, renameSync, existsSync as existsSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join3, resolve, isAbsolute } from "path";
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
    if (!existsSync2(HOOK_LOG_FILE))
      return;
    const sz = statSync2(HOOK_LOG_FILE).size;
    if (sz < HOOK_LOG_ROTATE_BYTES)
      return;
    renameSync(HOOK_LOG_FILE, HOOK_LOG_FILE + ".1");
  } catch {}
}
function logHookError(event, err) {
  try {
    mkdirSync2(HOOK_LOG_DIR, { recursive: true });
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
      signal: controller.signal,
      headers: { ...workerAuthHeaders(), ...opts.body !== undefined ? { "content-type": "application/json" } : {} }
    };
    if (opts.body !== undefined) {
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
function staleNote(peer) {
  if (!peer.stale)
    return "";
  const ago = typeof peer.age_s === "number" ? `${Math.round(peer.age_s / 60)}m` : "a while";
  return `stale: no edit for ${ago}, may be reading or ended`;
}
function resolveProjectId(cwd) {
  if (process.env.CAPTAIN_MEMO_PROJECT_ID && !workerEnvLoadedKeys().has("CAPTAIN_MEMO_PROJECT_ID"))
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
function absoluteClaimFiles(files, cwd) {
  if (!cwd || cwd === "/" || files.every((f) => typeof f !== "string" || isAbsolute(f)))
    return files;
  const base = detectRepoRootSync(cwd) ?? cwd;
  return files.map((f) => typeof f === "string" && !isAbsolute(f) ? resolve(base, f.trim() === "" || f.trim() === "." ? "**" : f) + (/[\\/]$/.test(f) ? "/" : "") : f);
}
var HOOK_LOG_DIR, HOOK_LOG_FILE, HOOK_LOG_ROTATE_BYTES, WORKER_BASE;
var init_shared = __esm(() => {
  init_paths();
  init_branch();
  init_worker_env();
  init_worker_auth();
  HOOK_LOG_DIR = join3(homedir2(), ".captain-memo", "logs");
  HOOK_LOG_FILE = join3(HOOK_LOG_DIR, "hook.log");
  HOOK_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
  WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;
});

// src/shared/worker-transition.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, readdirSync, renameSync as renameSync2, statSync as statSync3, unlinkSync, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname2, join as join4 } from "path";
function markTransition(t, path = TRANSITION_PATH, now = Date.now()) {
  try {
    const live = readTransition(path, now);
    const entry = {
      ...t,
      ...t.from === undefined && live?.from !== undefined ? { from: live.from } : {},
      ...t.to === undefined && live?.to !== undefined ? { to: live.to } : {},
      ts: live?.ts ?? now
    };
    mkdirSync3(dirname2(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync2(tmp, JSON.stringify(entry), "utf-8");
    renameSync2(tmp, path);
    return true;
  } catch {
    return false;
  }
}
function readTransition(path = TRANSITION_PATH, now = Date.now()) {
  try {
    const t = JSON.parse(readFileSync2(path, "utf-8"));
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
function degradedPath(sessionId, dataDir) {
  return join4(dataDir, `${DEGRADED_PREFIX}${sessionId.replace(/[^a-zA-Z0-9_-]/g, "")}`);
}
function markSessionDegraded(sessionId, dataDir = DATA_DIR) {
  if (!sessionId)
    return false;
  const now = Date.now();
  try {
    mkdirSync3(dataDir, { recursive: true });
    writeFileSync2(degradedPath(sessionId, dataDir), new Date(now).toISOString(), "utf-8");
    for (const f of readdirSync(dataDir)) {
      if (!f.startsWith(DEGRADED_PREFIX))
        continue;
      const p = join4(dataDir, f);
      try {
        if (now - statSync3(p).mtimeMs > DEGRADED_MAX_AGE_MS)
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
    statSync3(p);
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
var TRANSITION_PATH, TRANSITION_TTL_MS = 120000, DEGRADED_PREFIX = ".degraded-", DEGRADED_MAX_AGE_MS;
var init_worker_transition = __esm(() => {
  init_paths();
  TRANSITION_PATH = join4(DATA_DIR, ".worker-transition");
  DEGRADED_MAX_AGE_MS = 24 * 60 * 60000;
});

// src/shared/worker-heal-lock.ts
import { openSync, closeSync, readFileSync as readFileSync3, unlinkSync as unlinkSync2, writeSync } from "fs";
import { join as join5 } from "path";
function acquireHealLock(lockPath = HEAL_LOCK_PATH, now = Date.now()) {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(now));
    closeSync(fd);
    return true;
  } catch {
    try {
      const stamp = Number(readFileSync3(lockPath, "utf-8").trim());
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
  HEAL_LOCK_PATH = join5(DATA_DIR, ".worker-heal.lock");
});

// src/shared/worker-health-probe.ts
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
  const health = await readJson(port, "/health", timeoutMs, false);
  if (typeof health?.instance === "number" && Number.isFinite(health.instance))
    return health.instance;
  const stats = await readJson(port, "/stats", timeoutMs, true);
  const v = stats?.worker?.started_at_epoch;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
async function readJson(port, path, timeoutMs, okOnly) {
  const ctl = new AbortController;
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: workerAuthHeaders(), signal: ctl.signal });
    if (okOnly && !r.ok)
      return null;
    return await r.json().catch(() => null);
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
var init_worker_health_probe = __esm(() => {
  init_worker_auth();
});

// src/services/service-manager/systemd.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readFileSync as readFileSync4, rmSync, writeFileSync as writeFileSync3 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join6, resolve as resolve2 } from "path";
import { spawnSync as spawnSync2 } from "child_process";
function unitName(name) {
  return name.endsWith(".service") ? name : `${name}.service`;
}
function templateFor(name) {
  const bare = name.replace(/\.service$/, "");
  if (bare === "captain-memo-embed") {
    return join6(REPO_ROOT, "services/embed/systemd/captain-memo-embed.user.service");
  }
  return join6(REPO_ROOT, "services/worker/systemd/captain-memo-worker.user.service");
}
function systemctl(args) {
  const userR = spawnSync2("systemctl", ["--user", ...args], { encoding: "utf-8", timeout: 1e4 });
  if (userR.status === 0)
    return userR;
  const stderr = userR.stderr ?? "";
  const noUserManager = userR.error != null || /Failed to connect to (the )?bus/i.test(stderr) || /No medium found/i.test(stderr);
  if (!noUserManager)
    return userR;
  return spawnSync2("systemctl", [...args], { encoding: "utf-8", timeout: 1e4 });
}

class SystemdServiceManager {
  async install(spec) {
    const tpl = templateFor(spec.name);
    if (!existsSync3(tpl))
      throw new Error(`missing systemd unit template: ${tpl}`);
    const bun = spec.exec[0] ?? "bun";
    const unit = readFileSync4(tpl, "utf-8").replaceAll("__INSTALL_DIR__", spec.workingDir).replaceAll("__ENV_FILE__", spec.envFile ?? "").replaceAll("__BUN__", bun);
    if (!existsSync3(USER_SYSTEMD_DIR))
      mkdirSync4(USER_SYSTEMD_DIR, { recursive: true });
    writeFileSync3(join6(USER_SYSTEMD_DIR, unitName(spec.name)), unit, { mode: 420 });
    systemctl(["daemon-reload"]);
    if (spec.autostart)
      systemctl(["enable", unitName(spec.name)]);
    systemctl(["restart", unitName(spec.name)]);
  }
  async remove(name) {
    systemctl(["stop", unitName(name)]);
    systemctl(["disable", unitName(name)]);
    const unitPath = join6(USER_SYSTEMD_DIR, unitName(name));
    if (existsSync3(unitPath))
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
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: workerAuthHeaders(), signal: ctl.signal });
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
  init_worker_auth();
  REPO_ROOT = resolve2(import.meta.dir, "../../..");
  USER_SYSTEMD_DIR = join6(homedir3(), ".config/systemd/user");
});

// src/services/service-manager/launchd.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync5, readFileSync as readFileSync5, rmSync as rmSync2, writeFileSync as writeFileSync4 } from "fs";
import { homedir as homedir4, userInfo } from "os";
import { join as join7, resolve as resolve3 } from "path";
import { spawnSync as spawnSync3 } from "child_process";
function bareName(name) {
  return name.replace(/\.service$/, "");
}
function labelFor(name) {
  return `com.captainmemo.${bareName(name).replace(/^captain-memo-/, "")}`;
}
function plistPath(name) {
  return join7(LAUNCH_AGENTS_DIR, `${labelFor(name)}.plist`);
}
function domainTarget(name) {
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  return name ? `gui/${uid}/${labelFor(name)}` : `gui/${uid}`;
}
function templateFor2(name) {
  const bare = bareName(name);
  if (bare === "captain-memo-embed") {
    return join7(REPO_ROOT2, "services/embed/launchd/captain-memo-embed.plist");
  }
  return join7(REPO_ROOT2, "services/worker/launchd/captain-memo-worker.plist");
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
  const r = spawnSync3("launchctl", args, { encoding: "utf-8", timeout: LAUNCHCTL_TIMEOUT_MS });
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
    if (!existsSync4(tpl))
      throw new Error(`missing launchd plist template: ${tpl}`);
    const plist = renderPlist(spec, readFileSync5(tpl, "utf-8"));
    if (!existsSync4(LAUNCH_AGENTS_DIR))
      mkdirSync5(LAUNCH_AGENTS_DIR, { recursive: true });
    const logDir = spec.logDir || DEFAULT_LOG_DIR;
    if (!existsSync4(logDir))
      mkdirSync5(logDir, { recursive: true });
    const path = plistPath(spec.name);
    writeFileSync4(path, plist, { mode: 420 });
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
    if (existsSync4(path))
      rmSync2(path, { force: true });
  }
  async start(name) {
    if (!await this.isLoaded(name)) {
      const path = plistPath(name);
      if (!existsSync4(path))
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
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: workerAuthHeaders(), signal: ctl.signal });
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
      return existsSync4(plistPath(name)) ? "stopped" : "not-installed";
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
  init_worker_auth();
  REPO_ROOT2 = resolve3(import.meta.dir, "../../..");
  LAUNCH_AGENTS_DIR = join7(homedir4(), "Library/LaunchAgents");
  DEFAULT_LOG_DIR = LOGS_DIR;
});

// src/services/service-manager/windows-scheduled-task.ts
import { writeFileSync as writeFileSync5, rmSync as rmSync3 } from "fs";
import { tmpdir } from "os";
import { join as join8 } from "path";
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
    const xmlPath = join8(tmpdir(), `captain-memo-task-${spec.name}-${process.pid}-${Date.now()}.xml`);
    writeFileSync5(xmlPath, toTaskXmlBuffer(xml));
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
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", headers: workerAuthHeaders(), signal: ctl.signal });
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
  init_worker_auth();
  PS_PREFIX_ARGS = ["-NoProfile", "-NonInteractive", "-Command"];
});

// src/services/service-manager/index.ts
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
async function restartWorker(sm, name, opts) {
  await sm.restart(name, { graceful: opts.graceful ?? false, port: opts.port, force: true });
}

// package.json
var package_default;
var init_package = __esm(() => {
  package_default = {
    name: "captain-memo",
    version: "0.57.2",
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
      "build:plugin": `bun build src/mcp-server.ts --target bun --outfile plugin/dist/mcp-server.js && bun build bin/captain-memo-hook.ts --target bun --outfile plugin/dist/captain-memo-hook.js && bun -e "require('fs').copyFileSync('skills/captain-memo/SKILL.md','plugin/portable/captain-memo/SKILL.md')"`
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
      "ip-address": "^10.7.2"
    },
    devDependencies: {
      "@types/bun": "^1.1.0",
      "@types/node": "^20.0.0",
      typescript: "^5.6.0"
    }
  };
});

// src/shared/version.ts
var VERSION;
var init_version = __esm(() => {
  init_package();
  VERSION = package_default.version;
});

// src/shared/self-update.ts
import { mkdirSync as mkdirSync6, readFileSync as readFileSync6, writeFileSync as writeFileSync6, renameSync as renameSync3 } from "fs";
import { join as join9 } from "path";
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
function formatUpgradeBanner(from, to, news = []) {
  return [
    `\u2693 Captain Memo self-upgraded: v${from} \u2192 v${to}`,
    ...news,
    "  The worker restarts automatically to pick up the new version.",
    "  Run `captain-memo install` if you want a full refresh (hooks/MCP/services)."
  ].join(`
`);
}
function formatAutoUpdateBanner(from, to, installFailed, news = []) {
  const lines = [
    `\u2693 Captain Memo auto-updated: v${from} \u2192 v${to}`,
    ...news,
    "  Fast-forwarded your checkout to the latest stable tag and restarted the worker."
  ];
  if (installFailed)
    lines.push("  \u26A0 `bun install` failed \u2014 run it in your checkout if the worker misbehaves.");
  lines.push("  Opt out with CAPTAIN_MEMO_AUTO_UPDATE=0.");
  return lines.join(`
`);
}
function formatAutoUpdateBlockedBanner(from, code, reason) {
  return [
    `\u2693 Captain Memo auto-update is BLOCKED: a newer release is available but was not applied (${reason || code || "unknown reason"}).`,
    `  Your checkout stays on v${from} until this is fixed: commit or stash local edits and make sure a branch is checked out,`,
    "  or update by hand with `git pull` and `captain-memo install`."
  ].join(`
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
  return join9(dataDir, MARKER_FILENAME);
}
function readMarker(dataDir) {
  try {
    const raw = readFileSync6(markerPath(dataDir), "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}
function writeMarker(dataDir, version) {
  try {
    mkdirSync6(dataDir, { recursive: true });
    const final = markerPath(dataDir);
    const tmp = `${final}.tmp-${process.pid}`;
    writeFileSync6(tmp, `${version}
`, "utf-8");
    renameSync3(tmp, final);
  } catch {}
}
function consumeUpgrade(dataDir, runningVersion) {
  try {
    const marker = readMarker(dataDir);
    const action = decideUpdateAction(runningVersion, marker);
    if (action === "same-or-older")
      return null;
    writeMarker(dataDir, runningVersion);
    return action === "upgraded" ? { from: marker, to: runningVersion } : null;
  } catch {
    return null;
  }
}
var MARKER_FILENAME = ".install-version";
var init_self_update = () => {};

// src/worker/self-updater.ts
function updateCheckIntervalFromEnv(raw) {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_UPDATE_CHECK_INTERVAL_MS;
}
function nextUpdateCheckDelayMs(baseMs, failures, rand = Math.random()) {
  const backoff = Math.min(baseMs * 2 ** Math.min(Math.max(failures, 0), 16), Math.max(baseMs, UPDATE_CHECK_BACKOFF_CAP_MS));
  return backoff + Math.floor(rand * Math.min(UPDATE_CHECK_JITTER_MAX_MS, baseMs / 6));
}
function formatUpdateStamp(at, delayMs, failures) {
  return `${at.toISOString()} delay_ms=${Math.round(delayMs)} failures=${failures}
`;
}
function parseUpdateStamp(text) {
  const d = /delay_ms=(\d+)/.exec(text);
  const f = /failures=(\d+)/.exec(text);
  return { delayMs: d ? Number(d[1]) : null, failures: f ? Number(f[1]) : 0 };
}
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
var DEFAULT_UPDATE_CHECK_INTERVAL_MS, UPDATE_CHECK_JITTER_MAX_MS, UPDATE_CHECK_BACKOFF_CAP_MS;
var init_self_updater = __esm(() => {
  init_self_update();
  DEFAULT_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
  UPDATE_CHECK_JITTER_MAX_MS = 10 * 60 * 1000;
  UPDATE_CHECK_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
});

// src/hooks/auto-update.ts
import { mkdirSync as mkdirSync7, readFileSync as readFileSync7, statSync as statSync4, writeFileSync as writeFileSync7 } from "fs";
import { join as join10 } from "path";
function readPkgField(dir, field) {
  try {
    return JSON.parse(readFileSync7(join10(dir, "package.json"), "utf-8"))[field] ?? null;
  } catch {
    return null;
  }
}
function gitTimeoutFor(argv, requestedMs, networkCapMs) {
  const network = argv[1] === "fetch" || argv[1] === "ls-remote";
  return Math.min(requestedMs ?? 20000, network ? networkCapMs ?? Infinity : Infinity);
}
async function awaitNewProcess(before, port, read, o) {
  const probe = o.probe ?? ((p) => probeHealthOnce(p, 1500));
  const { waitMs, pollMs } = o.bootWait ?? { waitMs: 30000, pollMs: 500 };
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const cur = await read(port);
    if (cur !== null && (before === null || cur > before))
      return true;
    if (before === null && await probe(port))
      return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}
function readSkippedRelease() {
  try {
    return readFileSync7(SKIPPED_RELEASE_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
async function runAutoUpdatePass(o) {
  let wroteTransition = false;
  const readInstance = o.readInstance ?? ((p) => readWorkerInstance(p, 1500));
  try {
    const port = o.port ?? {
      run: (argv, cwd, timeoutMs) => {
        const r = Bun.spawnSync(argv, {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          timeout: gitTimeoutFor(argv, timeoutMs, o.networkTimeoutMs),
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oConnectTimeout=10" }
        });
        return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
      },
      readPackageVersion: (dir) => readPkgField(dir, "version"),
      readPackageName: (dir) => readPkgField(dir, "name")
    };
    let fetchFailed = false;
    const runGit = port.run;
    port.run = (argv, cwd, timeoutMs) => {
      const r = runGit(argv, cwd, timeoutMs);
      if (argv[1] === "fetch" && r.code !== 0)
        fetchFailed = true;
      return r;
    };
    const intervalMs = updateCheckIntervalFromEnv(process.env.CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS);
    try {
      mkdirSync7(DATA_DIR, { recursive: true });
    } catch {}
    let lastCheck = null;
    let stamp = { delayMs: null, failures: 0 };
    try {
      lastCheck = statSync4(UPDATE_STAMP).mtimeMs;
      stamp = parseUpdateStamp(readFileSync7(UPDATE_STAMP, "utf-8"));
    } catch {}
    const writeStamp = (failures) => {
      try {
        writeFileSync7(UPDATE_STAMP, formatUpdateStamp(new Date, nextUpdateCheckDelayMs(intervalMs, failures), failures));
      } catch {}
    };
    if (!isUpdateCheckDue(lastCheck, Date.now(), stamp.delayMs ?? intervalMs) || !acquireHealLock(AUTO_UPDATE_LOCK))
      return { kind: "none" };
    try {
      writeStamp(stamp.failures + 1);
      const version = o.version ?? VERSION;
      const top = port.run(["git", "rev-parse", "--show-toplevel"], import.meta.dir);
      const installDir = top.code === 0 && top.stdout.trim() ? top.stdout.trim() : import.meta.dir;
      const skipped = readSkippedRelease();
      const res = runAutoUpdate(port, installDir, skipped && compareSemver(skipped, version) > 0 ? skipped : version, process.execPath);
      if (res)
        res.from = version;
      writeStamp(fetchFailed ? stamp.failures + 1 : 0);
      if (res?.ok) {
        const wport = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
        const restart = o.restart ?? (async (graceful) => {
          await Promise.resolve().then(() => init_service_manager());
          await restartWorker(getServiceManager(), "captain-memo-worker", graceful ? { port: wport, graceful: true } : { port: wport });
        });
        wroteTransition = true;
        const outgoing = await readInstance(wport);
        markTransition({ phase: "updating", from: res.from, ...res.to ? { to: res.to } : {} });
        await restart(true);
        if (await awaitNewProcess(outgoing, wport, readInstance, o)) {
          await o.afterBoot?.();
          return { kind: "updated", res };
        }
        const failed = await readInstance(wport);
        const rolled = res.priorSha ? rollbackTo(port, installDir, res.priorSha, process.execPath) : false;
        if (res.to) {
          try {
            writeFileSync7(SKIPPED_RELEASE_FILE, res.to + `
`);
          } catch {}
        }
        markTransition({ phase: "updating", to: res.from });
        await restart(false);
        if (!await awaitNewProcess(failed, wport, readInstance, o)) {
          clearTransition();
          wroteTransition = false;
        }
        logHookError(o.event, new Error(`auto-update to ${res.to} failed to boot; rolled back=${rolled}`));
        return { kind: "rolled-back", res, rolled };
      }
      if (res && !res.ok) {
        logHookError(o.event, new Error(`auto-update skipped: ${res.code} \u2014 ${res.reason}`));
        return { kind: "blocked", res };
      }
      return { kind: "none" };
    } finally {
      releaseHealLock(AUTO_UPDATE_LOCK);
    }
  } catch (err) {
    if (wroteTransition)
      clearTransition();
    logHookError(o.event, err);
    return { kind: "none" };
  }
}
var AUTO_UPDATE_LOCK, UPDATE_STAMP, SKIPPED_RELEASE_FILE;
var init_auto_update = __esm(() => {
  init_paths();
  init_version();
  init_self_update();
  init_self_updater();
  init_worker_transition();
  init_worker_heal_lock();
  init_worker_health_probe();
  init_shared();
  AUTO_UPDATE_LOCK = join10(DATA_DIR, ".auto-update.lock");
  UPDATE_STAMP = join10(DATA_DIR, ".last-update-check");
  SKIPPED_RELEASE_FILE = join10(DATA_DIR, ".auto-update-skip");
});

// src/shared/plugin-cache.ts
import { existsSync as existsSync5, readFileSync as readFileSync8, readdirSync as readdirSync2, statSync as statSync5 } from "fs";
import { homedir as homedir5 } from "os";
import { join as join11 } from "path";
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
    const m = JSON.parse(readFileSync8(join11(root, ".claude-plugin", "plugin.json"), "utf-8"));
    if (typeof m.name !== "string")
      return null;
    return { name: m.name, version: typeof m.version === "string" ? m.version : null };
  } catch {
    return null;
  }
}
function readInstalledPaths(file = INSTALLED_PLUGINS_PATH) {
  try {
    return parseInstalledPaths(readFileSync8(file, "utf-8"));
  } catch {
    return null;
  }
}
var CACHE_ROOT, INSTALLED_PLUGINS_PATH;
var init_plugin_cache = __esm(() => {
  CACHE_ROOT = join11(homedir5(), ".claude", "plugins", "cache");
  INSTALLED_PLUGINS_PATH = join11(homedir5(), ".claude", "plugins", "installed_plugins.json");
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

// src/shared/summarizer-login.ts
var init_summarizer_login = () => {};

// src/cli/commands/install-hooks.ts
var init_install_hooks = () => {};

// src/services/embedder-installer/bash.ts
import { join as join12, resolve as resolve4 } from "path";
var REPO_ROOT3, SCRIPT;
var init_bash = __esm(() => {
  REPO_ROOT3 = resolve4(import.meta.dir, "../../..");
  SCRIPT = join12(REPO_ROOT3, "scripts/install-embedder.sh");
});

// src/services/embedder-installer/powershell.ts
import { join as join13, resolve as resolve5 } from "path";
var REPO_ROOT4, SCRIPT2;
var init_powershell = __esm(() => {
  REPO_ROOT4 = resolve5(import.meta.dir, "../../..");
  SCRIPT2 = join13(REPO_ROOT4, "scripts/install-embedder.ps1");
});

// src/services/embedder-installer/index.ts
var init_embedder_installer = __esm(() => {
  init_platform();
  init_bash();
  init_powershell();
});

// src/shared/vscode-paths.ts
function vscodeUserDirSegments(os) {
  if (os === "win32")
    return ["AppData", "Roaming", "Code", "User"];
  if (os === "darwin")
    return ["Library", "Application Support", "Code", "User"];
  return [".config", "Code", "User"];
}
var VSCODE_OSES;
var init_vscode_paths = __esm(() => {
  VSCODE_OSES = ["win32", "darwin", "linux"];
});

// src/cli/cross-ai.ts
var PROBE_CLEAR, bunYaml, OPENCODE_LOCAL_PROVIDERS, OPENCODE_LOCAL_PROVIDER_KEYS;
var init_cross_ai = __esm(() => {
  init_platform();
  init_vscode_paths();
  init_paths();
  init_self_update();
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
import { dirname as dirname3, join as join14, resolve as resolve6 } from "path";
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
  PLUGIN_LINK = join14(homedir7(), ".claude", "plugins", "captain-memo");
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
import { spawnSync as spawnSync4 } from "child_process";
import { readFileSync as readFileSync9 } from "fs";
import { homedir as homedir8 } from "os";
import { join as join15 } from "path";
function marketplacePointsAtCheckout(repoRoot, home = homedir8()) {
  try {
    const file = join15(home, ".claude", "plugins", "known_marketplaces.json");
    const parsed = JSON.parse(readFileSync9(file, "utf-8"));
    const src = parsed["captain-memo"]?.source;
    return src?.source === "directory" && typeof src.path === "string" && normalizePath(src.path) === normalizePath(repoRoot);
  } catch {
    return false;
  }
}
function activeCachedVersion(home = homedir8()) {
  const installed = readInstalledPaths(join15(home, ".claude", "plugins", "installed_plugins.json"));
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
    const r = spawnSync4("claude", args, { stdio: "pipe", timeout: 120000 });
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
  REPO_ROOT6 = join15(import.meta.dir, "..", "..");
});

// src/cli/skill-refresh.ts
import { existsSync as existsSync6, copyFileSync } from "fs";
import { join as join16 } from "path";
function resolveMemoSkillSource(base = import.meta.dir) {
  return [
    join16(base, "..", "..", "skills", "captain-memo", "SKILL.md"),
    join16(base, "..", "portable", "captain-memo", "SKILL.md")
  ].find((p) => existsSync6(p)) ?? null;
}
function refreshMemoSkills(source, home, deps = {}) {
  const exists = deps.exists ?? existsSync6;
  const copy = deps.copy ?? copyFileSync;
  if (!exists(source))
    return [];
  const refreshed = [];
  for (const rel of [...MEMO_SKILL_RELPATHS, ...VSCODE_SKILL_RELPATHS]) {
    const dest = join16(home, ...rel.split("/"));
    if (!exists(dest))
      continue;
    try {
      copy(source, dest);
      refreshed.push(dest);
    } catch {}
  }
  return refreshed;
}
var MEMO_SKILL_RELPATHS, VSCODE_SKILL_RELPATHS;
var init_skill_refresh = __esm(() => {
  init_vscode_paths();
  MEMO_SKILL_RELPATHS = [
    ".codex/skills/captain-memo/SKILL.md",
    ".gemini/skills/captain-memo/SKILL.md",
    ".cursor/rules/captain-memo.md",
    ".config/opencode/skills/captain-memo/SKILL.md",
    ".vibe/skills/captain-memo/SKILL.md",
    ".kimi/skills/captain-memo/SKILL.md",
    ".config/JetBrains/captain-memo.md"
  ];
  VSCODE_SKILL_RELPATHS = VSCODE_OSES.map((os) => [...vscodeUserDirSegments(os), "prompts", "captain-memo.instructions.md"].join("/"));
});

// src/hooks/pre-git.ts
var exports_pre_git = {};
__export(exports_pre_git, {
  runPreGit: () => runPreGit
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
  const res = await workerFetch(`/worknote/repo-active?repo_root=${encodeURIComponent(root)}`, { method: "GET", timeoutMs: HOOK_TIMEOUT_MS2 });
  if (!res.ok || !res.body?.holders)
    return null;
  const peers = res.body.holders.filter((h) => h.session_id !== payload.session_id);
  if (peers.length === 0)
    return null;
  const who = peers.map((h) => `${(h.session_id ?? "").slice(0, 12)} (${h.agent ?? "?"})${h.branch ? ` on ${h.branch}` : ""}${h.is_dirty ? ", dirty" : ""}${h.stale ? `, ${staleNote(h)}` : ""}`).join(" ; ");
  return `WORK-BOARD SHARED CHECKOUT: peer session(s) are using ${root} \u2014 ${who}. Running \`git ${op}\` here changes that shared working tree for them. Isolate instead: \`git worktree add ../<name> <branch>\` and work there. (advisory)`;
}
var MUTATING, HOOK_TIMEOUT_MS2;
var init_pre_git = __esm(() => {
  init_shared();
  init_branch();
  MUTATING = /^(checkout|switch|commit|reset|stash|rebase|merge|cherry-pick|clean|restore)$/;
  HOOK_TIMEOUT_MS2 = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
});

// src/hooks/dispatcher.ts
init_shared();
init_paths();

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
function isHomeworkDue(it, now) {
  return !!it.due && !it.done_at && Date.parse(it.due) <= now;
}
function homeworkDueFirst(items, now) {
  const due = items.filter((it) => isHomeworkDue(it, now)).sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
  return [...due, ...items.filter((it) => !isHomeworkDue(it, now))];
}
function homeworkDueParts(it, now) {
  if (!it.due || it.done_at)
    return ["", ""];
  const at = new Date(it.due).toLocaleString("sv-SE").slice(0, 16);
  return isHomeworkDue(it, now) ? ["\u23F0 ", ` (DUE since ${at})`] : ["", ` (due ${at})`];
}

// src/hooks/user-prompt-submit.ts
init_worker_transition();
var HOST_EXIT_MARGIN_MS = 750;
function homeworkWaitMs(hostTimeoutMs, elapsedMs) {
  if (hostTimeoutMs === undefined)
    return 6000;
  return Math.max(0, Math.min(6000, hostTimeoutMs - elapsedMs - HOST_EXIT_MARGIN_MS));
}
function parseOverridePrompt(prompt2, cwd) {
  const m = /^\s*override\s*:\s*(\S[\s\S]*)$/i.exec(String(prompt2 ?? "").split(/\r?\n/)[0] ?? "");
  if (!m)
    return null;
  const raw = m[1].split(/[\s,]+/).map((f) => f.replace(/^[`'"]+|[`'".]+$/g, "")).filter(Boolean);
  const remote = (f) => /^(?:[^@\s:/]+@)?[^@\s:/]{2,}:/.test(f);
  const local = absoluteClaimFiles(raw.filter((f) => !remote(f)), cwd ?? "").filter((f) => typeof f === "string");
  const files = [...local, ...raw.filter(remote)];
  return files.length ? files : null;
}
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
    const filed = await workerFetch("/homework/add", { method: "POST", body: { text: homework, by: payload.session_id ?? "hook", project: resolveProjectId(payload.cwd) }, timeoutMs: homeworkWaitMs(options.hostTimeoutMs, performance.now()) });
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
  const overrideFiles = payload.session_id ? parseOverridePrompt(prompt2, payload.cwd) : null;
  if (overrideFiles) {
    const r = await workerFetch("/worknote/override", { method: "POST", body: { session_id: payload.session_id, files: overrideFiles }, timeoutMs: 2000 });
    logWorkerFailure("UserPromptSubmit", "/worknote/override", r);
    const line = r.ok && r.body ? `Override recorded for ${r.body.files.join(", ")} (30 min); ${r.body.holders.length ? `holder(s) ${r.body.holders.join(", ")} will see it on the work board` : "no live holder"}.` : "The worker did not confirm the override, so the work-board block still stands. Tell the user; they can retry.";
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
      await Promise.resolve().then(() => init_worker_heal_lock());
      if (acquireHealLock()) {
        try {
          await Promise.resolve().then(() => init_worker_health_probe());
          const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
          const reachable = await probeHealthyWithRetries(() => probeHealthOnce(port, 1500), 2, 1000);
          if (!reachable) {
            await Promise.resolve().then(() => init_service_manager());
            await Promise.resolve();
            await restartWorker(getServiceManager(), "captain-memo-worker", { port });
          }
        } finally {
          releaseHealLock();
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
  if (result.ok && process.env.CAPTAIN_MEMO_AUTO_UPDATE === "1" && options.hostTimeoutMs === undefined) {
    try {
      await Promise.resolve().then(() => init_auto_update());
      const out = await runAutoUpdatePass({ event: "UserPromptSubmit", networkTimeoutMs: 8000 });
      if (out.kind === "updated")
        logHookError("UserPromptSubmit", new Error(`auto-updated v${out.res.from} -> v${out.res.to ?? "?"}`));
    } catch (err) {
      logHookError("UserPromptSubmit", err);
    }
  }
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
import { join as join17 } from "path";
import { homedir as homedir9 } from "os";

// src/hooks/local-articles.ts
var LOCAL_ARTICLES = [
  "## Captain Memo articles: you are one AI among several sessions on this machine",
  "",
  "FOUNDATION: THE WORK BOARD. Every session, before anything else.",
  "- LOOK FIRST: `work_active()` before your first edit, to see what other sessions hold.",
  '- CLAIM BEFORE TOUCHING ANYTHING: `work_set("<what>", { topics: [1-5 tags], files: [paths] })`; list EVERY file you will write, append to or deploy, as ABSOLUTE paths.',
  '- RE-CHECK `work_active` before writing a shared file, before commit/checkout/reset/stash/add, and before any deploy (scp, rsync): never ship an earlier build or "HEAD + my hunk" around another session\'s work; deploy only if the remote md5 equals what you last read.',
  "- RESPECT A CLAIM: never edit or deploy over another session's claim. Stop and tell the user which session holds it, and let them decide. A LIVE claim (Claude Code, Codex or Gemini) BLOCKS your edit and upload; only the user lifts it (`override: <file>`). Stale means no recent edit, not ended: it may only be reading.",
  "- RELEASE with `work_clear` only once committed AND deployed; re-`work_set` after a long pause.",
  "- ONE TREE PER SESSION: your own `git worktree add ../<n>`; in a shared tree `git add <paths>`, never -A.",
  "- AUTO-CLAIM (Claude Code, Codex, Gemini) records touched files but INFERS the why and can miss: state intent yourself with `work_set`. Elsewhere nothing claims for you.",
  "Why: 2026-09-30, two sessions in one checkout skipped these and each deployed over the other.",
  "",
  "1. SEARCH BEFORE YOU ACT: `search_all` first, grep second; `remember` the non-obvious, with the WHY.",
  `2. NEVER GUESS: verify against memory, the repo's docs, the code path INCLUDING its call sites, and the live data; else say "I have not verified X".`,
  "3. COMMITTED IS NOT DEPLOYED: before reporting done, check the RUNNING process started AFTER your edit; an older one serves old code.",
  "4. ASK when intent is ambiguous (verification shows how something works, never what is wanted); if discovery widens the scope, stop and report before acting.",
  '5. `idea:` / `todo:` FROM THE USER IS HOMEWORK, NOT A TASK SWITCH: say "noted" (`todo_add` if no hook did). `todo_list()` = what waits; `todo_claim(id)` before starting one, `todo_done(id, note)` after. DEFERRED SCOPE IS HOMEWORK: a piece left for later? `todo_add` it that turn, unasked, say "filed as homework #N".',
  '6. TESTS ONLY WHEN ASKED: build everything first, then check by reading the diff and a syntax/type check. Run test suites only when the user says "full review" or asks, then once, never between steps. Tests and data scripts run beside the DB host, never over a WAN (~190 vs ~0.2 ms a query). Skipped? Say so.',
  "7. THE USER'S TIME IS THE COST: run independent work in parallel, review a small change yourself (no build -> review -> fix chain), say so first if something will take over ~15 min.",
  "",
  "Work-board and homework tools in full: the captain-memo skill (`skills/captain-memo/SKILL.md`)."
].join(`
`);

// src/hooks/session-start.ts
init_paths();
init_version();
init_self_update();

// src/shared/whats-new.ts
init_self_update();
var NEWS_MAX = 5;
function newsLines(items, max = NEWS_MAX) {
  if (items.length === 0)
    return [];
  const multi = new Set(items.map((i) => i.version)).size > 1;
  const lines = ["  What changed:", ...items.slice(0, max).map((i) => `  \u2022 ${i.text}${multi ? ` (${i.version})` : ""}`)];
  if (items.length > max)
    lines.push(`  \u2026 and ${items.length - max} more in CHANGELOG.md`);
  return lines;
}

// src/hooks/session-start.ts
init_auto_update();

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
init_worker_transition();
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
    const now = Date.now();
    const shown = homeworkDueFirst(homework, now).slice(0, 3).map((h) => {
      const [mark, due] = homeworkDueParts(h, now);
      return `${mark}#${h.id} ${h.text.split(`
`)[0].slice(0, 70)}${due}${h.claimed_by ? ` (claimed by ${h.claimed_by})` : ""}`;
    });
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
async function nativeMain() {
  try {
    await readStdinJson();
  } catch {}
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: LOCAL_ARTICLES } }));
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
  if (process.env.CAPTAIN_MEMO_AUTO_UPDATE === "1") {
    const out = await runAutoUpdatePass({ event: "SessionStart", afterBoot: waitWorkerHealthy });
    if (out.kind === "updated") {
      updatedThisSession = true;
      if (out.res.to)
        writeMarker(DATA_DIR, out.res.to);
      autoUpdateNotice = formatAutoUpdateBanner(out.res.from, out.res.to ?? "?", out.res.installFailed, out.res.to ? await fetchNews(out.res.from, out.res.to) : []);
    } else if (out.kind === "rolled-back") {
      stats = await probeStats();
      updatedThisSession = true;
      autoUpdateNotice = formatRollbackBanner(out.res.from, out.res.to ?? "?", out.rolled);
    } else if (out.kind === "blocked") {
      autoUpdateNotice = formatAutoUpdateBlockedBanner(out.res.from, out.res.code, out.res.reason);
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
      await Promise.resolve().then(() => init_service_manager());
      const sm = getServiceManager();
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
    await Promise.resolve().then(() => init_plugin_cache_refresh());
    const lock = join17(DATA_DIR, CACHE_REFRESH_LOCK);
    if (acquireHealLock(lock)) {
      try {
        const r = refreshPluginCacheIfStale(VERSION);
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
  try {
    await Promise.resolve().then(() => init_skill_refresh());
    const memoSource = resolveMemoSkillSource();
    if (memoSource)
      refreshMemoSkills(memoSource, homedir9());
  } catch (err) {
    logHookError("SessionStart", err);
  }
  const upgrade = consumeUpgrade(DATA_DIR, VERSION);
  const upgradeNotice = upgrade ? formatUpgradeBanner(upgrade.from, upgrade.to, await fetchNews(upgrade.from, upgrade.to)) : "";
  const notices = [autoUpdateNotice, upgradeNotice].filter(Boolean).join(`

`);
  const withNotice = (banner) => notices ? `${notices}

${banner}` : banner;
  const hw = stats.ok && stats.body ? await workerFetch("/homework/list?status=open", { method: "GET", timeoutMs: 1500 }) : null;
  const homework = hw?.ok && hw.body ? hw.body.items : [];
  const articles = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: LOCAL_ARTICLES } };
  if (stats.ok && stats.body) {
    writeStdout(JSON.stringify({
      continue: true,
      ...articles,
      systemMessage: withNotice(formatBanner(stats.body, homework))
    }));
  } else if (inTransition) {
    const willAnnounce = markSessionDegraded(payload.session_id ?? "");
    logHookError("SessionStart", new Error(`worker ${inTransition.phase} (breadcrumb ${Math.round((Date.now() - inTransition.ts) / 1000)}s old) \u2014 still unreachable after the transition wait; self-heal skipped`));
    writeStdout(JSON.stringify({
      continue: true,
      ...articles,
      systemMessage: withNotice(formatTransitionBanner(inTransition, willAnnounce))
    }));
  } else {
    logHookError("SessionStart", new Error(workerFailureMessage("/stats", stats) ?? "worker /stats returned no body"));
    markSessionDegraded(payload.session_id ?? "");
    writeStdout(JSON.stringify({
      continue: true,
      ...articles,
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
async function fetchNews(from, to) {
  try {
    const r = await workerFetch(`/whats-new?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { method: "GET", timeoutMs: 1000 });
    return r.ok && r.body ? newsLines(r.body.items) : [];
  } catch {
    return [];
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
var REDIRECT = /(?:^|[\s;|&])(\d?)(>>?)(?!=)\s*("[^"]*"|'[^']*'|[^\s;|&<>()]+)/g;
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
function inPlaceTargets(rest, isInPlace, scriptFlags) {
  if (!rest.some(isInPlace))
    return null;
  const sawScriptFlag = rest.some((t) => scriptFlags.has(t));
  const pos = positionals(rest, scriptFlags);
  return sawScriptFlag ? pos : pos.slice(1);
}
var SED_IN_PLACE = (t) => /^-i/.test(t) || t === "--in-place" || t.startsWith("--in-place=");
var SED_SCRIPT_FLAGS = new Set(["-e", "-f", "--expression", "--file"]);
var PERL_IN_PLACE = (t) => /^-[acnpsltTuUvwWX0-9]*i/.test(t);
var PERL_SCRIPT_FLAGS = new Set(["-e", "-E"]);
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
    case "sed":
    case "perl": {
      const t = name === "sed" ? inPlaceTargets(rest, SED_IN_PLACE, SED_SCRIPT_FLAGS) : inPlaceTargets(rest, PERL_IN_PLACE, PERL_SCRIPT_FLAGS);
      return { targets: t ?? [], mutates: t !== null };
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
function notAPath(t) {
  if (/[{}()<>|;"'`\[\]&]/.test(t))
    return true;
  if (/[,:]$/.test(t))
    return true;
  if (/:/.test(t.replace(/^[A-Za-z]:(?=[\\/]|$)/, "")))
    return true;
  return false;
}
function stripHeredocs(command) {
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, (_m, _q, _tag, rest) => `<<${_tag}${rest}`);
}
function maskQuotedCode(seg) {
  return seg.replace(/"[^"]*"|'[^']*'/g, (m, offset) => /(>>?)\s*$/.test(seg.slice(0, offset)) ? m : " ".repeat(m.length));
}
function chdirTarget(seg) {
  const toks = tokenize(seg);
  const { name, rest } = cmdName(toks);
  if (!["cd", "pushd", "set-location", "sl", "chdir"].includes(name))
    return null;
  const pos = positionals(rest, new Set(["-path", "-literalpath"]));
  const t = pos[0] ?? (name === "cd" || name === "pushd" ? "~" : "");
  return unresolvable(t) || notAPath(t) ? "" : t;
}
function splitSegments(command, cwd, shell = "posix") {
  const norm = (t) => shell === "powershell" ? t.replace(/\\/g, "/") : t;
  const stripped = stripHeredocs(command);
  const maskedAll = maskQuotedCode(stripped);
  const raw = [];
  let start = 0;
  let piped = false;
  for (const b of maskedAll.matchAll(/&&|\|\||;|\||\n/g)) {
    raw.push({ seg: stripped.slice(start, b.index), masked: maskedAll.slice(start, b.index), ...piped ? { piped: true } : {} });
    start = b.index + b[0].length;
    piped = b[0] === "|";
  }
  raw.push({ seg: stripped.slice(start), masked: maskedAll.slice(start), ...piped ? { piped: true } : {} });
  const out = [];
  let dir = cwd;
  for (const r of raw) {
    const cd = chdirTarget(r.seg);
    if (cd !== null) {
      dir = cd === "" || dir === null ? null : resolve7(dir, norm(cd));
      continue;
    }
    out.push({ ...r, dir });
  }
  return out;
}
function scriptWrites(command, cwd) {
  if (!cwd || !/\b(python[0-9.]*|node|bun|php|ruby)\b/.test(command) || /\bssh\s/.test(command))
    return [];
  const Q = String.raw`(['"\`])([^'"\`\n]+)\1`;
  const patterns = [
    new RegExp(String.raw`\bopen\(\s*${Q}\s*,\s*(['"])[^'"]*[wax+][^'"]*\3`, "g"),
    new RegExp(String.raw`\bPath\(\s*${Q}\s*\)\.write_(?:text|bytes)\b`, "g"),
    new RegExp(String.raw`(?:\bwriteFileSync|\bwriteFile|\bappendFileSync|\bBun\.write)\(\s*${Q}`, "g"),
    new RegExp(String.raw`\bfile_put_contents\(\s*${Q}`, "g")
  ];
  const out = [];
  for (const re of patterns) {
    for (const m of command.matchAll(re)) {
      const t = m[2] ?? "";
      if (NOT_A_FILE.test(t) || unresolvable(t) || t.includes("{") || notAPath(t))
        continue;
      const abs = resolve7(cwd, t);
      if (!out.includes(abs))
        out.push(abs);
    }
  }
  return out;
}
function parseWrittenPaths(command, cwd, shell = "posix") {
  try {
    if (typeof command !== "string" || command.trim() === "" || !cwd)
      return [];
    const raw = [];
    let unresolved = false;
    const norm = (t) => shell === "powershell" ? t.replace(/\\/g, "/") : t;
    for (const { seg, masked, dir } of splitSegments(command, cwd, shell)) {
      const { targets, mutates } = segmentTargets(seg, shell);
      if (mutates && targets.length === 0)
        unresolved = true;
      for (const t of targets)
        raw.push({ t, dir: dir ?? "" });
      REDIRECT.lastIndex = 0;
      let m;
      while ((m = REDIRECT.exec(masked)) !== null) {
        const tok = m[3] ?? "";
        if ((tok.match(/["']/g) ?? []).length % 2 === 1)
          continue;
        raw.push({ t: tok.replace(/^["']|["']$/g, ""), dir: dir ?? "" });
      }
    }
    const out = [];
    const seen = new Set;
    for (const { t, dir: d } of raw) {
      if (NOT_A_FILE.test(t))
        continue;
      if (notAPath(t))
        continue;
      if (unresolvable(t) || d === "") {
        unresolved = true;
        continue;
      }
      const abs = resolve7(d, norm(t));
      if (seen.has(abs))
        continue;
      seen.add(abs);
      out.push(abs);
      if (out.length >= MAX_SHELL_FILES)
        break;
    }
    for (const abs of scriptWrites(command, cwd)) {
      if (out.length >= MAX_SHELL_FILES)
        break;
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    }
    if (out.length === 0 && unresolved)
      return [coarseClaimFor(cwd)];
    return out;
  } catch {
    return [];
  }
}

// src/hooks/deploy-guard.ts
import { resolve as resolve8, basename, dirname as dirname4, join as join18, relative } from "path";
import { createHash } from "crypto";
import { homedir as homedir10 } from "os";
import { existsSync as existsSync7, statSync as statSync6, readFileSync as readFileSync10, writeFileSync as writeFileSync8, mkdirSync as mkdirSync8 } from "fs";
import { spawnSync as spawnSync5 } from "child_process";
init_paths();
init_branch();
function remoteSpec(t) {
  const m = /^((?:[^@\s:/]+@)?[^@\s:/]+):(.*)$/.exec(t);
  if (!m || /^[A-Za-z]$/.test(m[1]))
    return null;
  return { userhost: m[1], path: m[2] };
}
var SCP_VALUE_FLAGS = new Set(["-P", "-i", "-o", "-F", "-J", "-c", "-l", "-S"]);
var RSYNC_VALUE_FLAGS = new Set([
  "-e",
  "--rsh",
  "--exclude",
  "--include",
  "--filter",
  "-f",
  "--chmod",
  "--chown",
  "--port",
  "--rsync-path",
  "--log-file",
  "--password-file",
  "--files-from",
  "--exclude-from",
  "--include-from",
  "-T",
  "--temp-dir",
  "--partial-dir",
  "--backup-dir",
  "--suffix",
  "--timeout",
  "--bwlimit",
  "-B",
  "--block-size",
  "--compare-dest",
  "--link-dest",
  "--copy-dest"
]);
var SSH_VALUE_FLAGS = new Set(["-p", "-i", "-o", "-J", "-F", "-l", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-m", "-O", "-Q", "-S", "-W", "-w", "-B"]);
var SSH_PASS = new Set(["-p", "-i", "-o", "-J", "-F", "-l"]);
var tilde = (p) => p === "~" || p.startsWith("~/") ? homedir10() + p.slice(1) : p;
function sshPassArgs(toks) {
  const out = [];
  for (let i = 0;i < toks.length; i++) {
    if (SSH_PASS.has(toks[i]) && toks[i + 1] !== undefined) {
      out.push(toks[i], tilde(toks[i + 1]));
      i++;
    }
  }
  return out;
}
var defaultIsDir = (p) => {
  try {
    return statSync6(p).isDirectory();
  } catch {
    return false;
  }
};
var VAR_REF = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g;
var POS_REF = /\$\{([1-9])\}|\$([1-9])/g;
var MAX_BINDINGS = 25;
var MAX_EXPANSIONS = 20;
function bindingsFor(seg, vars) {
  let out = [new Map];
  for (const n of new Set([...seg.matchAll(VAR_REF)].map((m) => m[1] ?? m[2]))) {
    const v = vars.get(n);
    if (!v?.length || out.length * v.length > MAX_BINDINGS)
      continue;
    out = out.flatMap((b) => v.map((x) => new Map([...b, [n, x]])));
  }
  return out;
}
var substitute = (t, b) => t.replace(VAR_REF, (m, a, c) => b.get(a ?? c) ?? m);
function parseTransfers(command, cwd, isDir = defaultIsDir) {
  const uploads = [], downloads = [];
  let unchecked = 0;
  const vars = new Map;
  const funcs = new Map;
  const loops = [];
  let expansions = 0;
  const assign = (n, v) => {
    if (v.some((x) => x.includes("$") || x.includes("`")))
      vars.delete(n);
    else
      vars.set(n, v);
  };
  try {
    if (typeof command !== "string" || !cwd || !/\b(scp|rsync|ssh)\b/.test(command))
      return { uploads, downloads };
    const segs = splitSegments(command, cwd);
    for (let si = 0;si < segs.length; si++) {
      const { seg, masked, dir, piped } = segs[si];
      const toks0 = tokenize(seg).map((t) => t.replace(/["']/g, ""));
      const def = /^\s*(?:function\s+([A-Za-z_][\w-]*)\s*(?:\(\))?|([A-Za-z_][\w-]*)\s*\(\))\s*\{/.exec(seg);
      if (def) {
        const body = [seg.slice(def[0].length)];
        let depth = 1;
        while (++si < segs.length) {
          const s = segs[si];
          const first = s.seg.trim()[0];
          if (first === "{")
            depth++;
          else if (first === "}" && --depth === 0)
            break;
          body.push((s.piped ? "| " : `
`) + s.seg);
        }
        funcs.set((def[1] ?? def[2]).toLowerCase(), body.join(""));
        continue;
      }
      if (toks0[0] === "{")
        toks0.shift();
      if (toks0[0] === "<")
        toks0.splice(0, 2);
      else if (/^<[^<]/.test(toks0[0] ?? ""))
        toks0.shift();
      const head = cmdName(toks0);
      const fn = funcs.get(head.name);
      if (fn !== undefined && expansions++ < MAX_EXPANSIONS) {
        const text = fn.replace(POS_REF, (m, a, c) => head.rest[Number(a ?? c) - 1] ?? m);
        segs.splice(si + 1, 0, ...splitSegments(text, dir ?? cwd).map((s) => dir === null ? { ...s, dir: null } : s));
        continue;
      }
      if (head.name === "while" || head.name === "until" || head.name === "select")
        loops.push(null);
      if (head.name === "done") {
        const n = loops.pop();
        const v = n ? vars.get(n) : undefined;
        if (n && v?.length)
          vars.set(n, v.slice(-1));
        continue;
      }
      if (head.name === "" || head.name === "export" || head.name === "local") {
        for (const t of toks0) {
          const a = /^([A-Za-z_]\w*)=(.*)$/s.exec(t);
          if (!a)
            continue;
          const bs = bindingsFor(a[2], vars);
          if (bs.length > 1)
            vars.delete(a[1]);
          else
            assign(a[1], [substitute(a[2], bs[0])]);
        }
        continue;
      }
      if (head.name === "for")
        loops.push(head.rest[1] === "in" ? head.rest[0] : null);
      if (head.name === "for" && head.rest[1] === "in") {
        assign(head.rest[0], head.rest.slice(2).flatMap((w) => bindingsFor(w, vars).flatMap((b) => substitute(w, b).split(/\s+/).filter(Boolean))));
        continue;
      }
      if (dir === null || !["scp", "rsync", "ssh"].includes(head.name))
        continue;
      for (const b of bindingsFor(seg, vars)) {
        const sub = (t) => substitute(t, b);
        const { name, rest } = cmdName(toks0.map(sub));
        if (name === "scp" || name === "rsync") {
          const valueFlags = name === "scp" ? SCP_VALUE_FLAGS : RSYNC_VALUE_FLAGS;
          const pos = [];
          let recursive = false;
          let sshArgs = [];
          for (let i = 0;i < rest.length; i++) {
            const t = rest[i];
            if (t.startsWith("--") && t.includes("=")) {
              if (name === "rsync" && t.startsWith("--rsh="))
                sshArgs = sshPassArgs(tokenize(t.slice(6)).slice(1));
              continue;
            }
            if (t.startsWith("-") && t.length > 1) {
              if (name === "scp" && /^-[a-zA-Z0-9]*r/.test(t) && !valueFlags.has(t))
                recursive = true;
              if (name === "rsync" && (/^-[a-zA-Z]*[ar]/.test(t) && !t.startsWith("--") || t === "--recursive" || t === "--archive"))
                recursive = true;
              if (valueFlags.has(t)) {
                const v = rest[i + 1] ?? "";
                if (name === "scp" && t === "-P")
                  sshArgs.push("-p", v);
                else if (name === "scp" && (t === "-i" || t === "-o" || t === "-J"))
                  sshArgs.push(t, tilde(v));
                else if (name === "rsync" && (t === "-e" || t === "--rsh"))
                  sshArgs = sshPassArgs(tokenize(v).slice(1));
                i++;
              }
              continue;
            }
            pos.push(t);
          }
          if (pos.length < 2)
            continue;
          const destTok = pos[pos.length - 1];
          const sources = pos.slice(0, -1);
          const dest = remoteSpec(destTok);
          if (dest) {
            for (const src of sources) {
              if (remoteSpec(src))
                continue;
              if (/[$*?{]/.test(src) || destTok.includes("$")) {
                unchecked++;
                continue;
              }
              const local = resolve8(dir, tilde(src));
              const isDirSrc = recursive && (isDir(local) || src.endsWith("/"));
              const intoDir = destTok.endsWith("/") || sources.length > 1 || dest.path === "" || name === "rsync" && isDirSrc && !src.endsWith("/");
              let path = intoDir ? dest.path === "" ? basename(local) : `${dest.path.replace(/\/+$/, "")}/${basename(local)}` : dest.path;
              if (name === "rsync" && isDirSrc && src.endsWith("/"))
                path = dest.path.replace(/\/+$/, "");
              uploads.push({ local, userhost: dest.userhost, path, sshArgs: [...sshArgs], ...isDirSrc ? { dir: true } : !intoDir ? { orDir: true } : {} });
            }
          } else if (!destTok.includes("$")) {
            for (const src of sources) {
              const r = remoteSpec(src);
              if (!r || !r.path || r.path.includes("*") || src.includes("$"))
                continue;
              const destAbs = resolve8(dir, tilde(destTok));
              const local = destTok.endsWith("/") || destTok === "." || isDir(destAbs) ? join18(destAbs, basename(r.path)) : destAbs;
              downloads.push({ local, userhost: r.userhost, path: r.path, sshArgs: [...sshArgs] });
            }
          }
          continue;
        }
        if (name === "ssh") {
          const pos = [];
          const opts = [];
          let i = 0;
          for (;i < rest.length; i++) {
            const t = rest[i];
            if (t.startsWith("-") && pos.length === 0) {
              if (SSH_VALUE_FLAGS.has(t)) {
                opts.push(t, rest[i + 1] ?? "");
                i++;
              }
              continue;
            }
            pos.push(t);
          }
          if (pos.length < 2)
            continue;
          const userhost = pos[0];
          const stop = pos.findIndex((t, k) => k > 0 && /^[<>]|^\d>/.test(t));
          const remoteCmd = pos.slice(1, stop < 0 ? undefined : stop).join(" ");
          const sshArgs = sshPassArgs(opts);
          const inRedirect = /(?:^|[^<])<(?!<)\s*/.exec(masked);
          const up = /\bcat\s*>\s*([^\s;|&'"]+)|\btee\s+([^\s;|&'"]+)/.exec(remoteCmd);
          if (up && inRedirect) {
            const src = sub(tokenize(seg.slice(inRedirect.index + inRedirect[0].length))[0] ?? "");
            const path = up[1] ?? up[2];
            if (src.includes("$") || path.includes("$") || userhost.includes("$"))
              unchecked++;
            else if (src)
              uploads.push({ local: resolve8(dir, tilde(src)), userhost, path, sshArgs });
            continue;
          }
          if (up && piped) {
            const prev = segs[si - 1];
            const cat = cmdName(tokenize(prev.seg).map((t) => sub(t.replace(/["']/g, ""))));
            const src = cat.name === "cat" && cat.rest.length === 1 && !/^-|[<>]/.test(cat.rest[0]) ? cat.rest[0] : "$";
            const path = up[1] ?? up[2];
            if (/[$*?{]/.test(src) || path.includes("$") || userhost.includes("$") || prev.dir === null)
              unchecked++;
            else
              uploads.push({ local: resolve8(prev.dir, tilde(src)), userhost, path, sshArgs });
            continue;
          }
          const down = /^\s*cat\s+([^\s;|&<>'"]+)\s*$/.exec(remoteCmd);
          const outRedirect = /(?:^|[^0-9>&])>(?!>)\s*/.exec(masked);
          if (down && outRedirect) {
            const tok = sub(tokenize(seg.slice(outRedirect.index + outRedirect[0].length))[0] ?? "");
            if (tok && !tok.includes("$"))
              downloads.push({ local: resolve8(dir, tilde(tok)), userhost, path: down[1], sshArgs });
          }
        }
      }
    }
  } catch {}
  if (/\bmv\b/.test(command))
    for (const u of uploads)
      u.path = u.path.replace(/\.(deploytmp|tmp|new)$/, "");
  return { uploads, downloads, ...unchecked ? { unchecked } : {} };
}
var remoteKey = (t) => `${t.userhost}:${t.path}`;
var DEPLOY_DENY_ON_UNKNOWN_SERVER_COPY = true;
function decideDeploy(server, known) {
  if (server.kind === "absent")
    return { allow: true, note: "is new" };
  if (server.kind === "error")
    return { allow: true, note: `could not be checked (${server.reason}): fetch and diff before uploading` };
  const how = known.get(server.md5);
  if (how)
    return { allow: true, note: `matched ${how}` };
  return DEPLOY_DENY_ON_UNKNOWN_SERVER_COPY ? { allow: false, md5: server.md5 } : { allow: true, note: "matches nothing you know (not HEAD, not your file, not a copy you fetched): fetch and diff before uploading" };
}
function denyDeployText(t, md5, holder) {
  const k = remoteKey(t);
  const board = holder ? `; the board last saw ${holder.local} held by ${holder.session_id} (${holder.agent ?? "?"}, ${Math.round((holder.age_s ?? 0) / 60)} min ago)` : "";
  return `DEPLOY BLOCKED: ${k} on the server (md5 ${md5.slice(0, 8)}) is not your file, not a committed version (HEAD, the last ${COMMITTED_DEPTH} commits or the default branch), and not a copy you fetched or uploaded in this session. Someone deployed uncommitted work there${board}. Uploading now erases it. Instead: 1) scp ${t.sshArgs.includes("-p") ? `-P ${t.sshArgs[t.sshArgs.indexOf("-p") + 1]} ` : ""}${k} <your scratchpad>/${basename(t.path)}.live  2) apply your change onto that LIVE copy  3) upload the merged file (the guard allows an upload whose server copy matches what you fetched). Do not bypass this with another command. If the user explicitly wants to overwrite, they type \`override: ${k}\`.`;
}
function deployNudge(t, note) {
  return `DEPLOY: server copy of ${t.path} ${note}. Build a deploy from the LIVE copy plus your change, never from HEAD plus your change.`;
}
function parseMd5sumLines(out) {
  const m = new Map;
  for (const line of String(out ?? "").split(/\r?\n/)) {
    const x = /^\\?([0-9a-f]{32})\s+\*?(.+)$/.exec(line.trim());
    if (x)
      m.set(x[2], x[1]);
  }
  return m;
}
var md5Of = (buf) => createHash("md5").update(buf).digest("hex");
var MAX_HASH_BYTES = 5 * 1024 * 1024;
function localMd5(p) {
  try {
    const st = statSync6(p);
    if (!st.isFile() || st.size > MAX_HASH_BYTES)
      return null;
    return md5Of(readFileSync10(p));
  } catch {
    return null;
  }
}
var SSH_KILL_MS = 3000;
var DIR_MARK = "cm-is-dir ";
function remoteMd5s(userhost, sshArgs, paths, killMs = SSH_KILL_MS, probeDirs = []) {
  const out = new Map;
  const q = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
  const cmd = `md5sum -- ${paths.map(q).join(" ")}${probeDirs.map((p) => `; test -d ${q(p)} && echo ${q(`${DIR_MARK}${p}`)}`).join("")}`;
  try {
    const r = spawnSync5("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=2", ...sshArgs, userhost, cmd], { encoding: "utf-8", timeout: killMs });
    if (r.error || r.status === null || r.status === 255) {
      const reason = r.error ? r.error.code === "ETIMEDOUT" ? "ssh timed out" : r.error.message : `ssh failed: ${(r.stderr ?? "").trim().split(`
`).pop() ?? ""}`.slice(0, 120);
      for (const p of paths)
        out.set(p, { kind: "error", reason });
      return out;
    }
    const lines = parseMd5sumLines(r.stdout ?? "");
    const dirs = new Set(String(r.stdout ?? "").split(/\r?\n/).filter((l) => l.startsWith(DIR_MARK)).map((l) => l.slice(DIR_MARK.length)));
    for (const p of paths) {
      const m = lines.get(p);
      out.set(p, { ...m ? { kind: "md5", md5: m } : { kind: "absent" }, ...dirs.has(p) ? { dir: true } : {} });
    }
  } catch (e) {
    for (const p of paths)
      out.set(p, { kind: "error", reason: e.message.slice(0, 120) });
  }
  return out;
}
var COMMITTED_DEPTH = 9;
function committedMd5s(file, remotePath, cwd) {
  const out = new Map;
  try {
    let root = detectRepoRootSync(dirname4(file));
    let rel = root ? relative(root, file).split("\\").join("/") : "..";
    if (rel.startsWith("..") && remotePath && cwd) {
      root = detectRepoRootSync(cwd);
      const parts = remotePath.split("/").filter(Boolean);
      const i = root ? parts.findIndex((_, k) => existsSync7(join18(root, ...parts.slice(k)))) : -1;
      rel = i >= 0 ? parts.slice(i).join("/") : "..";
    }
    if (!root || rel.startsWith(".."))
      return out;
    const refs = [
      ["HEAD", "HEAD"],
      ["master", "the default branch"],
      ["main", "the default branch"],
      ["origin/HEAD", "the default branch"],
      ["origin/master", "the default branch"],
      ["origin/main", "the default branch"],
      ...Array.from({ length: COMMITTED_DEPTH }, (_, k) => [`HEAD~${k + 1}`, "a recent commit"])
    ];
    const r = spawnSync5("git", ["-C", root, "cat-file", "--batch"], { input: refs.map(([ref]) => `${ref}:${rel}`).join(`
`) + `
`, timeout: 2000, maxBuffer: 64 * 1024 * 1024 });
    const buf = r.stdout;
    if (!buf || r.status !== 0)
      return out;
    let off = 0;
    for (const [, how] of refs) {
      const nl = buf.indexOf(10, off);
      if (nl < 0)
        break;
      const header = buf.subarray(off, nl).toString();
      off = nl + 1;
      const m = /^[0-9a-f]+ blob (\d+)$/.exec(header);
      if (!m)
        continue;
      const size = Number(m[1]);
      const md5 = md5Of(buf.subarray(off, off + size));
      off += size + 1;
      if (!out.has(md5))
        out.set(md5, how);
    }
  } catch {}
  return out;
}
var baseFile = (sid) => join18(process.env.CAPTAIN_MEMO_DATA_DIR ?? DATA_DIR, "deploy-base", `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
function readBaselines(sid) {
  try {
    return JSON.parse(readFileSync10(baseFile(sid), "utf-8"));
  } catch {
    return {};
  }
}
function recordBaseline(sid, key, md5, how) {
  try {
    const b = readBaselines(sid);
    b[key] = [...(b[key] ?? []).filter((e) => e.md5 !== md5), { md5, how }].slice(-5);
    const f = baseFile(sid);
    if (!existsSync7(dirname4(f)))
      mkdirSync8(dirname4(f), { recursive: true });
    writeFileSync8(f, JSON.stringify(b));
  } catch {}
}
var MAX_CHECKED = 5;
function checkUploads(sid, uploads, opts = {}) {
  const files = uploads.filter((u) => !u.dir && !opts.skip?.(remoteKey(u))).slice(0, MAX_CHECKED);
  if (files.length === 0)
    return { nudges: [] };
  const base = readBaselines(sid);
  const byHost = new Map;
  for (const u of files) {
    const k = `${u.userhost}\x00${u.sshArgs.join("\x00")}`;
    byHost.set(k, [...byHost.get(k) ?? [], u]);
  }
  const nudges = [];
  for (const group of byHost.values()) {
    const inside = (u) => `${u.path.replace(/\/+$/, "")}/${basename(u.local)}`;
    const maybe = group.filter((u) => u.orDir);
    const server = remoteMd5s(group[0].userhost, group[0].sshArgs, [...group.map((u) => u.path), ...maybe.map(inside)], opts.killMs, maybe.map((u) => u.path));
    for (const u of group) {
      if (u.orDir && server.get(u.path)?.dir) {
        u.path = inside(u);
        if (opts.skip?.(remoteKey(u)))
          continue;
      }
      const copy = server.get(u.path) ?? { kind: "error", reason: "no answer" };
      const mine = localMd5(u.local);
      const known = committedMd5s(u.local, u.path, opts.cwd);
      if (mine)
        known.set(mine, "your file");
      for (const e of base[remoteKey(u)] ?? [])
        known.set(e.md5, e.how === "upload" ? "your last upload" : "your fetched copy");
      const v = decideDeploy(copy, known);
      if (!v.allow)
        return { deny: denyDeployText(u, v.md5, opts.holderOf?.(u.local)), nudges: [] };
      nudges.push(deployNudge(u, v.note));
    }
  }
  for (const u of files) {
    const m = localMd5(u.local);
    if (m)
      recordBaseline(sid, remoteKey(u), m, "upload");
  }
  return { nudges };
}
function recordFetchBaselines(sid, command, cwd) {
  try {
    if (!sid || typeof command !== "string" || !/\b(scp|rsync|ssh)\b/.test(command))
      return;
    for (const d of parseTransfers(command, cwd).downloads) {
      const m = localMd5(d.local);
      if (m)
        recordBaseline(sid, remoteKey(d), m, "fetch");
    }
  } catch {}
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
var HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_POST_TOOL_USE_TIMEOUT_MS ?? 1000);
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
  const value = typeof input === "string" ? input : input && typeof input === "object" ? String(input.patch ?? input.input ?? input.command ?? "") : "";
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
async function main3(options = {}) {
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
  const cmd = payload.tool_input?.command;
  if (payload.session_id && typeof cmd === "string" && /^(bash|run_shell_command|shell|exec_command)$/i.test(payload.tool_name)) {
    recordFetchBaselines(payload.session_id, cmd, payload.cwd ?? "");
  }
  const res = await workerFetch("/observation/enqueue", {
    method: "POST",
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS
  });
  logWorkerFailure("PostToolUse", "/observation/enqueue", res);
}
if (isMainModule(import.meta)) {
  try {
    await main3();
  } catch (err) {
    logHookError("PostToolUse", err);
    process.exit(0);
  }
}

// src/hooks/pre-tool-use.ts
init_branch();

// src/worker/glob-overlap.ts
var BACKSLASH = /\\/g;
var MSYS_DRIVE = /^\/([a-zA-Z])\//;
var WIN_DRIVE = /^([a-zA-Z]):\//;
function canon(g) {
  return g.replace(BACKSLASH, "/").replace(MSYS_DRIVE, "$1:/").replace(WIN_DRIVE, (_m, d) => `${d.toUpperCase()}:/`);
}
function norm(glob) {
  let g = canon(String(glob ?? "").trim()).replace(/^\.\//, "");
  if (g === "" || g === "**" || g === "*")
    return { kind: "prefix", path: "" };
  const dirIntent = g.endsWith("/");
  g = g.replace(/\/+$/, "");
  if (dirIntent)
    return { kind: "prefix", path: g };
  const star = g.indexOf("*");
  if (star < 0)
    return { kind: "exact", path: g };
  return { kind: "prefix", path: g.slice(0, star).replace(/\/+$/, "") };
}
function underOrEq(child, base) {
  if (base === "")
    return true;
  return child === base || child.startsWith(base + "/");
}
function oneOverlap(a, b) {
  if (a.kind === "exact" && b.kind === "exact")
    return a.path === b.path;
  if (a.kind === "prefix" && b.kind === "exact")
    return underOrEq(b.path, a.path);
  if (a.kind === "exact" && b.kind === "prefix")
    return underOrEq(a.path, b.path);
  return underOrEq(a.path, b.path) || underOrEq(b.path, a.path);
}
function globsOverlap(aGlobs, bGlobs) {
  const bN = (bGlobs ?? []).map(norm);
  if (bN.length === 0)
    return [];
  const hits = [];
  for (const ag of aGlobs ?? []) {
    const an = norm(ag);
    if (bN.some((bn) => oneOverlap(an, bn)))
      hits.push(ag);
  }
  return hits;
}

// src/shared/ai-process.ts
import { readFileSync as readFileSync11 } from "fs";
import { spawnSync as spawnSync6 } from "child_process";
import { basename as basename2 } from "path";
var MAX_DEPTH = 8;
var PS_TIMEOUT_MS = 1000;
var realPs = () => {
  try {
    const r = spawnSync6("ps", ["-ax", "-o", "pid=,ppid=,args="], { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
};
var psCache = new Map;
function psWalk(agents, start, snapshot) {
  const procs = new Map;
  for (const line of snapshot.split(`
`)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m)
      procs.set(Number(m[1]), { ppid: Number(m[2]), argv: m[3].trim().split(/\s+/) });
  }
  let pid = start;
  for (let i = 0;i < MAX_DEPTH && pid > 1; i++) {
    const p = procs.get(pid);
    if (!p)
      return;
    const script = p.argv.slice(1).find((a) => !a.startsWith("-"));
    if (agents.some((a) => name(p.argv[0]) === a || name(script) === a))
      return pid;
    pid = p.ppid;
  }
  return;
}
var name = (arg) => arg ? basename2(arg).replace(/\.[cm]?js$/, "") : "";
function aiProcessPid(agents, start = process.ppid, root = "/proc", platform = process.platform, ps = realPs) {
  if (platform === "darwin") {
    const key = `${agents.join(",")}\x00${start}`;
    if (!psCache.has(key)) {
      const snapshot = ps();
      if (snapshot === null)
        return;
      psCache.set(key, psWalk(agents, start, snapshot));
    }
    return psCache.get(key);
  }
  if (platform !== "linux")
    return;
  let pid = start;
  for (let i = 0;i < MAX_DEPTH && pid > 1; i++) {
    try {
      const comm = readFileSync11(`${root}/${pid}/comm`, "utf8").trim();
      const argv = readFileSync11(`${root}/${pid}/cmdline`, "utf8").split("\x00");
      const script = argv.slice(1).find((a) => a !== "" && !a.startsWith("-"));
      if (agents.some((a) => comm === a || name(argv[0]) === a || name(script) === a))
        return pid;
      const stat = readFileSync11(`${root}/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return;
    }
  }
  return;
}

// src/hooks/pre-tool-use.ts
import { resolve as resolve9, dirname as dirname5 } from "path";
var HOOK_TIMEOUT_MS3 = Number(process.env.CAPTAIN_MEMO_PRE_TOOL_USE_TIMEOUT_MS ?? 1500);
var MAX_FILES = 25;
var HOST_EXIT_MARGIN_MS2 = 750;
var SHELL_TOOLS = { Bash: "posix", PowerShell: "powershell", run_shell_command: "posix" };
var enforcing = () => process.env.CAPTAIN_MEMO_WORKBOARD_ENFORCE !== "0";
var scratchPath = (p) => (/^\/(?:var\/)?tmp\//.test(p) || /\/claude-\d+\//.test(p)) && !detectRepoRootSync(dirname5(p));
async function publishClaim(sid, cwd, touched, o) {
  const project = resolveProjectId(cwd);
  const advisories = [];
  let files = [...touched];
  const cur = await workerFetch(`/worknote/active?session_id=${encodeURIComponent(sid)}`, { method: "GET", timeoutMs: HOOK_TIMEOUT_MS3 });
  const claims = cur.ok ? cur.body?.claims ?? [] : [];
  const mine = claims.find((c) => c.session_id === sid);
  if (mine?.files?.length)
    files = [...new Set([...mine.files, ...touched])];
  if (files.length > MAX_FILES)
    files = files.slice(-MAX_FILES);
  const uploads = o.uploads ?? [];
  if (uploads.length > 0) {
    const ov = cur.body?.my_override?.files ?? [];
    let killMs = SSH_KILL_MS;
    if (o.hostTimeoutMs !== undefined)
      killMs = Math.min(SSH_KILL_MS, Math.floor(o.hostTimeoutMs - performance.now() - HOOK_TIMEOUT_MS3 - HOST_EXIT_MARGIN_MS2));
    if (killMs < 500) {
      advisories.push(...uploads.map((u) => `DEPLOY: server copy of ${u.path} could not be checked (no time left in this CLI's hook budget): fetch and diff before uploading. Build a deploy from the LIVE copy plus your change, never from HEAD plus your change.`));
    } else {
      const keys = uploads.map(remoteKey);
      const res = checkUploads(sid, uploads, {
        skip: (key) => globsOverlap([key], ov).length > 0,
        holderOf: (local) => {
          const h = claims.find((c) => c.session_id !== sid && globsOverlap([local], c.files ?? []).length > 0);
          return h ? { local, session_id: h.session_id, ...h.agent ? { agent: h.agent } : {}, ...typeof h.age_s === "number" ? { age_s: h.age_s } : {} } : undefined;
        },
        killMs,
        ...cwd ? { cwd } : {}
      });
      const moved = new Map(uploads.flatMap((u, i) => remoteKey(u) === keys[i] ? [] : [[keys[i], remoteKey(u)]]));
      if (moved.size) {
        files = files.map((f) => moved.get(f) ?? f);
        touched = touched.map((f) => moved.get(f) ?? f);
      }
      if (res.deny) {
        if (enforcing())
          return { deny: res.deny, advisories: [] };
        advisories.push(res.deny);
      }
      advisories.push(...res.nudges);
    }
  }
  const pid = o.agent === "claude" ? Number(process.env.CLAUDE_PID) : aiProcessPid([o.agent]) ?? NaN;
  const set = await workerFetch("/worknote/set", {
    method: "POST",
    body: {
      session_id: sid,
      agent: o.agent,
      what: `editing ${files.length} file(s) in ${project}`,
      files,
      enrich_from_observations: true,
      enforce: enforcing(),
      touched,
      ...Number.isInteger(pid) && pid > 0 ? { pid } : {},
      ...o.repo_root ? { repo_root: o.repo_root } : {}
    },
    timeoutMs: HOOK_TIMEOUT_MS3
  });
  logWorkerFailure("PreToolUse", "/worknote/set", set);
  if (!set.ok || !set.body)
    return { advisories };
  if (set.body.deny?.files?.length)
    return { deny: formatDeny(set.body.deny.files, set.body.deny.holders ?? []), advisories: [] };
  if (set.body.override?.files?.length) {
    advisories.push(`WORK-BOARD OVERRIDE (by the user) in force: writing ${set.body.override.files.join(", ")} held by ${(set.body.override.holders ?? []).map((h) => h.session_id).join(", ")}; the holder sees the override on the work board.`);
  }
  const warn = formatOverlapWarning(set.body.overlaps ?? []);
  if (warn)
    advisories.push(warn);
  return { advisories };
}
function formatDeny(files, holders) {
  const f = files.join(", ");
  const who = holders.map((h) => `${h.session_id}, ${h.agent ?? "?"}, last edit ${Math.round((h.age_s ?? 0) / 60)} min ago: "${(h.what ?? "").slice(0, 80)}"`).join("; ");
  return `WORK-BOARD: BLOCKED. ${f} ${files.length > 1 ? "are" : "is"} held by another session on this captain (${who}). Two sessions writing one file is how work gets lost. Do not route around this with another tool or a shell command. Stop and tell the user which session holds it (work_active shows the board); they decide. If they want to overwrite it, they type \`override: ${files[0]}\` as their message.`;
}
function formatOverlapWarning(overlaps) {
  if (overlaps.length === 0)
    return null;
  const lines = overlaps.map((o) => {
    const stale = staleNote(o);
    const who = `another session on this captain (${(o.session_id ?? "").slice(0, 12)}, ${o.agent ?? "?"}${stale ? `; ${stale}` : ""})`;
    const yours = o.overlapping ?? [];
    if (o.kind === "semantic") {
      return `${who} is working on the same thing by meaning: "${(o.what ?? "").slice(0, 80)}"${typeof o.similarity === "number" ? ` (~${o.similarity.toFixed(2)})` : ""}`;
    }
    if (o.kind === "topics")
      return `${who} holds the same topic: ${yours.join(", ")} ("${(o.what ?? "").slice(0, 80)}")`;
    if (o.kind === "repo")
      return `${who} works in the same repository (${yours.join(", ")})`;
    const theirs = globsOverlap(o.files ?? [], yours);
    const note = o.override ? ` (its user typed \`override:\` for ${o.override.files.join(", ")} until ${new Date(o.override.until).toTimeString().slice(0, 5)}: it may write them now, so re-read them before your next write)` : "";
    return `${who} holds ${(theirs.length ? theirs : o.files ?? []).join(", ")}, which overlaps your ${yours.join(", ")}${note}`;
  });
  const next = overlaps.every((o) => o.stale) ? "Every overlapping claim is stale (no recent edit, not necessarily ended): tell the user which session holds it before writing the same files." : "Stop and tell the user which session holds it (work_active shows the board); never edit or deploy over another session's claim.";
  return `WORK-BOARD OVERLAP: ${lines.join("; ")}. ${next}`;
}
async function main4(opts = {}) {
  let payload = {};
  try {
    payload = await readStdinJson();
  } catch (err) {
    logHookError("PreToolUse", err);
    return;
  }
  const sid = payload.session_id;
  const cwd = payload.cwd;
  const tool = payload.tool_name ?? "";
  const shell = SHELL_TOOLS[tool];
  const agent = opts.agent ?? "claude";
  const advisories = [];
  let deny;
  const abs = (p) => cwd ? resolve9(cwd, p) : p;
  const claim = async (touched, extra = {}) => {
    try {
      const r = await publishClaim(sid, cwd, touched.filter((p) => !scratchPath(p)), { agent, ...extra, ...opts.hostTimeoutMs !== undefined ? { hostTimeoutMs: opts.hostTimeoutMs } : {} });
      deny = r.deny;
      advisories.push(...r.advisories);
    } catch (err) {
      logHookError("PreToolUse", err);
    }
  };
  if (shell) {
    try {
      const gitWarn = await (await Promise.resolve().then(() => (init_pre_git(), exports_pre_git))).runPreGit(payload);
      if (gitWarn)
        advisories.push(gitWarn);
    } catch (err) {
      logHookError("PreToolUse", err);
    }
    const cmd = typeof payload.tool_input?.command === "string" ? payload.tool_input.command : "";
    let written = parseWrittenPaths(cmd, cwd ?? "", shell);
    const transfers = shell === "posix" ? parseTransfers(cmd, cwd ?? "") : { uploads: [] };
    const uploads = transfers.uploads.filter((u) => !/^\/(?:var\/)?tmp\//.test(u.path));
    if (transfers.unchecked)
      advisories.push(`DEPLOY: ${transfers.unchecked} upload(s) in this command name their file, host or path through a shell expansion the guard cannot resolve ($(...), $@, a glob, a pipe from another command), so the server copy was not checked: fetch the live copy and diff before uploading. Build a deploy from the LIVE copy plus your change, never from HEAD plus your change.`);
    let repoRoot;
    if (cwd && isCoarseClaim(written, cwd)) {
      const root = detectRepoRootSync(cwd);
      written = [];
      if (root && !root.includes("/claude-1000/"))
        repoRoot = root;
    }
    const upTouched = uploads.flatMap((u) => u.dir ? [`${u.local}/**`, `${remoteKey(u)}/**`] : [u.local, remoteKey(u)]);
    const touched = [...new Set([...written, ...upTouched])];
    if (sid && (touched.length > 0 || repoRoot)) {
      await claim(touched, { ...repoRoot ? { repo_root: repoRoot } : {}, ...uploads.length ? { uploads } : {} });
    }
  } else {
    const ip = payload.tool_input ?? {};
    let touched = [];
    if (tool === "apply_patch")
      touched = patchFiles(ip).map(abs);
    else {
      const fp = typeof ip.file_path === "string" ? ip.file_path : typeof ip.notebook_path === "string" ? ip.notebook_path : undefined;
      if (fp)
        touched = [abs(fp)];
    }
    if (!sid || touched.length === 0)
      return;
    await claim(touched);
  }
  if (deny) {
    writeStdout(JSON.stringify(opts.format === "gemini" ? { decision: "deny", reason: deny } : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: deny } }));
    return;
  }
  if (advisories.length === 0)
    return;
  writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: opts.format === "gemini" ? "BeforeTool" : "PreToolUse", additionalContext: advisories.join(`

`) } }));
}
if (isMainModule(import.meta)) {
  try {
    await main4();
  } catch (err) {
    logHookError("PreToolUse", err);
    process.exit(0);
  }
}

// src/hooks/stop.ts
init_shared();
init_paths();
init_worker_transition();
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
  PreToolUse: main4,
  PostToolUse: main3,
  Stop: main5,
  PreCompact: main6,
  CodexUserPromptSubmit: () => main({ emitOriginalPrompt: false, structuredContextJson: true, hostTimeoutMs: NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000 }),
  CodexPostToolUse: () => main3({ originAgent: "codex", source: "hook:codex" }),
  CodexPreToolUse: () => main4({ agent: "codex", format: "claude", hostTimeoutMs: 5000 }),
  GeminiBeforeTool: () => main4({ agent: "gemini", format: "gemini", hostTimeoutMs: 5000 }),
  CodexStop: () => main5({ emitJson: true }),
  CodexSessionStart: nativeMain,
  GeminiBeforeAgent: () => main({ emitOriginalPrompt: false, structuredContextJson: true, contextEventName: "BeforeAgent", hostTimeoutMs: NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000 }),
  GeminiAfterTool: () => main3({ originAgent: "gemini", source: "hook:gemini" }),
  GeminiAfterAgent: () => main5({ emitJson: true }),
  GeminiSessionStart: nativeMain,
  KimiUserPromptSubmit: () => main({ emitOriginalPrompt: false, hostTimeoutMs: NATIVE_PROMPT_HOOK_TIMEOUT_S * 1000 }),
  KimiPostToolUse: () => main3({ originAgent: "kimi", source: "hook:kimi" }),
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
