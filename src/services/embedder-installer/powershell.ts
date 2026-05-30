// src/services/embedder-installer/powershell.ts — Windows local-sidecar installer.
//
// Wraps scripts/install-embedder.ps1: build the Python venv, install requirements,
// pre-download the model. NO systemd / no Scheduled Task here — the ServiceManager
// (windows-scheduled-task.ts) registers the embed task separately. install() drives
// the .ps1 through pwsh (preferred) or powershell; remove() deletes the venv dir.
//
// buildVenvCommands() is the pure, unit-testable core: given the install opts it
// returns the ordered PowerShell commands the .ps1 runs — derived purely from the
// Windows venv layout (<venv>\Scripts\, NOT bin/) so the test suite can assert the
// Scripts\ layout and the model id without spawning a shell.
import { existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import type { EmbedderInstaller, EmbedderInstallOpts } from './types.ts';

// scripts/ sits at the repo root, two levels up from src/services/embedder-installer/.
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/install-embedder.ps1');

/** Windows-only path join (backslash) so the helper produces the exact strings a
 *  PowerShell host would use, regardless of the OS the unit test runs on. */
function winJoin(...parts: string[]): string {
  return parts.join('\\');
}

/**
 * Ordered PowerShell commands the .ps1 executes to build the sidecar venv.
 * Pure — no I/O, no spawning — so it can be asserted on Linux CI.
 *
 * Mirrors scripts/install-embedder.ps1 steps 2–4: create venv (py -3.11, then
 * fall back to python), upgrade pip, install requirements, pre-download the model.
 * Every executable reference uses the Windows venv layout <venv>\Scripts\ — NOT
 * the POSIX bin/ — which is the whole point of the Windows port.
 */
export function buildVenvCommands(opts: EmbedderInstallOpts): string[] {
  const venvDir = winJoin(opts.installDir, 'venv');
  const venvPython = winJoin(venvDir, 'Scripts', 'python.exe');
  const requirements = winJoin(opts.installDir, 'requirements.txt');
  const modelsDir = winJoin(opts.installDir, 'models');
  return [
    // create venv: prefer the py launcher pinned to 3.11, else plain python.
    `py -3.11 -m venv "${venvDir}"`,
    `python -m venv "${venvDir}"`,
    // python deps via the venv's own interpreter (Scripts\python.exe -m pip).
    `& "${venvPython}" -m pip install --upgrade pip --quiet`,
    `& "${venvPython}" -m pip install -r "${requirements}" --quiet`,
    // pre-download the model into <installDir>\models via HF_HOME.
    `$env:HF_HOME = "${modelsDir}"`,
    `& "${venvPython}" -c "import os; from sentence_transformers import SentenceTransformer; SentenceTransformer('${opts.model}', device='cpu', trust_remote_code=True)"`,
  ];
}

/** First of pwsh / powershell that exists on PATH (pwsh = PowerShell 7+, preferred). */
function powershellExe(): string {
  const bunWhich = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
  for (const exe of ['pwsh', 'powershell']) {
    if (bunWhich?.(exe)) return exe;
  }
  // Fall back to the modern name; spawnSync surfaces ENOENT if it's truly absent.
  return 'pwsh';
}

export class PowershellEmbedderInstaller implements EmbedderInstaller {
  async install(opts: EmbedderInstallOpts): Promise<void> {
    if (!existsSync(SCRIPT)) throw new Error(`missing ${SCRIPT}`);
    // argv array (never string concat) so an install dir with spaces survives the
    // pwsh hop. -File takes the script path as a single arg; named params follow.
    const args = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-InstallDir', opts.installDir,
      '-Model', opts.model,
      '-Port', String(opts.port),
    ];
    const r = spawnSync(powershellExe(), args, { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('embedder install failed; see output above');
  }

  async remove(installDir: string): Promise<void> {
    rmSync(installDir, { recursive: true, force: true });
  }
}
