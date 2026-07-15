import { mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { readStdinJson, writeStdout, workerFetch, logHookError, workerFailureMessage } from './shared.ts';
import { DEFAULT_HOOK_TIMEOUT_MS, ENV_HOOK_TIMEOUT_MS, DEFAULT_WORKER_PORT, DATA_DIR } from '../shared/paths.ts';
import { VERSION } from '../shared/version.ts';
import { consumeUpgradeNotice, formatAutoUpdateBanner, formatRollbackBanner, writeMarker } from '../shared/self-update.ts';
import { runAutoUpdate, rollbackTo, isUpdateCheckDue, DEFAULT_UPDATE_CHECK_INTERVAL_MS, type UpdaterPort } from '../worker/self-updater.ts';
import { ensureWorkerHealthy } from '../shared/worker-health.ts';
import { restartWorker } from '../shared/worker-control.ts';
import { acquireHealLock, releaseHealLock } from '../shared/worker-heal-lock.ts';

/** Read one string field from <dir>/package.json, or null. Used by the auto-updater's port to read
 *  the post-update version and to confirm the resolved checkout is actually captain-memo. */
function readPkgField(dir: string, field: 'version' | 'name'): string | null {
  try { return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as Record<string, string>)[field] ?? null; }
  catch { return null; }
}

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: 'startup' | 'resume' | 'compact' | string;
}

interface StatsResponse {
  total_chunks: number;
  by_channel: Record<string, number>;
  observations: { total: number; queue_pending: number; queue_processing: number };
  indexing: {
    status: 'idle' | 'indexing' | 'ready' | 'error';
    total: number;
    done: number;
    errors: number;
    percent: number;
  };
  project_id: string;
  embedder: { model: string; endpoint: string };
  disk?: { bytes: number; path: string };
  version?: string;
  edition?: string;   // 'federation' | 'oss' — shown as a banner suffix; absent ⇒ no suffix (older worker)
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[i]}`;
}

function formatBanner(stats: StatsResponse): string {
  const ver = stats.version ? ` v${stats.version}` : '';
  // Build edition suffix — only for a worker that reports it (older workers omit it ⇒ no suffix).
  const ed = stats.edition === 'federation' ? ' (Federation)' : stats.edition === 'oss' ? ' (OSS)' : '';
  const lines: string[] = [
    '',
    '',
    `⚓ Captain Memo${ver}${ed}`,
    '─'.repeat(60),
  ];

  const byCh = Object.entries(stats.by_channel)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${fmtNum(v)}`)
    .join(', ');
  const corpusLine = byCh
    ? `${fmtNum(stats.total_chunks)} chunks (${byCh})`
    : `${fmtNum(stats.total_chunks)} chunks`;

  const host = stats.embedder.endpoint.replace(/^https?:\/\//, '').split('/')[0] ?? '?';

  lines.push(`  Project    ${stats.project_id}`);
  lines.push(`  Corpus     ${corpusLine}`);
  if (stats.disk) {
    lines.push(`  Disk       ${fmtBytes(stats.disk.bytes)}  (${stats.disk.path})`);
  }
  lines.push(`  Embedder   ${stats.embedder.model} @ ${host}`);
  lines.push(`  Retrieval  silent envelope on each prompt (top-5)`);

  // Conditional lines — only show when there's something to flag
  const idx = stats.indexing;
  if (idx.status === 'indexing') {
    lines.push(`  Indexing   ${fmtNum(idx.done)}/${fmtNum(idx.total)} (${idx.percent}%)`);
  } else if (idx.status === 'error') {
    lines.push(`  Indexing   error — ${idx.errors} files failed`);
  }
  const o = stats.observations;
  if (o.queue_pending > 0 || o.queue_processing > 0) {
    lines.push(`  Obs queue  pending=${o.queue_pending} processing=${o.queue_processing} (drains every 5s)`);
  }

  lines.push('');
  return lines.join('\n');
}

// Shown instead of falling silent when /stats can't be reached. The original
// v0.2.3 outage was confusing precisely because a missing banner could mean
// EITHER "worker down" OR "hook broken" — this names which it is, and points at
// the log. Memory resumes automatically once the worker answers again.
function formatDegradedBanner(detail: string): string {
  return [
    '',
    '',
    '⚓ Captain Memo — worker unreachable',
    '─'.repeat(60),
    `  Memory is paused this session (${detail}).`,
    '  Search and observation capture resume automatically once the worker is back.',
    '  Details: ~/.captain-memo/logs/hook.log',
    '',
  ].join('\n');
}

export async function main(): Promise<void> {
  // Payload is unused (the banner needs no input) — we only drain stdin. A parse
  // failure is non-fatal but worth a log line so a payload-shape change is visible.
  try { await readStdinJson<SessionStartPayload>(); } catch (err) { logHookError('SessionStart', err); }

  // SessionStart isn't on a hot path — it fires once per session, not per
  // prompt. Use a generous timeout so the banner appears even when the
  // worker is heavily contended. Override via CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS.
  const timeoutMs = Number(
    process.env.CAPTAIN_MEMO_SESSION_START_TIMEOUT_MS
    ?? process.env[ENV_HOOK_TIMEOUT_MS]
    ?? 10_000,
  );

  async function probeStats() {
    return workerFetch<StatsResponse>('/stats', { method: 'GET', timeoutMs });
  }

  let stats = await probeStats();

  // Poll /stats until the worker answers healthy (updating `stats` on success) or the budget elapses.
  // Used after an auto-update restart to decide success vs rollback. Mirrors the self-heal waitHealthy.
  async function waitWorkerHealthy(budgetMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const r = await workerFetch<StatsResponse>('/stats', { method: 'GET', timeoutMs: 1500 });
      if (r.ok) { stats = r; return true; }
      await new Promise((res) => setTimeout(res, 500));
    }
    return false;
  }

  // OPT-IN autonomous self-update (CAPTAIN_MEMO_AUTO_UPDATE=1). GIT-CLONE installs only — a
  // marketplace install already self-updates via Claude Code, and runAutoUpdate no-ops on a
  // non-git dir. Runs BEFORE self-heal so the worker restarts onto the freshly pulled code.
  // Fast-forward to the newest STABLE tag only, never over a dirty tree (see worker/self-updater.ts).
  // Throttled to one `git fetch` per interval so it doesn't hit the network every session. Fully
  // fail-open: any error is logged, never thrown, and the session continues on the current version.
  let autoUpdateNotice = '';
  let updatedThisSession = false;
  if (process.env.CAPTAIN_MEMO_AUTO_UPDATE === '1') {
    const AUTO_UPDATE_LOCK = join(DATA_DIR, '.auto-update.lock');
    try {
      const port: UpdaterPort = {
        run: (argv, cwd, timeoutMs) => {
          // env: make git FAIL FAST instead of blocking on a credential / host-key prompt (which
          // would otherwise stall the session for the whole timeout). timeoutMs is per-call — short
          // for git fetch (default 20s), generous for `bun install` (installDeps passes 300s).
          const r = Bun.spawnSync(argv, {
            cwd, stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs ?? 20_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oConnectTimeout=10' } as Record<string, string>,
          });
          return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
        },
        readPackageVersion: (dir) => readPkgField(dir, 'version'),
        readPackageName: (dir) => readPkgField(dir, 'name'),
      };
      const intervalMs = Number(process.env.CAPTAIN_MEMO_AUTO_UPDATE_INTERVAL_MS ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS);
      try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* dir may exist */ }
      const stampPath = join(DATA_DIR, '.last-update-check');
      let lastCheck: number | null = null;
      try { lastCheck = statSync(stampPath).mtimeMs; } catch { /* never checked */ }
      // Lock serializes concurrent sessions: only one may fetch/ff/install/restart at a time.
      if (isUpdateCheckDue(lastCheck, Date.now(), intervalMs) && acquireHealLock(AUTO_UPDATE_LOCK)) {
        try {
          try { writeFileSync(stampPath, `${new Date().toISOString()}\n`); } catch { /* stamp best-effort */ }
          const top = port.run(['git', 'rev-parse', '--show-toplevel'], import.meta.dir);
          const installDir = (top.code === 0 && top.stdout.trim()) ? top.stdout.trim() : import.meta.dir;
          const res = runAutoUpdate(port, installDir, VERSION, process.execPath);
          if (res?.ok) {
            const { getServiceManager } = await import('../services/service-manager/index.ts');
            const sm = getServiceManager();
            const wport = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
            await restartWorker(sm, 'captain-memo-worker', { port: wport, graceful: true });
            const healthy = await waitWorkerHealthy();
            if (healthy) {
              updatedThisSession = true;   // suppress the self-heal restart below (VERSION is now frozen-stale)
              if (res.to) writeMarker(DATA_DIR, res.to);
              autoUpdateNotice = formatAutoUpdateBanner(res.from, res.to ?? '?', res.installFailed);
            } else {
              // New code didn't boot (bad deps / crash-loop). Roll the checkout back to the prior
              // sha and restart the OLD, known-good code rather than strand the worker dead.
              const rolled = res.priorSha ? rollbackTo(port, installDir, res.priorSha, process.execPath) : false;
              await restartWorker(sm, 'captain-memo-worker', { port: wport });
              await waitWorkerHealthy();
              stats = await probeStats();
              updatedThisSession = true;
              autoUpdateNotice = formatRollbackBanner(res.from, res.to ?? '?', rolled);
              logHookError('SessionStart', new Error(`auto-update to ${res.to} failed to boot; rolled back=${rolled}`));
            }
          } else if (res && !res.ok) {
            // A safety gate refused (dirty tree / detached HEAD / ff conflict). Expected, not an error.
            logHookError('SessionStart', new Error(`auto-update skipped: ${res.code} — ${res.reason}`));
          }
        } finally {
          releaseHealLock(AUTO_UPDATE_LOCK);
        }
      }
    } catch (err) {
      logHookError('SessionStart', err);
    }
  }

  // Self-heal: recover a dead OR ZOMBIE worker (process alive, HTTP server dead),
  // or restart a stale one (running code older than the installed VERSION), then
  // re-probe. Recovery force-reclaims (hard-kills the port owner) before starting,
  // because a bare start no-ops against a zombie on Windows (IgnoreNew). Routed
  // through the OS service manager (it owns the process — nothing is orphaned when
  // this short-lived hook exits).
  // We block here, because SessionStart fires once per session and a live worker
  // on entry is worth the wait. Fully fail-open: any error → degraded banner
  // below, never a thrown hook. Opt out with CAPTAIN_MEMO_DISABLE_SELF_HEAL=1.
  const selfHealOff = process.env.CAPTAIN_MEMO_DISABLE_SELF_HEAL === '1';
  const running = stats.ok && !!stats.body;
  // `stale` compares the worker's version to VERSION — the hook's frozen constant. After an
  // auto-update this session, the worker is NEWER than VERSION (which was loaded pre-pull), so the
  // stale check would false-fire and bounce the just-restarted worker a second time. Suppress it.
  const stale = !updatedThisSession && running && stats.body!.version !== undefined && stats.body!.version !== VERSION;
  if (!selfHealOff && (!running || stale)) {
    try {
      const { getServiceManager } = await import('../services/service-manager/index.ts');
      const sm = getServiceManager();
      const WORKER = 'captain-memo-worker';
      const port = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);
      const outcome = await ensureWorkerHealthy({
        diskVersion: VERSION,
        probeVersion: async () => (running ? (stats.body!.version ?? null) : null),
        acquireLock: () => acquireHealLock(),
        releaseLock: () => releaseHealLock(),
        // Unreachable can mean DEAD (no process) OR a ZOMBIE (process alive, HTTP
        // dead). A bare start() no-ops on a zombie (Windows IgnoreNew while the
        // corpse holds the task "Running"), so reclaim-then-start: force-kill
        // whatever holds the port first. No graceful — a broken worker won't
        // answer /shutdown anyway.
        start: () => restartWorker(sm, WORKER, { port }),
        // Stale (alive + serving, wrong version): graceful drain, then replace.
        restart: () => restartWorker(sm, WORKER, { port, graceful: true }),
        waitHealthy: async () => {
          // The wscript hidden launcher (0.2.20) pushed worker startup to ~10s (the
          // wscript->bun hop + DB open + initial index), so an 8s budget gave up on
          // a worker that was merely slow to boot and triggered a needless reclaim.
          // 15s clears the real startup latency with margin. Override if needed.
          const deadline = Date.now() + Number(process.env.CAPTAIN_MEMO_SESSION_START_WAIT_HEALTHY_MS ?? 15_000);
          while (Date.now() < deadline) {
            const r = await workerFetch<StatsResponse>('/stats', { method: 'GET', timeoutMs: 1500 });
            if (r.ok) { stats = r; return true; }
            await new Promise((res) => setTimeout(res, 500));
          }
          return false;
        },
      });
      if (outcome.action === 'skipped') {
        // Another session is healing — give it a moment, then re-probe for the banner.
        await new Promise((res) => setTimeout(res, 1500));
        stats = await probeStats();
      } else if (outcome.action === 'failed') {
        logHookError('SessionStart', new Error(`self-heal ${outcome.reason} failed: ${outcome.error}`));
      } else if ((outcome.action === 'started' || outcome.action === 'restarted') && !outcome.healthy) {
        // The supervisor accepted the start/restart, but the worker never answered
        // within the deadline (crash-loop on boot: bad env, port in use, corrupt DB).
        // Without this, that's indistinguishable in the log from "never tried".
        logHookError('SessionStart', new Error(
          `self-heal ${outcome.action} the worker but it did not become healthy within 8s (reason: ${outcome.reason})`,
        ));
      }
    } catch (err) {
      logHookError('SessionStart', err);
    }
  }

  // Self-upgrade notice: if the plugin VERSION advanced since the last
  // session (Claude Code auto-fetched a newer marketplace version, or a re-install landed),
  // announce it once. The existing self-heal above already restarted the now-stale worker;
  // this just surfaces it. consumeUpgradeNotice persists the new marker and returns '' when
  // there's nothing to say. Best-effort — never throws, never touches config/worker.env.
  const upgradeNotice = consumeUpgradeNotice(DATA_DIR, VERSION);
  // autoUpdateNotice (this session's active pull) takes precedence; consumeUpgradeNotice covers the
  // marketplace-refresh path. Only one normally fires — the auto-update path advances the marker so
  // it doesn't double-announce — but combine defensively in case both have something to say.
  const notices = [autoUpdateNotice, upgradeNotice].filter(Boolean).join('\n\n');
  const withNotice = (banner: string): string => (notices ? `${notices}\n\n${banner}` : banner);

  if (stats.ok && stats.body) {
    // Claude Code's SessionStart hook protocol expects a JSON envelope on
    // stdout. The `systemMessage` field becomes the visible banner shown
    // to both user and model under "SessionStart:startup says: …". Plain
    // text on stdout is silently discarded.
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: withNotice(formatBanner(stats.body)),
    }));
  } else {
    // Worker unreachable / timed out / errored / empty body: log it AND tell the
    // user, rather than emitting nothing (which reads as "memory broke"). We log
    // unconditionally here (not via logWorkerFailure, which no-ops on ok) so the
    // log line and the banner always stay in lockstep — including the near-dead
    // ok-but-no-body corner. Still fail-open: a systemMessage never blocks the session.
    logHookError('SessionStart', new Error(workerFailureMessage('/stats', stats) ?? 'worker /stats returned no body'));
    writeStdout(JSON.stringify({
      continue: true,
      systemMessage: withNotice(formatDegradedBanner(stats.timedOut ? 'worker timed out' : 'worker not reachable')),
    }));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    logHookError('SessionStart', err);
    process.exit(0);
  });
}
