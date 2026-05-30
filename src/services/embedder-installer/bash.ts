// src/services/embedder-installer/bash.ts — Linux/POSIX local-sidecar installer.
//
// Thin wrapper around the existing scripts/install-embedder.sh. Preserves the
// behavior the install wizard's installEmbedder() has today: `bash <script>
// --user`, stdio inherited so the user sees pip's progress, fail loudly on a
// non-zero exit. The script itself owns the venv + systemd unit + health probe;
// this module only locates and drives it.
import { existsSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import type { EmbedderInstaller, EmbedderInstallOpts } from './types.ts';

// scripts/ sits at the repo root, two levels up from src/services/embedder-installer/.
const REPO_ROOT = resolve(import.meta.dir, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/install-embedder.sh');

export class BashEmbedderInstaller implements EmbedderInstaller {
  // opts is unused: install-embedder.sh bakes model/port/installDir itself today
  // (default --user mode → ~/.captain-memo/embed). Kept in the signature so this
  // impl is interface-identical to the PowerShell one and a future script can read it.
  async install(_opts: EmbedderInstallOpts): Promise<void> {
    if (!existsSync(SCRIPT)) throw new Error(`missing ${SCRIPT}`);
    // argv array (never string concat) so a repo path with spaces survives.
    const r = spawnSync('bash', [SCRIPT, '--user'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('embedder install failed; see output above');
  }

  async remove(installDir: string): Promise<void> {
    rmSync(installDir, { recursive: true, force: true });
  }
}
