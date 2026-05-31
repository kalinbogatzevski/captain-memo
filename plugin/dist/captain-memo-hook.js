#!/usr/bin/env bun
// @bun

// src/hooks/shared.ts
import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";

// src/shared/paths.ts
import { homedir } from "os";
import { join } from "path";
var DATA_DIR = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), ".captain-memo");
var META_DB_PATH = join(DATA_DIR, "meta.sqlite3");
var QUEUE_DB_PATH = join(DATA_DIR, "queue.db");
var OBSERVATIONS_DB_PATH = join(DATA_DIR, "observations.db");
var PENDING_EMBED_DB_PATH = join(DATA_DIR, "pending_embed.db");
var VECTOR_DB_DIR = join(DATA_DIR, "vector-db");
var LOGS_DIR = join(DATA_DIR, "logs");
var ARCHIVE_DIR = join(DATA_DIR, "archive");
var CONFIG_PATH = join(DATA_DIR, "config.json");
var CONFIG_DIR = process.env.CAPTAIN_MEMO_CONFIG_DIR ?? (process.platform === "win32" ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "captain-memo") : join(homedir(), ".config", "captain-memo"));
var WORKER_ENV_PATH = join(CONFIG_DIR, "worker.env");
var DEFAULT_WORKER_PORT = 39888;
var ENV_HOOK_TIMEOUT_MS = "CAPTAIN_MEMO_HOOK_TIMEOUT_MS";
var DEFAULT_HOOK_TIMEOUT_MS = 1500;
var DEFAULT_STOP_DRAIN_BUDGET_MS = 5000;

// src/hooks/shared.ts
var HOOK_LOG_DIR = join2(homedir2(), ".captain-memo", "logs");
var HOOK_LOG_FILE = join2(HOOK_LOG_DIR, "hook.log");
var HOOK_LOG_ROTATE_BYTES = 10 * 1024 * 1024;
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
var WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;
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

// src/hooks/user-prompt-submit.ts
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
  if (result.ok && result.body && result.body.envelope) {
    writeStdout(result.body.envelope);
    writeStdout(`

`);
  }
  writeStdout(prompt);
}
if (false) {}

// src/hooks/session-start.ts
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
  const lines = [
    "",
    "",
    `\u2693 Captain Memo${ver}`,
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
  const stats = await workerFetch("/stats", {
    method: "GET",
    timeoutMs
  });
  if (stats.ok && stats.body) {
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: formatBanner(stats.body)
    }));
  } else {
    logHookError("SessionStart", new Error(workerFailureMessage("/stats", stats) ?? "worker /stats returned no body"));
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: formatDegradedBanner(stats.timedOut ? "worker timed out" : "worker not reachable")
    }));
  }
}
if (false) {}

// src/worker/branch.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync2 } from "fs";
function detectBranchSync(cwd) {
  if (!existsSync2(cwd))
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
var branchCache = new Map;

// src/hooks/post-tool-use.ts
var HOOK_TIMEOUT_MS = Number(process.env.CAPTAIN_MEMO_POST_TOOL_USE_TIMEOUT_MS ?? 1000);
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
async function main3() {
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
    branch: detectBranchSync(process.cwd())
  };
  const res = await workerFetch("/observation/enqueue", {
    method: "POST",
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS
  });
  logWorkerFailure("PostToolUse", "/observation/enqueue", res);
}
if (false) {}

// src/hooks/stop.ts
async function main4() {
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
var HOOK_TIMEOUT_MS2 = Number(process.env.CAPTAIN_MEMO_PRE_COMPACT_TIMEOUT_MS ?? 5000);
async function main5() {
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
    source: "pre-compact"
  };
  const res = await workerFetch("/observation/enqueue", {
    method: "POST",
    body: event,
    timeoutMs: HOOK_TIMEOUT_MS2
  });
  logWorkerFailure("PreCompact", "/observation/enqueue", res);
}
if (false) {}

// src/hooks/dispatcher.ts
var EVENTS = {
  UserPromptSubmit: main,
  SessionStart: main2,
  PostToolUse: main3,
  Stop: main4,
  PreCompact: main5
};
async function main6() {
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
try {
  await main6();
} catch (err) {
  logHookError(process.argv[2] ?? "unknown", err);
  process.exit(0);
}
