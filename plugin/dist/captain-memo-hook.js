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

// src/hooks/dispatcher.ts
var EVENTS = {
  UserPromptSubmit: "../hooks/user-prompt-submit.ts",
  SessionStart: "../hooks/session-start.ts",
  PostToolUse: "../hooks/post-tool-use.ts",
  Stop: "../hooks/stop.ts",
  PreCompact: "../hooks/pre-compact.ts"
};
async function main() {
  const event = process.argv[2] ?? process.env.CLAUDE_HOOK_EVENT_NAME ?? process.env.CAPTAIN_MEMO_HOOK_EVENT;
  if (!event || !(event in EVENTS)) {
    process.exit(0);
  }
  const target = EVENTS[event];
  try {
    const mod = await import(target);
    if (typeof mod.main === "function") {
      await mod.main();
    } else {
      logHookError(event, new Error(`hook handler ${target} has no exported main()`));
    }
  } catch (err) {
    logHookError(event, err);
    process.exit(0);
  }
}
if (false) {}

// bin/captain-memo-hook.ts
try {
  await main();
} catch (err) {
  logHookError(process.argv[2] ?? "unknown", err);
  process.exit(0);
}
