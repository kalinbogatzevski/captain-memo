// captain-memo doctor — health probe across all moving parts.
//
// Reports PASS / WARN / FAIL for each component and prints a one-line
// remediation hint when something's wrong. Read-only — never changes state.

import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { parseMode as parsePromotionMode } from '../../worker/promotion-config.ts';
import { join } from 'path';
import { homedir } from 'os';
import { spawnSync } from 'child_process';
import { Database } from 'bun:sqlite';
import { getAppliedVersions } from '../../worker/migrations.ts';
import { OBSERVATIONS_STORE_MIGRATIONS, ObservationsStore } from '../../worker/observations-store.ts';
import { OBSERVATION_QUEUE_MIGRATIONS, ObservationQueue } from '../../worker/observation-queue.ts';
import { PendingEmbedQueue } from '../../worker/pending-embed-queue.ts';
import { removeNonMarkdownMemoryDocuments } from '../../worker/maintenance.ts';
import type { EmbedUsage } from '../../worker/embedder.ts';
import { getServiceManager } from '../../services/service-manager/index.ts';
import { workerEnvPaths } from '../../shared/worker-env.ts';
import {
  DEFAULT_WORKER_PORT,
  ENV_REMEMBER_DIR, DEFAULT_REMEMBER_DIR,
  ENV_PROMOTE_ENABLE,
  ENV_PROMOTE_MAX_PER_RUN, DEFAULT_PROMOTE_MAX_PER_RUN,
  ENV_REMEMBER_DEDUP_THRESHOLD, DEFAULT_REMEMBER_DEDUP_THRESHOLD,
  DEFAULT_HOOK_TIMEOUT_MS,
  META_DB_PATH,
} from '../../shared/paths.ts';
import { isWindows } from '../../shared/platform.ts';
import { VERSION } from '../../shared/version.ts';
import { decideWorkerDrift, pickUpgradeTarget, parseRemoteCandidates } from '../../shared/version-drift.ts';
import { compareSemver } from '../../shared/self-update.ts';
import { describeSessionOf, normalizePath, readLivePluginPins, readPluginManifest } from '../../shared/plugin-cache.ts';
import { CODEX_TOOL_NAMES, codexApprovalState, codexConfigPath, codexHomeDir, geminiHooksToggleRejected } from '../cross-ai.ts';
import { WINDOWS_SHIM_FIX, windowsCliShimPath, windowsShimState } from '../../shared/windows-shim.ts';
import { WORKER_TOKEN_PATH, readWorkerToken, workerAuthHeaders, type TokenlessRow } from '../../shared/worker-auth.ts';

// Lookup a single key from worker.env (CONFIG_DIR per platform, then the /etc
// system-mode fallback on Linux — workerEnvPaths() supplies the right list).
function readWorkerEnvVar(key: string): string | null {
  for (const path of workerEnvPaths()) {
    if (!existsSync(path)) continue;
    const m = readFileSync(path, 'utf-8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (m) return m[1] ?? null;
  }
  return null;
}

type Status = 'PASS' | 'WARN' | 'FAIL';

export interface Check {
  name: string;
  status: Status;
  detail: string;
  remedy?: string;
}

/** The port this captain's worker ACTUALLY runs on. mcp-server.ts, restart.ts and upgrade.ts all read
 *  CAPTAIN_MEMO_WORKER_PORT; doctor alone hardcoded the default, so on a captain moved to another port
 *  every probe hit an empty port and doctor reported the worker down while it was serving fine — a
 *  diagnostic tool confidently misdiagnosing the one thing it exists to check. */
const WORKER_PORT = Number(process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT);

const checks: Check[] = [];

function record(c: Check): void { checks.push(c); }

function svcMode(name: string): 'user' | 'system' | null {
  const userR = spawnSync('systemctl', ['--user', 'list-unit-files', name], { encoding: 'utf-8' });
  if (userR.stdout.includes(name)) return 'user';
  const sysR = spawnSync('systemctl', ['list-unit-files', name], { encoding: 'utf-8' });
  if (sysR.stdout.includes(name)) return 'system';
  return null;
}

// Cross-platform HTTP probe (replaces the old `curl` shell-out). Returns the
// parsed JSON body on success; { ok:false } on connection refused / timeout /
// non-2xx / unparseable body.
/** `why` names HOW it failed, and is the whole point: a doctor that says a route "failed" without saying whether
 *  it timed out, returned 500, or refused the connection sends the reader to the wrong remedy (seen live: "healthy
 *  but /stats failed", no reason, under a hint about DB migrations that were in fact fully applied). */
async function fetchJson(url: string, timeoutMs = 3000): Promise<{ ok: boolean; body: unknown; status?: number; why?: string }> {
  try {
    // The worker token goes to the worker only, never to the embedder this also probes.
    const headers = url.startsWith(`http://127.0.0.1:${WORKER_PORT}/`) ? workerAuthHeaders() : {};
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) {
      // Keep a snippet of the body: a 500 from the worker usually explains itself.
      let snippet = '';
      try { snippet = (await r.text()).trim().replace(/\s+/g, ' ').slice(0, 160); } catch { /* body unreadable */ }
      return { ok: false, body: null, status: r.status, why: `HTTP ${r.status}${snippet ? ` — ${snippet}` : ''}` };
    }
    const text = await r.text();
    try { return { ok: true, body: JSON.parse(text) }; }
    catch { return { ok: false, body: text, why: 'response was not JSON' }; }
  } catch (err) {
    // AbortSignal.timeout throws a TimeoutError; everything else is a connect/reset. That is the difference
    // between "the worker is slow/busy" and "nothing is listening".
    const e = err as { name?: string; message?: string };
    return { ok: false, body: null, why: e?.name === 'TimeoutError' ? `no answer within ${timeoutMs}ms` : (e?.message || 'connection failed') };
  }
}

/** The worker's own report on whether embedding is WORKING — fetched by checkWorker
 *  (which runs first), judged by checkEmbedder. null until fetched / if it failed. */
let lastStats: Record<string, unknown> | null = null;

/** Which provider is ACTUALLY running, set by checkCapture (which fetches /stats) and read by
 *  checkConfig (which only sees worker.env). Without it `worker config` prints the configured chain
 *  as though it were the live state — the exact line that would read green while the worker has
 *  been serving its fallback since a demotion hours ago. null when /stats was unreachable. */
let liveSummarizer: { provider?: string; demoted: string[] } | null = null;

/** Spec §4.2 thresholds, in ONE place rather than scattered as magic numbers at the comparison. */
export const INJECT_P50_FRACTION = 0.8;      // p50 at/above 80% of the deadline = no headroom left
export const INJECT_OVER_FRACTION = 0.25;    // a quarter of calls already failing
/** Below this many samples we say NOTHING. A handful of injects right after a restart is not
 *  evidence, and asserting a problem from no data is the failure mode this whole design exists to
 *  avoid — the previous federation check reported PASS while zero peers were attested. */
export const INJECT_MIN_SAMPLES = 20;

/** Hook retrieval latency (spec §4.2). The hook FAILS OPEN: when /inject/context misses its deadline
 *  the turn silently loses its memory and nothing surfaces — 865 such failures accumulated over ten
 *  weeks unnoticed. This is the check that makes that visible.
 *
 *  Two clauses, because the median alone lies here. A p50 of 1.9s against a 2s deadline looks
 *  survivable while a quarter of calls are still failing on the spikes; the over-deadline ratio
 *  catches that bimodal shape. */
export function injectLatencyVerdict(
  inject:
    | { n?: number; p50_ms?: number; p95_ms?: number; over_deadline_n?: number; deadline_ms?: number | null }
    | null | undefined,
  fallbackDeadlineMs: number,
): Check | null {
  if (!inject || typeof inject.n !== 'number') return null;   // older worker — absent, not broken
  const n = inject.n;
  if (n < INJECT_MIN_SAMPLES) return null;                    // never assert from no data

  // The deadline the WORKER observed, not the one the caller of this function guessed. over_deadline_n
  // is counted against the hook's own `deadline_ms`, and the hook resolves that from
  // CAPTAIN_MEMO_HOOK_TIMEOUT_MS in ITS process env — Claude Code's. The worker never reads that key,
  // so scraping it out of worker.env answers a different question: on this captain worker.env held
  // 2000 while the hook sent 10000, and the line read "0/26 over the 2000ms deadline" for a count
  // taken against 10s, with the 80%-headroom clause scored against a deadline that was not in force.
  // Fall back only for a worker old enough not to report it.
  const deadlineMs = typeof inject.deadline_ms === 'number' && inject.deadline_ms > 0
    ? inject.deadline_ms
    : fallbackDeadlineMs;

  const name = 'hook retrieval latency';
  const p50 = inject.p50_ms ?? 0;
  const p95 = inject.p95_ms ?? 0;
  const over = inject.over_deadline_n ?? 0;
  const overFrac = over / n;
  const detail = `p50 ${p50}ms · p95 ${p95}ms · ${over}/${n} over the ${deadlineMs}ms deadline`;

  // The remedy names the two levers that actually help. Raising the timeout is deliberately NOT one
  // of them: it converts a visible failure into a slower prompt, which is how this went unnoticed.
  const remedy = 'profile the local search (channel counts, corpus size) and check for engine stalls; '
               + 'do NOT raise the timeout — that hides the miss instead of fixing it';

  // A median AT or past the deadline (>=, as over_deadline is counted): most prompts are already losing their memory. "Within
  // 20%" understates that (6000 ms against a 1500 ms deadline is 4x), and it is the state a first build of a large store, a
  // repair or an IVF rebuild puts the search in (worker/ivf.ts: 4.8-9.3 s a search while a rebuild drains).
  if (p50 >= deadlineMs) {
    return {
      name, status: 'WARN',
      detail: `${detail} — median is above the hook's timeout: memory injection is timing out on most prompts`,
      remedy: `if an index build, a repair or an IVF rebuild is running, search stays this slow until it finishes; otherwise ${remedy}`,
    };
  }
  if (p50 >= INJECT_P50_FRACTION * deadlineMs) {
    return { name, status: 'WARN', detail: `${detail} — median is within 20% of the deadline`, remedy };
  }
  if (overFrac >= INJECT_OVER_FRACTION) {
    return {
      name, status: 'WARN',
      detail: `${detail} — ${Math.round(overFrac * 100)}% of injects miss it despite a healthy median`,
      remedy,
    };
  }
  return { name, status: 'PASS', detail };
}

/** A hosted endpoint used to PASS on sight — doctor never asked whether it worked.
 *  The default install IS hosted, so the one backend everybody runs was the one
 *  never checked: a 429-throttled queue with 19 stuck observations reported clean,
 *  and the operator only found out by reading worker.log.
 *
 *  We cannot probe the provider without spending the user's key, so we ask the worker
 *  what its embed queue is doing — which is the thing we actually care about. */
export function embedderVerdict(
  endpoint: string,
  stats: { embed_pending?: number; embed_parked?: number; embed_error?: string; embed_error_class?: string } | null,
): Check {
  const host = endpoint.replace(/^https?:\/\//, '').split('/')[0] || '?';
  const name = 'embedder backend';
  if (!stats) {
    return { name, status: 'WARN', detail: `external endpoint @ ${host} — unverified (worker did not answer)`,
             remedy: 'start the worker, then re-run captain-memo doctor' };
  }
  const pending = stats.embed_pending ?? 0;
  if (!stats.embed_error) return { name, status: 'PASS', detail: `external endpoint @ ${host} · queue clear` };
  const err = String(stats.embed_error).slice(0, 120);
  if (stats.embed_error_class === 'auth') {
    // Retrying forever will never fix a bad key — this one needs a human.
    return { name, status: 'FAIL', detail: `${host}: ${pending} chunk(s) blocked on auth — ${err}`,
             remedy: 'check the API key in worker.env, then: captain-memo restart' };
  }
  // After auth: a bad key fails everything, parked chunks included, and that is the thing to fix.
  if ((stats.embed_parked ?? 0) > 0) return parkedEmbedCheck(name, host, stats.embed_parked!, err);
  if (stats.embed_error_class === 'rate_limited') {
    // Drains on its own; the remedy is optional. Say so, or the count reads as damage.
    return { name, status: 'WARN', detail: `${host}: ${pending} chunk(s) queued behind a rate limit — ${err}`,
             remedy: 'nothing required — the queue retries with backoff. To go faster, add billing / raise the tier at the provider.' };
  }
  return { name, status: 'WARN', detail: `${host}: ${pending} chunk(s) retrying — ${err}`,
           remedy: 'run doctor again in a minute; if it persists, check worker.log' };
}

/** How much of the corpus actually has a vector. embedderVerdict only looks at the retry queue and the last error, so a
 *  run that finished WITH errors (a reindex that ended "indexed 115, errors 20394" on 2026-08-03) left both clear and
 *  doctor said "queue clear" over a 99% unembedded corpus — found only by reading `ivf.vectors` out of /stats by hand.
 *  Both numbers are already in /stats: `total_chunks` and `ivf.vectors`. A small gap is normal while ingest catches up,
 *  so it only WARNs past 2% and FAILs past half; nothing is said during the first big index or on a tiny corpus. */
export const EMBED_COVERAGE_WARN_GAP = 0.02;
export const EMBED_COVERAGE_FAIL_GAP = 0.5;
export const EMBED_COVERAGE_MIN_CHUNKS = 50;
export function embedCoverageCheck(
  s: { total_chunks?: unknown; vectors?: unknown; indexing?: unknown } | null | undefined,
): Check | null {
  const total = s?.total_chunks, vectors = s?.vectors;
  if (typeof total !== 'number' || typeof vectors !== 'number' || !Number.isFinite(total) || !Number.isFinite(vectors)) return null;
  if (total < EMBED_COVERAGE_MIN_CHUNKS || s?.indexing === 'indexing') return null;
  const missing = Math.max(0, total - vectors);
  const gap = missing / total;
  if (gap <= EMBED_COVERAGE_WARN_GAP) return null;
  const name = 'embedding coverage';
  const fmt = (n: number) => n.toLocaleString('en-US');
  const detail = `${fmt(missing)} of ${fmt(total)} chunks (${Math.round(gap * 100)}%) have no vector, so vector search covers only the rest`;
  if (gap > EMBED_COVERAGE_FAIL_GAP) {
    return { name, status: 'FAIL', detail,
             remedy: 'captain-memo reindex   (re-embeds every chunk that has no vector; --force redoes all of them, including the ones that are fine)' };
  }
  return { name, status: 'WARN', detail,
           remedy: 'run doctor again in a few minutes — ingest may still be catching up. If it persists: captain-memo reindex' };
}

/** The vector index has centroids that are all zeros. Such a centroid never wins a vector, so everything lands in the
 *  others (an outside user's store, 2026-10-14: 10 of 11, all 41,198 vectors in one cluster) and every dedup / theme
 *  pass walks every pair. `ivf.assigned == ivf.vectors` read as a healthy 100% the whole time. Not a FAIL: since 0.57.8
 *  the worker repairs it by itself. */
export function ivfHealthCheck(ivf: { centroids?: unknown; zeroCentroids?: unknown } | null | undefined): Check | null {
  const zero = ivf?.zeroCentroids, total = ivf?.centroids;
  if (typeof zero !== 'number' || typeof total !== 'number' || zero <= 0) return null;
  return { name: 'vector index', status: 'WARN',
           detail: `${zero} of ${total} clusters have an all-zero centre and can never receive a vector, so the rest hold everything and consolidation (dedup, themes) finds nothing`,
           remedy: 'nothing required: after captain-memo restart the worker rebuilds the index by itself, in the background (search keeps working). Until it finishes this warning stays.' };
}

/** Chunks the embedder refused on their own, again and again. The rest of the queue is not waiting on them. */
export function parkedEmbedCheck(name: string, host: string, parked: number, err: string): Check {
  return { name, status: 'WARN',
           detail: `${host}: ${parked} chunk(s) parked after repeated embed failures (keyword search still finds them) — ${err}`,
           remedy: 'nothing required — each is retried once a day. `grep "parking chunk" worker.log` names them.' };
}

/** Embedding is paused because too many tokens went to requests that never got an answer. null when it is not. */
export function embedderSpendCheck(usage: Pick<EmbedUsage, 'paused_until_epoch' | 'window_wasted_tokens'> | null | undefined): Check | null {
  if (!usage?.paused_until_epoch) return null;
  const until = new Date(usage.paused_until_epoch * 1000).toTimeString().slice(0, 5);
  return { name: 'embedder spend', status: 'WARN',
           detail: `embedding paused until ${until} in at least one of the worker's engines (the indexer and each search reader pause on their own): ${usage.window_wasted_tokens.toLocaleString('en-US')} tokens went to requests that never got an answer in the last hour`,
           remedy: 'nothing required, it resumes by itself. If it keeps coming back the link to the provider is too slow or down: raise CAPTAIN_MEMO_EMBEDDER_TIMEOUT_MS in worker.env, then captain-memo restart' };
}

/** Files indexed as memory that are not markdown: what a too-wide watcher (fixed 2026-10-01) left behind. */
export function nonMarkdownMemoryCheck(paths: string[]): Check | null {
  if (paths.length === 0) return null;
  return { name: 'indexed non-markdown files', status: 'WARN',
           detail: `${paths.length} file(s) indexed as memory are not markdown, e.g. ${paths[0]}. Their chunks cost embedding tokens and keep retrying`,
           remedy: 'captain-memo maintenance --apply   (the worker also removes them within the hour)' };
}

export interface SidecarHealth { healthy?: boolean; model?: string; dim?: number; error?: string }

/** The local sidecar's own /health. A sidecar whose model cannot load (the transformers / sentence-transformers
 *  pair it was installed with cannot run voyage-4-nano's code) stays up and says so here, rather than
 *  crash-looping with no answer: so this names the failure instead of showing a green service that embeds nothing. */
export function sidecarHealthVerdict(b: SidecarHealth): Check {
  if (b.healthy) return { name: 'embedder service', status: 'PASS', detail: `${b.model} dim=${b.dim} on :8124` };
  const why = String(b.error ?? 'it gave no reason').replace(/\s+/g, ' ').slice(0, 200);
  return { name: 'embedder model', status: 'FAIL',
           detail: `local sidecar is running but could not load ${b.model ?? 'its model'}: ${why}`,
           remedy: 're-run `captain-memo install` and pick "local sidecar": it re-pins the sidecar\'s Python packages and checks the model loads before starting it' };
}

function checkEmbedderSpendAndJunk(): void {
  const spend = embedderSpendCheck(lastStats?.embedder_usage as EmbedUsage | undefined);
  if (spend) record(spend);
  if (!existsSync(META_DB_PATH)) return;
  try {
    const junk = nonMarkdownMemoryCheck(removeNonMarkdownMemoryDocuments(META_DB_PATH, false));
    if (junk) record(junk);
  } catch { /* an unreadable meta db is reported by the checks that own it */ }
}

async function checkEmbedder(): Promise<void> {
  // Read worker.env to figure out what backend the user actually picked.
  // Hosted Voyage / OpenAI / aelita endpoints are normal — not warnings.
  const endpoint = readWorkerEnvVar('CAPTAIN_MEMO_EMBEDDER_ENDPOINT') ?? '';
  const isLocal = endpoint.startsWith('http://127.0.0.1:8124')
               || endpoint.startsWith('http://localhost:8124');
  // The queue's state sits under `observations` in /stats. This read the top level, where it never was,
  // so the hosted check passed whatever the queue was doing.
  const queue = lastStats && ((lastStats.observations ?? {}) as NonNullable<Parameters<typeof embedderVerdict>[1]>);
  // Coverage is about the corpus, not the backend: hosted and local sidecar alike can leave chunks without a vector.
  const coverage = embedCoverageCheck(lastStats && {
    total_chunks: lastStats.total_chunks,
    vectors: (lastStats.ivf as { vectors?: unknown } | undefined)?.vectors,
    indexing: (lastStats.indexing as { status?: unknown } | undefined)?.status,
  });
  if (coverage) record(coverage);
  const ivfHealth = ivfHealthCheck(lastStats?.ivf as { centroids?: unknown; zeroCentroids?: unknown } | undefined);
  if (ivfHealth) record(ivfHealth);
  if (!isLocal) {
    record(embedderVerdict(endpoint, queue));
    return;
  }
  if ((queue?.embed_parked ?? 0) > 0) {
    record(parkedEmbedCheck('embedder queue', 'local sidecar', queue!.embed_parked!, String(queue!.embed_error ?? '').slice(0, 120)));
  }
  // Local sidecar: the HTTP /health probe is authoritative for liveness; the
  // service-manager state only tells us why it's down (installed vs. not).
  const h = await fetchJson('http://127.0.0.1:8124/health');
  const hb = h.ok ? (h.body as SidecarHealth | null) : null;
  if (typeof hb?.healthy === 'boolean') {   // anything else on :8124 is not our sidecar: fall through to the service checks
    record(sidecarHealthVerdict(hb));
    return;
  }
  if (await getServiceManager().isActive('captain-memo-embed')) {
    record({ name: 'embedder service', status: 'FAIL',
             detail: 'service active but /health not responding (a sidecar that cannot load its model exits and restarts; its log names the error)',
             remedy: isWindows ? 'Get-ScheduledTaskInfo captain-memo-embed' : 'journalctl --user -u captain-memo-embed -n 30 --no-pager   (system install: without --user)' });
    return;
  }
  record({ name: 'embedder service', status: 'FAIL', detail: 'worker.env points at local sidecar but the service is not running',
           remedy: 'captain-memo install   (pick "local sidecar"), or change CAPTAIN_MEMO_EMBEDDER_ENDPOINT to a hosted backend' });
}

/** What the two worker probes MEAN, apart from how they are fetched — so the
 *  "/health green, /stats broken" case can be tested without a live worker.
 *
 *  That case used to be one WARN with no remedy and exit 0. It is a worker that
 *  cannot serve a single read: the cockpit renders the captain as unreachable and
 *  every recall path is down. `healthy` only proves the process is listening. */
export function workerVerdict(p: {
  healthy: boolean;
  statsOk: boolean;
  statsError?: string | undefined;
  chunks?: number | undefined;
  observations?: number | undefined;
  project?: string | undefined;
  indexing?: { status?: string; done?: number; total?: number; percent?: number } | undefined;
}): Check {
  const at = `:${WORKER_PORT}`;
  if (!p.statsOk) {
    const why = p.statsError ? ` — ${p.statsError}` : '';
    return {
      name: 'worker service', status: 'FAIL',
      detail: `${at} healthy but /stats failed${why}`,
      // This is what a schema change that outran its migration looks like from
      // outside, and the upgrade+restart is what repairs it.
      remedy: 'captain-memo upgrade && captain-memo restart   (a "no such column" here means the DB is behind the code)',
    };
  }
  const idx = p.indexing;
  if (idx?.status === 'indexing') {
    return { name: 'worker service', status: 'PASS',
             detail: `${at} ready · indexing ${idx.done}/${idx.total} (${idx.percent}%) · ${p.chunks} chunks so far` };
  }
  if (idx?.status === 'error') {
    return { name: 'worker service', status: 'WARN',
             detail: `${at} reachable but indexing reported error (chunks=${p.chunks})`,
             remedy: isWindows ? 'Get-ScheduledTaskInfo captain-memo-worker' : 'journalctl -u captain-memo-worker -n 30 --no-pager' };
  }
  return { name: 'worker service', status: 'PASS',
           detail: `${at} healthy · ${p.chunks} chunks · ${p.observations ?? 0} observations · project=${p.project}` };
}

async function checkWorker(): Promise<void> {
  // The HTTP /health probe is the AUTHORITATIVE liveness signal — lead with it.
  // The Windows Scheduled-Task state has no 'failed' notion, so /health (not the
  // supervisor) decides whether the worker is truly up.
  const base = `http://127.0.0.1:${WORKER_PORT}`;
  const h = await fetchJson(`${base}/health`);
  if (h.ok && (h.body as { healthy?: boolean }).healthy) {
    const s = await fetchJson(`${base}/stats`);
    const b = (s.body ?? {}) as {
      total_chunks?: number; project_id?: string; error?: string;
      indexing?: { status?: string; done?: number; total?: number; percent?: number; errors?: number };
      observations?: { total?: number };
    };
    record(workerVerdict({
      // Prefer the worker's own `error` (it explains itself best); fall back to HOW the call failed —
      // timeout vs HTTP status vs refused connection. Without the fallback a mid-boot worker and a broken
      // one printed the identical bare "healthy but /stats failed", under a remedy about DB migrations.
      healthy: true, statsOk: s.ok, ...((b.error || s.why) && { statsError: b.error || s.why }),
      chunks: b.total_chunks, observations: b.observations?.total, project: b.project_id,
      ...(b.indexing && { indexing: b.indexing }),
    }));
    // Kept for checkEmbedder: a hosted backend is judged by what its queue is doing,
    // and this is the only place that already paid for the fetch.
    lastStats = s.ok ? (b as Record<string, unknown>) : null;
    // Spec 4.2 — the hook fails OPEN, so a missed deadline is invisible without this.
    // The deadline is the HOOK's own timeout, read from worker.env, not a server constant.
    const hookDeadline = Number(readWorkerEnvVar('CAPTAIN_MEMO_HOOK_TIMEOUT_MS') ?? DEFAULT_HOOK_TIMEOUT_MS);
    const injectCheck = injectLatencyVerdict(
      (lastStats as { inject_latency?: Parameters<typeof injectLatencyVerdict>[0] } | null)?.inject_latency,
      hookDeadline,
    );
    if (injectCheck) record(injectCheck);   // null = too few samples / older worker: say nothing
    return;
  }
  // /health did not answer. Use the service-manager state to explain why:
  // installed-but-not-responding vs. not installed/running.
  if (await getServiceManager().isActive('captain-memo-worker')) {
    record({ name: 'worker service', status: 'FAIL', detail: 'service active but /health not responding',
             remedy: isWindows ? 'Get-ScheduledTaskInfo captain-memo-worker' : 'journalctl -u captain-memo-worker -n 30 --no-pager' });
    return;
  }
  record({ name: 'worker service', status: 'FAIL', detail: 'not running',
           remedy: 'captain-memo install' });
}

async function checkWorkerVersion(): Promise<void> {
  // Check A — does the RUNNING worker match the INSTALLED code? The banner reads the running
  // worker's /stats version, so a stale worker (reinstall that didn't actually restart it) shows
  // here as running < installed.
  const s = await fetchJson(`http://127.0.0.1:${WORKER_PORT}/stats`);
  const raw = (s.ok && s.body && typeof (s.body as { version?: unknown }).version === 'string')
    ? (s.body as { version: string }).version
    : null;
  if (raw === null) return; // worker unreachable / no version — the `worker service` check owns that
  const v = decideWorkerDrift(raw, VERSION);
  record({ name: 'worker version', status: v.status, detail: v.detail, ...(v.remedy ? { remedy: v.remedy } : {}) });
}

/** Worker auth (#229): is the token file there and owner-only, did doctor's own token pass, and which callers
 *  still come without one (warn mode serves them; enforce mode would refuse them). Pure, for the tests. */
export function workerAuthVerdict(p: {
  token: boolean; looseMode: boolean; statsStatus: number | null;
  report?: { mode: string; armed: boolean; tokenless: Record<string, TokenlessRow> } | null; now: number;
}): Check {
  const name = 'worker auth';
  if (!p.token) return { name, status: 'FAIL', detail: `no readable token at ${WORKER_TOKEN_PATH}`, remedy: 'restart the worker: it creates the file on start (and logs why when it cannot)' };
  if (p.looseMode) return { name, status: 'WARN', detail: `${WORKER_TOKEN_PATH} is readable by other users`, remedy: `chmod 600 ${WORKER_TOKEN_PATH} (the worker also tightens it on start)` };
  if (p.statsStatus === 401 || p.statsStatus === 503) return { name, status: 'FAIL', detail: `the worker refused doctor's token (HTTP ${p.statsStatus})`, remedy: 'restart the worker so it reads the current token file' };
  if (!p.report) return { name, status: 'PASS', detail: 'token file present and owner-only (this worker does not report tokenless calls)' };
  if (!p.report.armed) return { name, status: 'FAIL', detail: 'the worker runs without a token (it could not create or read the file)', remedy: 'see the [worker-auth] line in the worker log' };
  const recent = Object.entries(p.report.tokenless).filter(([, r]) => p.now - r.last_at < 86_400_000);
  if (p.report.mode === 'enforce') return { name, status: 'PASS', detail: 'enforced: every call except /health needs the token' };
  if (recent.length === 0) return { name, status: 'PASS', detail: 'warn mode, and no tokenless call in the last 24 h', remedy: 'safe to set CAPTAIN_MEMO_WORKER_AUTH=enforce in worker.env and restart the worker' };
  const list = recent.sort((a, b) => b[1].last_at - a[1].last_at).slice(0, 5).map(([k, r]) => `${k} x${r.count}`).join(', ');
  return { name, status: 'WARN', detail: `warn mode: ${recent.length} route(s) still called without a token in the last 24 h (${list})`, remedy: 'restart the Claude/Codex/Gemini sessions and tools started before this upgrade, then re-run doctor' };
}

async function checkWorkerAuth(): Promise<void> {
  const token = readWorkerToken() !== null;
  let looseMode = false;
  try { looseMode = process.platform !== 'win32' && (statSync(WORKER_TOKEN_PATH).mode & 0o077) !== 0; } catch { /* missing: token=false says so */ }
  const s = await fetchJson(`http://127.0.0.1:${WORKER_PORT}/stats`);
  if (!s.ok && s.status === undefined) return;   // worker unreachable: the `worker service` check owns that
  const report = s.ok ? (s.body as { worker_auth?: Parameters<typeof workerAuthVerdict>[0]['report'] }).worker_auth ?? null : null;
  record(workerAuthVerdict({ token, looseMode, statsStatus: s.ok ? null : s.status ?? null, report, now: Date.now() }));
}

async function checkVectorDim(): Promise<void> {
  // The dim-mismatch trap: the embedder returns N-dim vectors but the vector index
  // was built at M dims. Every write (remember) throws at vector.add() and vector
  // search silently falls back to keyword-only — reads "work" while writes are dead.
  // The worker measures the embedder's real dim at boot and reports both in /stats.
  const s = await fetchJson(`http://127.0.0.1:${WORKER_PORT}/stats`);
  if (!s.ok) return; // worker unreachable — the `worker service` check owns that
  const b = s.body as { embedder?: { dim?: number | null }; vector_store?: { dim?: number } };
  const embDim = b.embedder?.dim ?? null;
  const storeDim = b.vector_store?.dim ?? null;
  if (embDim == null || storeDim == null) return; // older worker without the fields — skip
  if (embDim === storeDim) {
    record({ name: 'embedding dim', status: 'PASS', detail: `embedder and index agree at ${storeDim} dims` });
    return;
  }
  record({
    name: 'embedding dim', status: 'FAIL',
    detail: `embedder returns ${embDim}-dim but the vector index is ${storeDim}-dim — writes (remember) fail and vector search is silently keyword-only`,
    remedy: `captain-memo reindex --redim ${embDim}   (rebuilds the index at the embedder's dimension; setting CAPTAIN_MEMO_EMBEDDING_DIM alone will NOT fix an existing index)`,
  });
}

/** One finding per ACTIVE capture source. Active = the worker reports it in
 *  /stats capture.sources, i.e. the tool's session directory exists on this host.
 *  Active with zero ingested sessions means capture has not produced any observations
 *  from that tool yet — worth a look, but NOT necessarily broken.
 *
 *  `ingested` is `undefined` when the /stats payload has no `ingested` field at
 *  all — an older worker that predates this check, not a source that is really
 *  at zero. That is unknown, not zero, so it produces NO findings (matching the
 *  `sources === undefined` skip a few lines below in checkCapture()) rather than
 *  a finding on every active source. Once the field IS present, a source missing
 *  from the map is a real zero — the worker enumerated it and it had no
 *  ingested sessions to report.
 *
 *  WARN, not FAIL: the driver seeds a per-source cutoff the FIRST tick a source is
 *  seen (see driver.ts) and deliberately skips every pre-existing session older than
 *  it — that is by design, not damage. So a brand-new `connect codex` + `doctor` on
 *  ANY fresh install lands exactly here, with capture working correctly. That is the
 *  common case, and a diagnostic that FAILs the common case trains people to ignore
 *  it (and non-zero-exits the onboarding path itself). The genuinely-broken case (a
 *  payload-format rename that silently zeroes out every extract — see the codex-source
 *  zero-turn warning) lands here too and is indistinguishable from outside without
 *  reading worker.log — so the remedy leads with the benign fix and falls back to the
 *  log for the rest. */
export function captureSourceVerdict(
  sources: string[],
  ingested: Record<string, number> | undefined,
  recent: Record<string, number> | undefined,
  byOrigin?: Record<string, number> | undefined,
): Check[] {
  // Either field absent (a worker predating them) ⇒ we know nothing. Say nothing.
  if (ingested === undefined || recent === undefined) return [];
  return sources.flatMap((id) => {
    const n = ingested[id] ?? 0;
    if (n > 0) {
      return [{ name: `capture:${id}`, status: 'PASS', detail: `${n} session(s) ingested` } as Check];
    }
    // `events_ingested` arrived as ALTER TABLE ... NOT NULL DEFAULT 0 (b6903b9, 2026-07-30), so every
    // row written BEFORE it reads back as "this session produced nothing" — which is precisely what
    // ingestedSessions() counts. A source last captured before that migration is therefore pinned at
    // 0 here however well it worked: on this host agy (last 07-26) and gemini (07-30) both showed 0
    // while the corpus already held 246 and 15 of their observations. The remedy below cannot clear
    // it either — capture backfill skips any session whose marker is unchanged, so those rows are
    // never re-extracted and never recounted, and the warning would stand forever.
    //
    // observations.by_origin answers the question this check is actually asking ("is capture yielding
    // observations?") directly, and is immune to that archaeology: if a source put observations in the
    // corpus, capture works. An additive column default is not neutral — it asserts a value about
    // history it knows nothing about, so never let one become a diagnostic's ground truth.
    const obs = byOrigin?.[id] ?? 0;
    if (obs > 0) {
      return [{ name: `capture:${id}`, status: 'PASS', detail: `${obs} observation(s) captured` } as Check];
    }
    // "The session directory exists" is NOT "the tool is in use here". A single abandoned
    // rollout from months ago otherwise makes a source permanently active, and doctor nags
    // forever about a tool this machine does not run — the false alarm that teaches people
    // to ignore doctor. Only speak when there is something capture SHOULD have caught:
    // sessions newer than this source's cutoff that produced nothing.
    if ((recent[id] ?? 0) === 0) return [];
    return [{
      name: `capture:${id}`,
      status: 'WARN',
      detail: `${id} sessions exist on this host but none have been ingested yet — normal right after enabling capture (pre-existing sessions are skipped by design until backfilled), but worth checking if it persists`,
      remedy: `captain-memo capture backfill   (ingests ${id}'s pre-existing sessions now — the likely fix); if it still shows nothing afterwards, check worker.log for '[capture:${id}]' warnings and confirm the session directory the worker resolved matches what the tool actually writes to (captain-memo capture status)`,
    } as Check];
  });
}

/**
 * The summarizer line, from the worker's own /stats report. Four states, and the point of splitting
 * them out is that three of them used to render as one green line or one wrong sentence:
 *
 *  - exhausted AFTER demotions → the chain ran out at RUNTIME. Must not say "built no summarizer"
 *    (the boot-time message): it built one, ran on it, and outlived it.
 *  - never built                → the original boot-time credentials failure.
 *  - cooling down               → built but in error-backoff.
 *  - running                    → PASS only when it is running on the provider you ASKED for. A
 *    worker healthy on its fallback is a WARN, because that is precisely the state a green line
 *    hides: the configured provider died hours ago and nobody was told.
 */
export function summarizerVerdict(sm: {
  provider?: string; enabled?: boolean; cooling_down?: boolean;
  skipped?: Array<{ provider: string; reason: string }>;
  demoted?: Array<{ provider: string; reason: string; at_epoch: number }>;
}): Check {
  const demoted = sm.demoted ?? [];
  const skipped = sm.skipped ?? [];
  const demotedLine = demoted
    .map(d => `${d.provider} (${d.reason} — ${new Date(d.at_epoch * 1000).toLocaleString()})`)
    .join('; ');

  if (sm.enabled === false && demoted.length > 0) {
    return {
      name: 'summarizer',
      status: 'FAIL',
      detail:
        `STOPPED — the provider chain was exhausted at runtime. Demoted: ${demotedLine}. No observations ` +
        `are being created and cross-AI capture is DISABLED. With nothing running there is no working provider ` +
        `to protect from flapping, so the worker re-checks the whole chain every 10 minutes and recovers by ` +
        `itself once a login is repaired.`,
      remedy: 'fix the provider(s) above (e.g. `claude login` for claude-oauth): the worker picks it up within 10 minutes, or `captain-memo restart` retries at once',
    };
  }
  if (sm.enabled === false) {
    return {
      name: 'summarizer',
      status: 'FAIL',
      detail:
        `NOT running — provider '${sm.provider ?? '?'}' has no usable credentials, so the worker built no ` +
        `summarizer. No observations are being created and cross-AI capture is DISABLED. ` +
        // The chain walk recorded WHY each provider was passed over — "token has expired" and "no token
        // at all" want different fixes — and this line used to throw that away, leaving the reader to
        // guess from generic prose. It was already in hand; print it.
        (skipped.length > 0
          ? `Chain walk: ${skipped.map(s => `${s.provider} (${s.reason})`).join('; ')}. `
          : '') +
        (sm.provider === 'claude-oauth'
          ? 'The worker found no valid OAuth token at ~/.claude/.credentials.json (as IT resolves home — check the ' +
            'worker.log line). Fix: run `claude login`, then restart the worker; if it still fails, set ' +
            'CLAUDE_CODE_OAUTH_TOKEN in worker.env. '
          : 'Fix: provide credentials for it, or set CAPTAIN_MEMO_SUMMARIZER_PROVIDER to a provider you have creds for. '),
    };
  }
  if (sm.cooling_down) {
    return {
      name: 'summarizer',
      status: 'FAIL',
      detail:
        `built, but FAILING — provider '${sm.provider ?? '?'}' is in error-backoff (recent API calls failed), so ` +
        `observations aren't being distilled. ` +
        (demoted.length > 0 ? `Already failed over once (${demotedLine}) — this is the SUCCESSOR failing. ` : '') +
        (sm.provider === 'claude-oauth'
          ? 'Most often an EXPIRED OAuth token (401) — run `claude login` to refresh, then restart the worker. '
          : 'Check worker.log for the provider error (bad key / rate-limit / network). '),
    };
  }
  return {
    name: 'summarizer',
    status: skipped.length > 0 || demoted.length > 0 ? 'WARN' : 'PASS',
    detail: `${sm.provider} running — observations + capture enabled`
      + (demoted.length > 0 ? ` · FAILED OVER — demoted at runtime: ${demotedLine}` : '')
      + (skipped.length > 0
          ? ` · PREFERRED provider(s) skipped: ${skipped.map(s => `${s.provider} (${s.reason})`).join('; ')}`
          : ''),
    ...((skipped.length > 0 || demoted.length > 0) && {
      remedy: demoted.length > 0
        ? `fix the demoted provider(s) above, then \`captain-memo restart\` — a running worker never `
          + `retries a demoted provider, so ${sm.provider} serves until restart`
        : `fix the preferred provider, or drop it from CAPTAIN_MEMO_SUMMARIZER_PROVIDER `
          + `so the chain reflects what this machine can actually run`,
    }),
  };
}

async function checkCapture(): Promise<void> {
  const s = await fetchJson(`http://127.0.0.1:${WORKER_PORT}/stats`);
  if (!s.ok) return; // worker unreachable — the `worker service` check owns that
  const b = s.body as {
    capture?: { sources?: string[]; ingested?: Record<string, number>; recent?: Record<string, number>; native?: Record<string, number> };
    summarizer?: { provider?: string; enabled?: boolean; cooling_down?: boolean;
                   skipped?: Array<{ provider: string; reason: string }>;
                   demoted?: Array<{ provider: string; reason: string; at_epoch: number }> };
    observations?: { by_origin?: Record<string, number> };
  };

  // Summarizer LIVENESS — the worker's ground truth (whether it actually built a summarizer), not the
  // configured provider name. When the resolved provider has no usable credentials the worker runs with NO
  // summarizer: NO observations are created (from Claude Code OR cross-AI) and capture is gated off. That
  // failure previously went ONLY to worker.log — which no user reads — so doctor looked "all green" while the
  // whole pipeline was dead. Surface it loudly here.
  const sm = b.summarizer;
  liveSummarizer = {
    ...(sm?.provider !== undefined && { provider: sm.provider }),
    demoted: (sm?.demoted ?? []).map(d => d.provider),
  };
  const summarizerOff = sm?.enabled === false;
  const verdict = sm && sm.enabled !== undefined ? summarizerVerdict(sm) : null;
  if (verdict) record(verdict);

  for (const check of captureSourceVerdict(
    b.capture?.sources ?? [], b.capture?.ingested, b.capture?.recent, b.observations?.by_origin,
  )) {
    record(check);
  }

  // Which non-Claude tools are feeding observations (codex/agy/gemini/kimi/opencode).
  const sources = b.capture?.sources;
  if (sources === undefined) return; // older worker without the field — skip
  record({
    name: 'cross-AI capture',
    status: 'PASS',
    detail: sources.length > 0
      ? `capturing obs from ${sources.join(', ')}`
      : summarizerOff
        ? 'gated OFF — the summarizer is not running (fix the summarizer check above first)'
        : 'on — no non-Claude tool sessions detected on this host',
  });
}

// Run a git command in repoRoot; { ok:false } on non-zero / missing binary (never throws).
function gitOut(repoRoot: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf-8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

// Parse the `version` field out of <ref>:package.json; null when the ref/file/JSON is unreadable.
function versionFromRef(repoRoot: string, ref: string): string | null {
  const r = gitOut(repoRoot, ['show', `${ref}:package.json`]);
  if (!r.ok) return null;
  try {
    const v = (JSON.parse(r.out) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

function checkCheckout(): void {
  // Check B — is the CLONE itself parked on a stale branch? A reinstall rebuilds from whatever
  // this checkout points at, so a clone left on an old branch faithfully rebuilds the old version.
  // Read-only: compares HEAD against ALREADY-FETCHED remote-tracking refs (no network).
  const repoRoot = join(import.meta.dir, '../../..');
  try {
    const wt = gitOut(repoRoot, ['rev-parse', '--is-inside-work-tree']);
    if (!wt.ok || wt.out !== 'true') {
      record({ name: 'checkout', status: 'PASS', detail: 'not a git checkout (packaged install) — branch check skipped' });
      return;
    }
    const ab = gitOut(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).out;  // 'HEAD' (literal) when detached
    const branch = (ab && ab !== 'HEAD') ? ab : '(detached)';
    const headVersion = versionFromRef(repoRoot, 'HEAD');
    if (!headVersion) {
      record({ name: 'checkout', status: 'WARN', detail: `on ${branch} but could not read HEAD:package.json version` });
      return;
    }
    const refsOut = gitOut(repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/']);
    const candidates = refsOut.ok
      ? parseRemoteCandidates(refsOut.out, ref => versionFromRef(repoRoot, ref))
      : [];
    const containsHead = (ref: string) =>
      spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', 'HEAD', ref], { encoding: 'utf-8' }).status === 0;
    const target = pickUpgradeTarget(headVersion, candidates, containsHead);
    if (target.kind === 'current') {
      record({ name: 'checkout', status: 'PASS', detail: `${branch} @ v${headVersion} is current among known remotes` });
    } else if (target.kind === 'upgrade') {
      record({
        name: 'checkout', status: 'WARN',
        detail: `${branch} @ v${headVersion} is behind ${target.ref} @ v${target.version}`,
        remedy: `git checkout ${target.branch} (or git pull), then captain-memo install — a rebuild here would produce v${headVersion}`,
      });
    } else {
      const list = target.candidates.map(c => `${c.ref}@v${c.version}`).join(', ');
      record({
        name: 'checkout', status: 'WARN',
        detail: `newer versions exist (${list}) but none continue this checkout's history`,
        remedy: `verify the correct line for THIS captain before switching`,
      });
    }
  } catch (err) {
    record({ name: 'checkout', status: 'WARN', detail: `branch check failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function checkConfig(): void {
  // Look for worker.env in the per-platform CONFIG_DIR (plus the /etc system-mode
  // fallback on Linux) — workerEnvPaths() returns the correct candidate list.
  const candidates = workerEnvPaths();
  const path = candidates.find(existsSync) ?? null;
  if (!path) {
    record({ name: 'worker config', status: 'FAIL', detail: `not found at ${candidates.join(' or ')}`,
             remedy: 'captain-memo install' });
    return;
  }
  const content = readFileSync(path, 'utf-8');
  const provider = (content.match(/CAPTAIN_MEMO_SUMMARIZER_PROVIDER=(.+)/) ?? [])[1] ?? '?';
  const model = (content.match(/CAPTAIN_MEMO_SUMMARIZER_MODEL=(.+)/) ?? [])[1] ?? '?';
  const watch = (content.match(/CAPTAIN_MEMO_WATCH_MEMORY=(.+)/) ?? [])[1] ?? '(none)';
  const skills = (content.match(/CAPTAIN_MEMO_WATCH_SKILLS=(.*)/) ?? [])[1] ?? 'auto (default)';
  const capabilities = (content.match(/CAPTAIN_MEMO_WATCH_CAPABILITIES=(.*)/) ?? [])[1] ?? 'auto (default)';
  // worker.env is the CONFIGURED chain, not the live one. Say which entry is actually serving
  // whenever they disagree — a demotion makes `summarizer=codex,agy` a statement about intent.
  const live = liveSummarizer;
  const drift = live?.provider && live.provider !== provider.split(',')[0]!.trim()
    ? ` · RUNNING ${live.provider}${live.demoted.length > 0 ? ` (demoted: ${live.demoted.join(', ')})` : ''}`
    : '';
  record({ name: 'worker config', status: drift ? 'WARN' : 'PASS',
           detail: `summarizer=${provider} model=${model} watch=${watch.slice(0, 50)}${watch.length > 50 ? '…' : ''} skills=${skills.slice(0, 30)}${skills.length > 30 ? '…' : ''} capabilities=${capabilities.slice(0, 30)}${capabilities.length > 30 ? '…' : ''}${drift}`,
           ...(drift && { remedy: 'the chain is doing its job, but the head is not serving — see the summarizer check above' }) });
}

export function checkRemember(): Check {
  // Read-only: surfaces the curated-memory WRITE knobs (spec §8). All values come
  // from worker.env, falling back to the contract defaults in src/shared/paths.ts.
  const dir = readWorkerEnvVar(ENV_REMEMBER_DIR) ?? DEFAULT_REMEMBER_DIR;
  const promote = parsePromotionMode(readWorkerEnvVar(ENV_PROMOTE_ENABLE) ?? undefined);
  const max = readWorkerEnvVar(ENV_PROMOTE_MAX_PER_RUN) ?? String(DEFAULT_PROMOTE_MAX_PER_RUN);
  const dedup = readWorkerEnvVar(ENV_REMEMBER_DEDUP_THRESHOLD) ?? String(DEFAULT_REMEMBER_DEDUP_THRESHOLD);
  const shortDir = dir.replace(homedir(), '~');
  const check: Check = {
    name: 'remember / promote',
    status: 'PASS',
    detail: `dir=${shortDir} · promote=${promote} · max=${max} · dedup=${dedup}`,
  };
  record(check);
  return check;
}

/** Codex approves MCP tools one at a time, and `connect codex` writes those approvals once (see mergeCodexToolApprovals),
 *  so a release that adds a tool leaves it unapproved until the worker's boot refresh or `connect codex` appends it. Until
 *  then Codex asks for it, and `codex exec` rejects the call outright. null = not applicable: no config file, or
 *  captain-memo is not registered in it (Codex not installed, or never connected). Read-only. */
export function codexApprovalsVerdict(toml: string | null, cfgPath: string): Check | null {
  const { registered, missing } = codexApprovalState(toml);
  if (!registered) return null;
  const name = 'codex approvals';
  if (missing.length === 0) return { name, status: 'PASS', detail: `all ${CODEX_TOOL_NAMES.length} captain-memo tools approved in ${cfgPath}` };
  return {
    name, status: 'WARN',
    detail: `${missing.length} of ${CODEX_TOOL_NAMES.length} captain-memo tools have no approval in ${cfgPath}: ${missing.join(', ')}. Codex prompts for each, and \`codex exec\` rejects it`,
    remedy: 'captain-memo connect codex',
  };
}

/** The `codex approvals` row for the config.toml Codex itself reads ($CODEX_HOME, else ~/.codex — the same file `connect
 *  codex` and the worker's boot refresh write), or null when the check does not apply. */
export function codexApprovalsCheck(home: string = homedir(), env: Record<string, string | undefined> = process.env): Check | null {
  const cfgPath = codexConfigPath(home, env);
  try {
    return codexApprovalsVerdict(existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null, cfgPath);
  } catch (e) {
    return { name: 'codex approvals', status: 'WARN', detail: `could not read ${cfgPath} (${(e as Error).message})`, remedy: 'captain-memo connect codex' };
  }
}

function checkCodexApprovals(): void {
  const check = codexApprovalsCheck();
  if (check) record(check);
}

/** worker.env's CODEX_HOME as the worker reads it (loadWorkerEnv strips one pair of surrounding quotes; readWorkerEnvVar does not). */
function unquoteEnvValue(v: string | null): string {
  const t = (v ?? '').trim();
  return t.length >= 2 && /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** `connect` and `doctor` follow the CODEX_HOME of the SHELL they run in; the worker's boot refresh of Codex's tool approvals follows its OWN
 *  environment: worker.env (on Windows, a Scheduled Task with no shell, that is all of it). Where the two name different folders the approvals
 *  land in one config.toml while the other stays stale, and nothing else says so. null = they agree (both unset, or the same folder). Empty
 *  counts as unset, as Codex reads it. A CODEX_HOME given to the worker some other way (a systemd unit's Environment=) is not visible here. */
export function codexHomeVerdict(shellCodexHome: string | undefined, workerEnvCodexHome: string | null, workerEnvPath: string, home: string = homedir()): Check | null {
  const shell = codexHomeDir(home, { CODEX_HOME: shellCodexHome });
  const worker = codexHomeDir(home, { CODEX_HOME: unquoteEnvValue(workerEnvCodexHome) });
  if (normalizePath(shell) === normalizePath(worker)) return null;
  return {
    name: 'codex home', status: 'WARN',
    detail: `your shell's CODEX_HOME is ${shell}, but the worker (${workerEnvPath}) uses ${worker}: connect and doctor follow the shell, the worker's refresh of Codex's tool approvals follows worker.env`,
    remedy: shellCodexHome
      ? `add CODEX_HOME=${shellCodexHome} to ${workerEnvPath}, then: captain-memo restart   (or unset it in your shell if worker.env is the right one)`
      : `set CODEX_HOME to ${worker} in your shell profile, or remove CODEX_HOME from ${workerEnvPath} and run: captain-memo restart`,
  };
}

function checkCodexHome(): void {
  const check = codexHomeVerdict(process.env.CODEX_HOME, readWorkerEnvVar('CODEX_HOME'), workerEnvPaths().find((p) => existsSync(p)) ?? workerEnvPaths()[0] ?? 'worker.env');
  if (check) record(check);
}

/** The `cli shim` row: the Windows PATH shim that install wrote, judged by what it names. null = nothing to say (no shim, or not a
 *  `bun "<path>"` body). Before v0.44.0 install COPIED the checkout's bin\captain-memo.cmd, whose %~dp0 only works inside the checkout. */
export function windowsShimCheck(shimPath: string, body: string | null, exists?: (p: string) => boolean): Check | null {
  if (body === null) return null;
  const s = windowsShimState(body, exists);
  if (s.state === 'unknown') return null;
  const name = 'cli shim';
  if (s.state === 'ok') return { name, status: 'PASS', detail: `${shimPath} -> ${s.entry}` };
  return { name, status: 'WARN', detail: `${shimPath} is stale: ${s.reason}, so \`captain-memo <anything>\` fails with "Module not found"`, remedy: WINDOWS_SHIM_FIX };
}

function checkWindowsShim(): void {
  if (!isWindows) return;
  const path = windowsCliShimPath();
  let body: string | null = null;
  try { body = readFileSync(path, 'utf-8'); } catch { /* no shim installed */ }
  const check = windowsShimCheck(path, body);
  if (check) record(check);
}

/** Every Gemini outside 0.24-0.25 rejects the boolean `hooks.enabled` that connect wrote before it read the version
 *  (0.26+ prints "Invalid configuration" at every start) until connect rewrites it. Silent when there is nothing to report.
 *  0.22 and 0.23 can never be flagged here: with that key present their `gemini --version` exits 52 with empty stdout
 *  ("Invalid configuration ... hooks.enabled Expected array, received boolean" on stderr, run 2026-09-26), so the
 *  version reads as unknown and this check stays silent. */
function checkGeminiHooksToggle(): void {
  const path = join(homedir(), '.gemini', 'settings.json');
  let json: string;
  try { json = readFileSync(path, 'utf-8'); } catch { return; }   // no Gemini settings: nothing to check
  let version = '';
  // 30 s: a cold `gemini --version` took ~24 s on a loaded box (#67). Paid only when the old shape is present.
  const rejected = geminiHooksToggleRejected(json, () => {
    const r = spawnSync('gemini', ['--version'], { encoding: 'utf-8', timeout: 30_000 });
    version = (r.stdout ?? '').trim();
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  });
  if (!rejected) return;
  record({ name: 'gemini hooks', status: 'WARN',
           detail: `${path.replace(homedir(), '~')} has hooks.enabled, which ${Bun.which('gemini') ?? 'gemini'} ${version} rejects at every start`,
           remedy: 'captain-memo connect   (rewrites it as hooksConfig.enabled; run it with the Gemini you use first on PATH)' });
}

function checkPluginRegistration(): void {
  // Plugins are registered with Claude Code's marketplace, not as a symlink
  // under ~/.claude/plugins/. Ask `claude plugin list` for the truth.
  const r = spawnSync('claude', ['plugin', 'list'], { encoding: 'utf-8', timeout: 5000 });
  if (r.status !== 0) {
    record({ name: 'plugin registration', status: 'WARN', detail: `'claude plugin list' returned exit ${r.status}; can't verify`,
             remedy: 'ensure `claude` is on PATH; or run `claude plugin install captain-memo@captain-memo` manually' });
    return;
  }
  // Look for our plugin slug + the enabled status. Exact format from claude CLI:
  //   ❯ captain-memo@captain-memo
  //     Status: ✔ enabled
  const out = (r.stdout ?? '');
  const ourLine = out.split('\n').find(l => l.includes('captain-memo@captain-memo'));
  if (!ourLine) {
    record({ name: 'plugin registration', status: 'FAIL', detail: 'captain-memo@captain-memo not in `claude plugin list`',
             remedy: 'captain-memo install   (re-runs the marketplace registration)' });
    return;
  }
  // Status icon may be on the same line OR below it; check both
  const enabled = /enabled/i.test(out.slice(out.indexOf(ourLine), out.indexOf(ourLine) + 200));
  if (enabled) {
    record({ name: 'plugin registration', status: 'PASS', detail: 'captain-memo@captain-memo · enabled' });
  } else {
    record({ name: 'plugin registration', status: 'WARN', detail: 'captain-memo@captain-memo registered but not enabled',
             remedy: 'claude plugin enable captain-memo@captain-memo' });
  }
}

function checkPluginManifest(): void {
  // Manifest lives in the repo's plugin/ subdir (not in ~/.claude/plugins/...).
  // Check that the source files Claude Code reads via marketplace are present
  // and parseable.
  const repoRoot = join(import.meta.dir, '../../..');
  const manifest = join(repoRoot, 'plugin', '.claude-plugin', 'plugin.json');
  const hooks = join(repoRoot, 'plugin', 'hooks', 'hooks.json');
  if (!existsSync(manifest)) {
    record({ name: 'plugin manifest', status: 'FAIL', detail: `${manifest} missing` });
    return;
  }
  if (!existsSync(hooks)) {
    record({ name: 'plugin hooks', status: 'WARN', detail: `${hooks} missing — sessions won't fire hooks`,
             remedy: 'reinstall the captain-memo repo (the file is checked in)' });
    return;
  }
  record({ name: 'plugin manifest', status: 'PASS', detail: 'plugin.json + hooks.json present in repo' });
}

// Bug-1 guardrail: the plugin's MCP server + hook ENTRY FILES must resolve as
// real, non-trivial files. On a Windows checkout the old plugin/src + plugin/bin
// git symlinks (mode 120000) materialise as 6-byte text placeholders ("../src"),
// so the entry paths in the manifests point at files that either don't exist or
// are far too small to be a real bundle — the MCP server never starts and the
// hooks fire silently into nothing. We read the configured entry paths straight
// from the manifests (so this keeps verifying whatever the manifests reference)
// and existsSync + size-check each one relative to the plugin root.
const MIN_ENTRY_BYTES = 400; // a real bundle is many KB; a 6-byte symlink placeholder is the failure mode

// Pull the file path out of a manifest reference, stripping the
// ${CLAUDE_PLUGIN_ROOT} prefix (with or without a trailing slash) and any
// surrounding quotes, so it can be resolved relative to the plugin root.
function entryPathFromRef(ref: string, pluginRoot: string): string | null {
  const m = ref.match(/\$\{CLAUDE_PLUGIN_ROOT\}[\/\\]?([^"'\s]+)/);
  if (!m || !m[1]) return null;
  return join(pluginRoot, m[1]);
}

// Collect the entry-file references from plugin.json (mcpServers args) and
// hooks.json (hook commands). Returns a de-duplicated list of { label, file }.
function collectPluginEntryFiles(pluginRoot: string): Array<{ label: string; file: string }> {
  const entries: Array<{ label: string; file: string }> = [];
  const seen = new Set<string>();

  const add = (label: string, ref: string) => {
    const file = entryPathFromRef(ref, pluginRoot);
    if (!file || seen.has(file)) return;
    seen.add(file);
    entries.push({ label, file });
  };

  // plugin.json → mcpServers.<name>.args[] (look for the *.js / *.ts entry file)
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf-8')) as {
      mcpServers?: Record<string, { args?: string[] }>;
    };
    for (const [name, srv] of Object.entries(manifest.mcpServers ?? {})) {
      for (const arg of srv.args ?? []) {
        if (/\$\{CLAUDE_PLUGIN_ROOT\}.+\.(js|ts)$/.test(arg)) add(`mcp:${name}`, arg);
      }
    }
  } catch { /* manifest parse handled by checkPluginManifest */ }

  // hooks.json → hooks.<event>[].hooks[].command (extract the *.js / *.ts token)
  try {
    const hooks = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf-8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    for (const groups of Object.values(hooks.hooks ?? {})) {
      for (const group of groups) {
        for (const h of group.hooks ?? []) {
          const cmd = h.command ?? '';
          const tok = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}[^"'\s]+\.(js|ts)/);
          if (tok) add('hook', tok[0]);
        }
      }
    }
  } catch { /* hooks parse handled by checkPluginManifest */ }

  return entries;
}

// Verify each entry file under a given plugin root resolves as a real,
// non-trivial file. Returns the list of problems (empty == all good).
function entryProblems(pluginRoot: string): string[] {
  const problems: string[] = [];
  for (const { label, file } of collectPluginEntryFiles(pluginRoot)) {
    if (!existsSync(file)) {
      problems.push(`${label} → ${file} missing`);
      continue;
    }
    let size = 0;
    try { size = statSync(file).size; } catch { /* treated as 0 below */ }
    if (size < MIN_ENTRY_BYTES) {
      problems.push(`${label} → ${file} only ${size}B (symlink placeholder / empty — not a real bundle)`);
    }
  }
  return problems;
}

// Best-effort: find the installed plugin cache copy under ~/.claude/plugins/cache.
// The layout is cache/<marketplace>/plugins/<plugin>/ (or a direct <plugin>/);
// we look for a dir that actually contains our plugin.json. Returns null when no
// cache dir / no copy is found — never hard-fails.
export function findCachedPluginRoot(cacheRoot: string = join(homedir(), '.claude', 'plugins', 'cache')): string | null {
  if (!existsSync(cacheRoot)) return null;
  const matches: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 5) return;
    if (existsSync(join(dir, '.claude-plugin', 'plugin.json'))) {
      try {
        const m = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf-8')) as { name?: string };
        if (m.name === 'captain-memo') { matches.push(dir); return; } // matched — don't descend further
      } catch { /* keep walking */ }
    }
    let kids: string[] = [];
    try { kids = readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
    catch { return; }
    for (const k of kids) walk(join(dir, k), depth + 1);
  };
  walk(cacheRoot, 0);
  if (matches.length === 0) return null;
  // Claude Code keeps the previous version dir for a 7-day grace period after an
  // upgrade — marked with an `.orphaned_at` file — then garbage-collects it itself
  // (per the plugins reference). Evaluate only the ACTIVE copies so a grace-period
  // leftover is never mistaken for the installed plugin, nor reported as "stale"
  // (which would wrongly nudge toward a manual cache cleanup we must never ask for).
  const active = matches.filter((p) => !existsSync(join(p, '.orphaned_at')));
  const pool = active.length > 0 ? active : matches;
  // Among the active copies, the installed one is the highest version by dir name.
  const versionOf = (p: string): number[] => ((p.split(/[\\/]/).pop() ?? '').match(/\d+/g) ?? []).map(Number);
  const cmpDesc = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (b[i] ?? 0) - (a[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  };
  pool.sort((x, y) => cmpDesc(versionOf(x), versionOf(y)));
  return pool[0] ?? null;
}

function checkPluginEntries(): void {
  const repoRoot = join(import.meta.dir, '../../..');
  const pluginRoot = join(repoRoot, 'plugin');

  const repoProblems = entryProblems(pluginRoot);
  if (repoProblems.length > 0) {
    record({ name: 'plugin entry files', status: 'FAIL',
             detail: repoProblems.join('; '),
             remedy: 'run `bun run build:plugin` to (re)generate plugin/dist (the entry bundles the manifests point at)' });
  } else {
    const files = collectPluginEntryFiles(pluginRoot);
    record({ name: 'plugin entry files', status: 'PASS',
             detail: `${files.length} entr${files.length === 1 ? 'y' : 'ies'} resolve as real bundles in repo plugin/` });
  }

  // Best-effort: also validate the installed cache copy if we can locate one.
  const cachedRoot = findCachedPluginRoot();
  if (cachedRoot) {
    const cacheProblems = entryProblems(cachedRoot);
    if (cacheProblems.length > 0) {
      // WARN, not FAIL: the repo `plugin entry files` check above is authoritative
      // for the fix. A stale/unresolved CACHE copy (e.g. predating a bundle rebuild,
      // or a Windows checkout's symlink placeholders) just needs a refresh — it
      // shouldn't make `doctor` go red for an otherwise-working install.
      record({ name: 'plugin entry (cache)', status: 'WARN',
               detail: `installed cache copy is stale/unresolved (${cacheProblems.join('; ')})`,
               remedy: 're-run `captain-memo install` (refreshes the cache for you), or `claude plugin update captain-memo@captain-memo`; the repo bundles above are the source of truth' });
    } else {
      record({ name: 'plugin entry (cache)', status: 'PASS',
               detail: `installed cache copy entries resolve (${cachedRoot})` });
    }

    // Installed-vs-source version gap. A `directory`-source install is snapshotted into the cache by
    // `captain-memo install`; a git pull alone does not refresh it, and neither does the opt-in
    // self-updater (which does git + bun install + restart and nothing else). So a clone updated by
    // hand leaves the cache copy behind at the version it was last installed at. New CLI sessions read
    // the checkout and never notice; anything reading the CACHE gets the older code, silently.
    const cachedVersion = readPluginManifest(cachedRoot)?.version ?? null;
    if (cachedVersion && compareSemver(cachedVersion, VERSION) === -1) {
      record({
        name: 'plugin cache version', status: 'WARN',
        detail: `cache copy is v${cachedVersion}, this checkout is v${VERSION} — the cache did not follow the last update`,
        remedy: 're-run `captain-memo install` to re-snapshot the checkout into the cache',
      });
    }
  }
}

// A session loads its plugin ONCE, at start, and goes on running that copy for its whole life — so an
// upgrade underneath a running session leaves it on the old code, silently, indefinitely. Verified
// 2026-08-29: seven MCP servers up for days were serving captain-memo 0.20.0 while the checkout had
// been on 0.49.0 since that morning. Claude Code exports CLAUDE_PLUGIN_ROOT into every plugin child
// process, so the version a live session actually loaded is readable from the outside.
//
// Nothing here can fix it — a loaded plugin cannot be swapped under a live session — so this check
// exists to make it SAYABLE. Restarting the session is the whole remedy, and naming WHICH sessions is
// the point: "restart those sessions" alone sends an operator to the wrong lever.
/** How a session of this entrypoint is restarted — the actionable half of the remedy.
 *
 *  The trap this encodes: BOTH remote kinds are hosted by long-lived daemons on THIS host, but by
 *  DIFFERENT ones, so the obvious lever fixes only half the fleet. Verified 2026-08-30 by walking the
 *  process tree: a `claude-desktop` session is `ccd-cli`, child of `~/.claude/remote/srv/<hash>/server
 *  --serve` (up 20 days, parented to init); an `sdk-cli` session is a child of the `claude rc` daemon.
 *  Restarting `claude rc` therefore leaves every Desktop session running its old plugin — which is
 *  exactly what happened here before this hint existed.
 *
 *  A Desktop session's plugin is pinned in its ARGV at spawn (`--plugin-dir <snapshot>`), so it is
 *  fixed for the life of that process no matter what the cache later says. */
function restartHint(entrypoint: string): string {
  if (entrypoint === 'claude-desktop') {
    return 'hosted on THIS host by the Claude Desktop SSH helper (`claude-ssh`, ~/.claude/remote/srv/<hash>/server) — '
      + 'NOT the `claude rc` daemon, which does not touch them; reopen them from the Desktop app, or restart that helper to drop all of them at once';
  }
  if (entrypoint === 'sdk-cli') return 'hosted by the `claude rc` daemon — restarting it replaces them';
  return 'restart it wherever it was started';
}

function checkStalePluginRoots(): void {
  const pins = readLivePluginPins();
  if (pins === null) {
    record({ name: 'live plugin version', status: 'PASS',
             detail: 'no /proc on this platform — running-session plugin versions are not inspectable here' });
    return;
  }
  const behind = new Map<string, number>();   // older version → how many live plugin roots are on it
  const stalePids: number[] = [];             // the processes on those roots, for naming their sessions
  const byRoot = new Map<string, number[]>();
  for (const pin of pins) (byRoot.get(pin.root) ?? byRoot.set(pin.root, []).get(pin.root)!).push(pin.pid);
  let ours = 0, unreadable = 0;
  for (const [root, rootPids] of byRoot) {
    const m = readPluginManifest(root);
    if (m?.name !== 'captain-memo') continue;
    ours++;
    if (!m.version) { unreadable++; continue; }   // counted, never folded into a clean bill of health
    if (compareSemver(m.version, VERSION) === -1) {
      behind.set(m.version, (behind.get(m.version) ?? 0) + 1);
      stalePids.push(...rootPids);
    }
  }
  if (ours === 0) {
    record({ name: 'live plugin version', status: 'PASS', detail: 'no running process is loaded from a captain-memo plugin root' });
    return;
  }
  if (behind.size === 0) {
    // "none behind", not "all on vVERSION" — a root can be NEWER than this checkout, and one with an
    // unreadable manifest was never compared at all.
    record({ name: 'live plugin version', status: 'PASS',
             detail: `${ours} live plugin root(s), none behind v${VERSION}`
               + (unreadable > 0 ? ` (${unreadable} with no readable version — not compared)` : '') });
    return;
  }
  const list = [...behind.entries()].map(([v, n]) => `${n}× v${v}`).join(', ');
  const byEntrypoint = new Map<string, string[]>();
  for (const pid of stalePids) {
    const sess = describeSessionOf(pid);
    if (!sess) continue;
    (byEntrypoint.get(sess.entrypoint) ?? byEntrypoint.set(sess.entrypoint, []).get(sess.entrypoint)!).push(sess.name);
  }
  const who = [...byEntrypoint.entries()]
    .map(([entry, names]) => `${names.length} ${entry} (${[...new Set(names)].sort().join(', ')}) — ${restartHint(entry)}`)
    .join('; ');
  record({
    name: 'live plugin version', status: 'WARN',
    detail: `${list} — older than this checkout (v${VERSION}); sessions loaded from those roots keep running the old code`,
    remedy: (who ? `restart: ${who}.` : 'restart those sessions.')
      + ' A plugin upgrade never reaches an already-running session — the plugin root is fixed in the process argv at spawn.',
  });
}

function statusIcon(s: Status): string {
  return s === 'PASS' ? '\x1b[32m✓\x1b[0m' : s === 'WARN' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
}

interface MigrationDbReport {
  label: string;
  dbPath: string;
  totalNeeded: number;
  applied: Array<{ version: number; name: string; applied_at_epoch: number }>;
}

function renderMigrationReport(reports: MigrationDbReport[]): void {
  console.log('\n  \x1b[1mSchema migrations:\x1b[0m');
  for (const r of reports) {
    const n = r.applied.length;
    const total = r.totalNeeded;
    const allDone = n === total;
    const icon = allDone ? '\x1b[32m✓\x1b[0m' : '\x1b[33m!\x1b[0m';
    if (!existsSync(r.dbPath)) {
      console.log(`    ${'\x1b[2m'}${r.label}:\x1b[0m  not yet created (no worker run)`);
      continue;
    }
    console.log(`    ${icon} ${r.label}: ${n}/${total} applied`);
    for (const row of r.applied) {
      const ts = new Date(row.applied_at_epoch * 1000).toISOString();
      console.log(`        [${row.version}] ${row.name.padEnd(20)} (${ts})`);
    }
    if (!allDone) {
      console.log(`        \x1b[2m→ ${total - n} pending — start the worker to apply\x1b[0m`);
    }
  }
}

/** The underlying handle of a store, which keeps `db` private. Doctor builds the canonical
 *  schema by constructing the real store against :memory:, so it needs to read that handle. */
function rawDb(store: object): Database {
  return (store as { db: Database }).db;
}

/** Every table→column the DB actually has. */
function tableColumns(db: Database): Map<string, Set<string>> {
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const out = new Map<string, Set<string>>();
  for (const t of tables) {
    const cols = db.query(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string }>;
    out.set(t.name, new Set(cols.map(c => c.name)));
  }
  return out;
}

/** What the canonical schema HAS that the live DB does NOT — the evidence doctor was missing.
 *
 *  Counting rows in schema_versions only proves what the DB CLAIMS. A migration that aborted
 *  partway was still recorded as applied, so doctor printed "20/20 applied ✓" while the column
 *  it was supposed to add did not exist and every query touching it threw. Here we compare
 *  against a canonical DB built by running the real migrations into :memory:, so there is no
 *  hand-maintained column list to rot — the migrations stay the single source of truth.
 *
 *  One-directional on purpose: extra local tables/columns are not drift. */
export function schemaDrift(live: Database, canonical: Database): string[] {
  const l = tableColumns(live);
  const out: string[] = [];
  for (const [table, cols] of tableColumns(canonical)) {
    const have = l.get(table);
    if (!have) { out.push(`${table} (table missing)`); continue; }
    for (const col of cols) if (!have.has(col)) out.push(`${table}.${col}`);
  }
  return out;
}

export interface MigrationHealth { label: string; applied: number; total: number; drift: string[] }

/** Put schema state INTO the PASS/WARN/FAIL list. It used to print as loose text outside
 *  `checks`, so a captain with pending migrations — or with drift — still ended the run on
 *  "All systems go" and exit 0. Drift outranks pending: pending self-heals on the next worker
 *  start, drift never does. */
export function migrationVerdict(reports: MigrationHealth[]): Check {
  const drifted = reports.filter(r => r.drift.length > 0);
  if (drifted.length > 0) {
    const what = drifted.map(r => `${r.label}: ${r.drift.join(', ')}`).join(' · ');
    return { name: 'schema migrations', status: 'FAIL', detail: `recorded as applied but MISSING — ${what}`,
             remedy: 'captain-memo upgrade && captain-memo restart; if it persists the DB half-applied a migration — report this with the line above' };
  }
  const pending = reports.reduce((n, r) => n + (r.total - r.applied), 0);
  if (pending > 0) {
    return { name: 'schema migrations', status: 'WARN', detail: `${pending} migration(s) pending`,
             remedy: 'start the worker — it applies them on boot: captain-memo restart' };
  }
  const total = reports.reduce((n, r) => n + r.total, 0);
  return { name: 'schema migrations', status: 'PASS', detail: `${total}/${total} applied · schema verified` };
}

function checkMigrations(dataDir: string): void {
  const OBSERVATIONS_DB = join(dataDir, 'observations.db');
  const QUEUE_DB = join(dataDir, 'queue.db');

  // pending_embed.db has NO schema_versions at all — its table is migrated in the
  // constructor. Nothing tracked it, which is why `last_error` could go missing on every
  // existing install and no check anywhere noticed. Drift is the only signal it has.
  const PENDING_EMBED_DB = join(dataDir, 'pending_embed.db');

  const reports: MigrationDbReport[] = [];
  const health: MigrationHealth[] = [];

  // Canonical schema = whatever the REAL constructors produce in :memory:. No column list
  // to maintain, and it cannot drift from the migrations because it IS the migrations.
  const canonicalOf: Record<string, () => Database> = {
    'observations.db': () => rawDb(new ObservationsStore(':memory:')),
    'queue.db':        () => rawDb(new ObservationQueue(':memory:')),
    'pending_embed.db': () => rawDb(new PendingEmbedQueue(':memory:')),
  };

  for (const { label, dbPath, migrations } of [
    { label: 'observations.db',       dbPath: OBSERVATIONS_DB, migrations: OBSERVATIONS_STORE_MIGRATIONS },
    { label: 'queue.db',               dbPath: QUEUE_DB,        migrations: OBSERVATION_QUEUE_MIGRATIONS },
    { label: 'pending_embed.db',       dbPath: PENDING_EMBED_DB, migrations: [] },
  ]) {
    if (!existsSync(dbPath)) {
      // Not created yet is not a fault — the worker builds it on first run.
      if (migrations.length > 0) reports.push({ label, dbPath, totalNeeded: migrations.length, applied: [] });
      continue;
    }
    let db: Database | null = null;
    let canon: Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const applied = migrations.length > 0 ? getAppliedVersions(db) : [];
      if (migrations.length > 0) reports.push({ label, dbPath, totalNeeded: migrations.length, applied });
      canon = canonicalOf[label]?.() ?? null;
      health.push({ label, applied: applied.length, total: migrations.length,
                    drift: canon ? schemaDrift(db, canon) : [] });
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err));
      if (migrations.length > 0) reports.push({ label, dbPath, totalNeeded: migrations.length, applied: [] });
      console.warn(`    [migrations] could not read ${label}: ${msg}`);
    } finally {
      db?.close();
      canon?.close();
    }
  }

  renderMigrationReport(reports);
  // …and land it in the verdict, not just in the printout above.
  if (health.length > 0) record(migrationVerdict(health));
}

export async function doctorCommand(_args: string[]): Promise<number> {
  console.log('\n\x1b[1;36mCaptain Memo doctor\x1b[0m\n───────────────────');

  // Worker FIRST: it fetches /stats, and checkEmbedder judges a hosted backend by what
  // that report says the embed queue is doing. Reversed, the hosted path sees no stats and
  // can only say "unverified".
  await checkWorker();
  await checkEmbedder();
  checkEmbedderSpendAndJunk();
  await checkWorkerVersion();
  await checkWorkerAuth();
  await checkVectorDim();
  await checkCapture();
  checkCheckout();
  checkConfig();
  checkWindowsShim();
  checkRemember();
  checkCodexApprovals();
  checkCodexHome();
  checkGeminiHooksToggle();
  checkPluginRegistration();
  checkPluginManifest();
  checkPluginEntries();
  checkStalePluginRoots();

  const dataDir = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');
  checkMigrations(dataDir);

  for (const c of checks) {
    console.log(`  ${statusIcon(c.status)} ${c.name.padEnd(22)} ${c.detail}`);
    if (c.remedy && c.status !== 'PASS') console.log(`      \x1b[2m→ ${c.remedy}\x1b[0m`);
  }

  const fails = checks.filter(c => c.status === 'FAIL').length;
  const warns = checks.filter(c => c.status === 'WARN').length;
  console.log();
  if (fails === 0 && warns === 0) {
    console.log('  \x1b[32mAll systems healthy. Restart Claude Code sessions to use new hooks.\x1b[0m');
  } else {
    console.log(`  ${fails} fail${fails === 1 ? '' : 's'}, ${warns} warn${warns === 1 ? '' : 's'} — see remediation hints above.`);
  }
  return fails > 0 ? 1 : 0;
}
