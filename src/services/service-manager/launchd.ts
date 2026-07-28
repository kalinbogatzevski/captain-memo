// src/services/service-manager/launchd.ts — macOS ServiceManager over launchd.
//
// The third impl behind the ServiceManager interface, alongside systemd (Linux) and
// Scheduled Tasks (Windows). Per-USER agents only: the plist lands in
// ~/Library/LaunchAgents and every launchctl call is scoped to the caller's GUI domain
// (gui/<uid>), so nothing here needs root — matching the rootless `systemctl --user`
// default the wizard uses on Linux.
//
// launchctl's modern verbs are used throughout (bootstrap/bootout/kickstart, macOS
// 10.11+) rather than the deprecated load/unload. The old verbs still work but silently
// no-op in cases the new ones report honestly, and honest reporting is the entire point
// of this file existing: the previous macOS behaviour was an installer that printed
// "worker service enabled + started" after three failed `systemctl` calls.
//
// Mapping to the interface, and where launchd differs from systemd:
//
//   stop()     -> bootout, NOT `launchctl stop`. With KeepAlive set, `stop` is undone by
//                 launchd within seconds; bootout unloads the job so it stays down. The
//                 cost is that start() must bootstrap again, which it does.
//   restart()  -> kickstart -k, one atomic job (kill + relaunch), so a caller dying
//                 mid-way cannot strand the worker stopped. Same guarantee the systemd
//                 impl gets from `systemctl restart`.
//   status()   -> `launchctl print` state, with `list` as the loaded/not-loaded probe.
//   enable()   -> `launchctl enable`, which persists across logins in launchd's own
//                 disabled-services store; it does NOT load the job (bootstrap does).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import type { ServiceManager, ServiceSpec, ServiceState, StopOptions } from './types.ts';
import { DEFAULT_WORKER_PORT, LOGS_DIR } from '../../shared/paths.ts';

const REPO_ROOT = resolve(import.meta.dir, '../../..');

/** Where per-user LaunchAgents live. Created on demand — a fresh account has no such dir. */
const LAUNCH_AGENTS_DIR = join(homedir(), 'Library/LaunchAgents');

/** launchd logs are plain files (there is no journal), so the daemon needs somewhere to
 *  write. Deliberately LOGS_DIR (~/.captain-memo/logs) rather than the macOS-conventional
 *  ~/Library/Logs: every message in this codebase — including `top`'s own "WORKER
 *  UNREACHABLE — see ~/.captain-memo/logs/worker.log" — names that path. A second,
 *  platform-idiomatic location just sends people to a file that does not exist, which is
 *  exactly what happened to the first macOS user 2026-07-28. One log dir, one message. */
const DEFAULT_LOG_DIR = LOGS_DIR;

/** Bare service id, with any systemd-style `.service` suffix stripped. Callers pass
 *  'captain-memo-worker' or 'captain-memo-worker.service' interchangeably because the
 *  Linux impl accepts both; normalise so a plist is never named `foo.service.plist`. */
export function bareName(name: string): string {
  return name.replace(/\.service$/, '');
}

/** launchd Label. Reverse-DNS is the convention and it keeps our jobs from colliding
 *  with anything else in the user's domain. The bare id rides at the end so
 *  `launchctl list | grep captain-memo` still finds it. */
export function labelFor(name: string): string {
  return `com.captainmemo.${bareName(name).replace(/^captain-memo-/, '')}`;
}

function plistPath(name: string): string {
  return join(LAUNCH_AGENTS_DIR, `${labelFor(name)}.plist`);
}

/** The GUI domain target for the CURRENT user: `gui/501/com.captainmemo.worker`. */
function domainTarget(name?: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  return name ? `gui/${uid}/${labelFor(name)}` : `gui/${uid}`;
}

function templateFor(name: string): string {
  const bare = bareName(name);
  if (bare === 'captain-memo-embed') {
    return join(REPO_ROOT, 'services/embed/launchd/captain-memo-embed.plist');
  }
  return join(REPO_ROOT, 'services/worker/launchd/captain-memo-worker.plist');
}

/** XML-escape a value destined for a <string> node. A path with & or < in it is rare but
 *  a malformed plist fails in a way that is very hard to read, so escape unconditionally. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render ProgramArguments from an argv. launchd takes an ARRAY — it does not parse a
 *  shell string — so each element becomes its own <string> and no quoting is needed. */
export function programArgsXml(argv: readonly string[], indent = '    '): string {
  return argv.map(a => `${indent}<string>${xmlEscape(a)}</string>`).join('\n');
}

/** Fill the plist template from a spec. Exported for tests: rendering is the part that
 *  can silently produce an invalid file, and it needs no macOS to verify. */
export function renderPlist(spec: ServiceSpec, template: string): string {
  const logDir = spec.logDir || DEFAULT_LOG_DIR;
  return template
    .replaceAll('__LABEL__', xmlEscape(labelFor(spec.name)))
    .replaceAll('__PROGRAM_ARGS__', programArgsXml(spec.exec))
    .replaceAll('__INSTALL_DIR__', xmlEscape(spec.workingDir))
    .replaceAll('__LOG_DIR__', xmlEscape(logDir))
    .replaceAll('__NAME__', xmlEscape(bareName(spec.name)))
    .replaceAll('__RUN_AT_LOAD__', spec.autostart ? '<true/>' : '<false/>')
    .replaceAll('__KEEP_ALIVE__', spec.restartOnFailure ? '<true/>' : '<false/>');
}

interface Run { status: number | null; stdout: string; stderr: string; error?: Error | undefined; timedOut: boolean }

/** launchctl is not always fast. `kickstart` BLOCKS while the job is inside its
 *  ThrottleInterval (launchd refuses to respawn more than once per interval, floor 10s),
 *  and `print` on a busy GUI domain dumps a lot. A 10s cap was exactly the throttle
 *  window, so an ordinary wait surfaced as `spawnSync launchctl ETIMEDOUT` and aborted
 *  the install — reported from the field 2026-07-28. */
const LAUNCHCTL_TIMEOUT_MS = 90_000;

function launchctl(args: string[]): Run {
  const r = spawnSync('launchctl', args, { encoding: 'utf-8', timeout: LAUNCHCTL_TIMEOUT_MS });
  return {
    status: r.status,
    stdout: (r.stdout ?? '') as string,
    stderr: (r.stderr ?? '') as string,
    error: r.error,
    // spawnSync reports a timeout as an ETIMEDOUT error with a null status. Distinguish
    // it: a timeout means "no answer", NOT "the job failed", and the two need different
    // handling — see settled() below.
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  };
}

/** Fail loudly with launchctl's own words. The self-heal orchestrator is built around
 *  start()/stop()/restart() THROWING, and — more importantly — the installer must never
 *  again report success for a command that did not run. */
function must(r: Run, what: string): void {
  if (r.status === 0) return;
  const detail = r.stderr.trim() || r.stdout.trim() || r.error?.message || 'no output';
  throw new Error(`launchctl ${what} failed (status ${r.status ?? '?'}): ${detail}`);
}

/** Poll until the job reaches a terminal-ish state, or give up. Used after a call that
 *  TIMED OUT: launchd may still be mid-throttle, and the job frequently comes up a moment
 *  later. Asking the supervisor what actually happened beats trusting a stopwatch. */
async function settled(check: () => Promise<ServiceState>, ms = 20_000): Promise<ServiceState> {
  const deadline = Date.now() + ms;
  let last: ServiceState = 'stopped';
  for (;;) {
    last = await check();
    if (last === 'running' || Date.now() > deadline) return last;
    await new Promise(r => setTimeout(r, 1_000));
  }
}

class LaunchdServiceManager implements ServiceManager {
  async install(spec: ServiceSpec): Promise<void> {
    const tpl = templateFor(spec.name);
    if (!existsSync(tpl)) throw new Error(`missing launchd plist template: ${tpl}`);
    const plist = renderPlist(spec, readFileSync(tpl, 'utf-8'));

    if (!existsSync(LAUNCH_AGENTS_DIR)) mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    const logDir = spec.logDir || DEFAULT_LOG_DIR;
    // launchd does NOT create the parent of StandardOutPath; a missing directory makes
    // the job fail to spawn with a bare "Operation not permitted" that names no path.
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

    const path = plistPath(spec.name);
    writeFileSync(path, plist, { mode: 0o644 });

    // Replace any previous registration: bootstrap refuses with EALREADY (error 37) if
    // the label is already loaded, so bootout first and ignore its result — "not loaded"
    // is the normal case on a first install and is not an error.
    launchctl(['bootout', domainTarget(spec.name)]);
    must(launchctl(['bootstrap', domainTarget(), path]), `bootstrap ${path}`);
    if (spec.autostart) launchctl(['enable', domainTarget(spec.name)]);

    // NO kickstart here when RunAtLoad is set: bootstrap has already launched the job,
    // and a second launch inside ThrottleInterval makes launchd BLOCK rather than obey.
    // Stacking bootstrap + kickstart + a caller's restart() put three launches into one
    // 10s window and the third one timed out, aborting the whole install.
    if (!spec.autostart) {
      must(launchctl(['kickstart', domainTarget(spec.name)]), `kickstart ${domainTarget(spec.name)}`);
      return;
    }
    // Confirm the supervisor actually has it running, rather than assuming bootstrap
    // implies a live process. A plist that loads but whose program cannot exec (bad bun
    // path, unwritable log dir) reports exactly here instead of looking like success.
    const state = await settled(() => this.status(spec.name));
    if (state !== 'running') {
      throw new Error(
        `the LaunchAgent loaded but is not running (state: ${state}). `
        + `Inspect it with: launchctl print ${domainTarget(spec.name)}`
        + (spec.logDir ? `  ·  logs: ${spec.logDir}` : ''),
      );
    }
  }

  async remove(name: string): Promise<void> {
    launchctl(['bootout', domainTarget(name)]);   // best-effort: already-unloaded is fine
    const path = plistPath(name);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  async start(name: string): Promise<void> {
    // A job that was stopped via bootout is no longer in the domain, so kickstart alone
    // would fail with "No such process". Re-bootstrap from the plist when it is absent.
    if (!(await this.isLoaded(name))) {
      const path = plistPath(name);
      if (!existsSync(path)) throw new Error(`launchd plist not found: ${path} (run install first)`);
      must(launchctl(['bootstrap', domainTarget(), path]), `bootstrap ${path}`);
    }
    must(launchctl(['kickstart', domainTarget(name)]), `kickstart ${domainTarget(name)}`);
  }

  async restart(name: string, _opts?: StopOptions): Promise<void> {
    // -k kills the running instance and relaunches it as ONE launchctl job, so a caller
    // dying between the two phases cannot leave the worker stopped.
    if (!(await this.isLoaded(name))) return this.start(name);
    const r = launchctl(['kickstart', '-k', domainTarget(name)]);
    if (r.status === 0) return;
    // A timeout here usually means launchd is holding the request inside the job's
    // ThrottleInterval — the relaunch is pending, not refused. Ask what actually
    // happened before declaring failure.
    if (r.timedOut && (await settled(() => this.status(name))) === 'running') return;
    must(r, `kickstart -k ${domainTarget(name)}`);
  }

  async stop(name: string, opts?: StopOptions): Promise<void> {
    if (opts?.graceful) {
      // Let the worker drain and release its SQLite locks first. Best-effort and bounded,
      // exactly as the systemd impl does it.
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3_000);
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: ctl.signal });
      } catch {
        // already down, or refusing connections — fall through to bootout
      } finally {
        clearTimeout(t);
      }
    }
    // bootout, not `launchctl stop`: with KeepAlive set, stop is undone within seconds.
    // Unloading the job is the only way to make "stopped" mean stopped. StopOptions.force
    // needs no special handling — bootout terminates the process, it does not merely ask.
    if (!(await this.isLoaded(name))) return;   // already down: nothing to do, not an error
    must(launchctl(['bootout', domainTarget(name)]), `bootout ${labelFor(name)}`);
  }

  /** Is the job registered in the user's GUI domain (loaded), running or not? */
  private async isLoaded(name: string): Promise<boolean> {
    return launchctl(['print', domainTarget(name)]).status === 0;
  }

  async status(name: string): Promise<ServiceState> {
    const r = launchctl(['print', domainTarget(name)]);
    if (r.status !== 0) {
      // Not loaded. Distinguish "never installed" from "installed but unloaded" by the
      // plist on disk, so `stop` followed by `status` reads 'stopped' rather than
      // 'not-installed' — the same distinction the systemd impl draws via list-unit-files.
      return existsSync(plistPath(name)) ? 'stopped' : 'not-installed';
    }
    // `launchctl print` reports `state = running` for a live job. A job that is loaded
    // but not running shows its last exit status; a non-zero one is a failure, which is
    // what systemd would call 'failed'.
    if (/\bstate\s*=\s*running\b/.test(r.stdout)) return 'running';
    const m = r.stdout.match(/\blast exit (?:code|status)\s*=\s*(\d+)/);
    if (m && m[1] !== '0') return 'failed';
    return 'stopped';
  }

  async isActive(name: string): Promise<boolean> {
    return (await this.status(name)) === 'running';
  }

  async enable(name: string): Promise<void> {
    // Clears launchd's persistent disabled flag. Does NOT load the job — install/start do.
    launchctl(['enable', domainTarget(name)]);
  }

  async disable(name: string): Promise<void> {
    launchctl(['disable', domainTarget(name)]);
  }
}

export function createLaunchdServiceManager(): ServiceManager {
  return new LaunchdServiceManager();
}
