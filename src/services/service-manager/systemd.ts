// src/services/service-manager/systemd.ts — Linux ServiceManager over systemctl.
//
// Mirrors the pre-existing inline `systemctl` behavior that lived in
// install/uninstall/upgrade/vacuum/doctor: default to the rootless user manager
// (`systemctl --user`) and fall back to system scope (`systemctl …`) when there
// is no user manager — exactly the user→system fallback in
// src/cli/commands/doctor.ts (svcActive/svcExists/svcMode). install() renders the
// `.user.service` template (the rootless default the wizard uses), substituting
// __INSTALL_DIR__/__ENV_FILE__/__BUN__ from the ServiceSpec, writes it to
// ~/.config/systemd/user/<name>.service, then daemon-reload → enable → restart.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import type { ServiceManager, ServiceSpec, ServiceState, StopOptions } from './types.ts';
import { DEFAULT_WORKER_PORT } from '../../shared/paths.ts';

// Repo root — three levels up from src/services/service-manager/.
const REPO_ROOT = resolve(import.meta.dir, '../../..');

// Where rootless user units live.
const USER_SYSTEMD_DIR = join(homedir(), '.config/systemd/user');

// Canonical unit ids the rest of the codebase uses (doctor/uninstall expect the
// `.service` suffix). The ServiceSpec.name is the bare id ('captain-memo-worker'),
// so normalize before handing anything to systemctl.
function unitName(name: string): string {
  return name.endsWith('.service') ? name : `${name}.service`;
}

// The unit template to render for a given service id. Worker and embedder ship
// distinct user-scope templates under services/<x>/systemd/.
function templateFor(name: string): string {
  const bare = name.replace(/\.service$/, '');
  if (bare === 'captain-memo-embed') {
    return join(REPO_ROOT, 'services/embed/systemd/captain-memo-embed.user.service');
  }
  return join(REPO_ROOT, 'services/worker/systemd/captain-memo-worker.user.service');
}

// Run `systemctl --user <args>`; if the user manager is absent (no $XDG bus /
// "Failed to connect to bus"), retry in system scope. Mirrors doctor.ts's
// two-probe pattern. Returns the spawn result of whichever scope answered.
function systemctl(args: string[]): ReturnType<typeof spawnSync> {
  const userR = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf-8', timeout: 10_000 });
  // exit 0 → user manager handled it. A user manager that simply reports the
  // unit inactive/missing still exits non-zero but DID answer; only a missing
  // bus warrants the system-scope fallback.
  if (userR.status === 0) return userR;
  const stderr = (userR.stderr ?? '') as string;
  const noUserManager = userR.error != null
    || /Failed to connect to (the )?bus/i.test(stderr)
    || /No medium found/i.test(stderr);
  if (!noUserManager) return userR;
  return spawnSync('systemctl', [...args], { encoding: 'utf-8', timeout: 10_000 });
}

class SystemdServiceManager implements ServiceManager {
  async install(spec: ServiceSpec): Promise<void> {
    const tpl = templateFor(spec.name);
    if (!existsSync(tpl)) throw new Error(`missing systemd unit template: ${tpl}`);
    const bun = spec.exec[0] ?? 'bun';
    const unit = readFileSync(tpl, 'utf-8')
      .replaceAll('__INSTALL_DIR__', spec.workingDir)
      .replaceAll('__ENV_FILE__', spec.envFile ?? '')
      .replaceAll('__BUN__', bun);
    if (!existsSync(USER_SYSTEMD_DIR)) mkdirSync(USER_SYSTEMD_DIR, { recursive: true });
    writeFileSync(join(USER_SYSTEMD_DIR, unitName(spec.name)), unit, { mode: 0o644 });
    // daemon-reload → enable (autostart) → restart (idempotent start). Mirrors
    // installWorkerService() in install.ts.
    systemctl(['daemon-reload']);
    if (spec.autostart) systemctl(['enable', unitName(spec.name)]);
    systemctl(['restart', unitName(spec.name)]);
  }

  async remove(name: string): Promise<void> {
    // stop + disable + delete unit file + daemon-reload. Mirrors uninstall.ts.
    systemctl(['stop', unitName(name)]);
    systemctl(['disable', unitName(name)]);
    const unitPath = join(USER_SYSTEMD_DIR, unitName(name));
    if (existsSync(unitPath)) rmSync(unitPath, { force: true });
    systemctl(['daemon-reload']);
  }

  async start(name: string): Promise<void> {
    const r = systemctl(['start', unitName(name)]);
    // Surface the failure (masked unit, bad unit file, polkit denial, systemctl
    // missing → spawn error, wedged bus → timeout). The self-heal orchestrator is
    // built around start() THROWING on failure: swallowing the exit code here would
    // make its `failed` branch dead and drop systemctl's actionable stderr.
    if (r.status !== 0) {
      throw new Error(
        `systemctl start ${unitName(name)} failed (status ${r.status ?? '?'}): ` +
        `${((r.stderr ?? '') as string).trim() || r.error?.message || 'no stderr'}`,
      );
    }
  }

  async restart(name: string, _opts?: StopOptions): Promise<void> {
    // ONE systemctl job owns stop->start; if the calling hook dies (or spawnSync times out),
    // systemd still completes BOTH phases, so the worker can never be left stopped.
    const r = systemctl(['restart', unitName(name)]);
    if (r.status !== 0) {
      throw new Error(
        `systemctl restart ${unitName(name)} failed (status ${r.status ?? '?'}): ` +
        `${((r.stderr ?? '') as string).trim() || r.error?.message || 'no stderr'}`,
      );
    }
  }

  async stop(name: string, opts?: StopOptions): Promise<void> {
    // StopOptions.force is intentionally a no-op here: `systemctl stop` already
    // guarantees the process is gone (SIGTERM → SIGKILL on timeout). force exists
    // for the Windows impl, where Stop-ScheduledTask does NOT reliably kill a
    // detached/zombie worker; it stays in the shared interface for symmetry.
    if (opts?.graceful) {
      // Ask the worker to drain + release SQLite locks before we yank it.
      // Best-effort — a worker that's already down just refuses the connection.
      // Bounded so a half-open socket can't wedge the heal path's in-process budget.
      const port = opts.port ?? DEFAULT_WORKER_PORT;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 3_000);
      try {
        await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', signal: ctl.signal });
      } catch {
        // ignore — fall through to systemctl stop
      } finally {
        clearTimeout(t);
      }
    }
    const r = systemctl(['stop', unitName(name)]);
    if (r.status !== 0) {
      throw new Error(
        `systemctl stop ${unitName(name)} failed (status ${r.status ?? '?'}): ` +
        `${((r.stderr ?? '') as string).trim() || r.error?.message || 'no stderr'}`,
      );
    }
  }

  async status(name: string): Promise<ServiceState> {
    if (await this.isActive(name)) return 'running';
    // Distinguish "installed but stopped/failed" from "never installed".
    const lu = systemctl(['list-unit-files', unitName(name)]);
    const installed = ((lu.stdout ?? '') as string).includes(unitName(name));
    if (!installed) return 'not-installed';
    // `is-failed` returns 0 (and prints 'failed') when the unit is in a failed state.
    const failed = systemctl(['is-failed', unitName(name)]);
    if (((failed.stdout ?? '') as string).trim() === 'failed') return 'failed';
    return 'stopped';
  }

  async isActive(name: string): Promise<boolean> {
    const r = systemctl(['is-active', unitName(name)]);
    return ((r.stdout ?? '') as string).trim() === 'active';
  }

  async enable(name: string): Promise<void> {
    systemctl(['enable', unitName(name)]);
  }

  async disable(name: string): Promise<void> {
    systemctl(['disable', unitName(name)]);
  }
}

export function createSystemdServiceManager(): ServiceManager {
  return new SystemdServiceManager();
}
