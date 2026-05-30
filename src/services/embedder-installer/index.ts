// src/services/embedder-installer/index.ts — factory.
//
// Picks the local-sidecar installer for the current OS: PowerShell on Windows
// (wraps install-embedder.ps1), bash everywhere else (wraps install-embedder.sh).
// Callers (the install wizard, only on the `local-sidecar` embedder choice) talk
// to the EmbedderInstaller interface and never branch on platform themselves.
import { isWindows } from '../../shared/platform.ts';
import type { EmbedderInstaller } from './types.ts';
import { BashEmbedderInstaller } from './bash.ts';
import { PowershellEmbedderInstaller } from './powershell.ts';

export type { EmbedderInstaller, EmbedderInstallOpts } from './types.ts';

export function getEmbedderInstaller(): EmbedderInstaller {
  return isWindows ? new PowershellEmbedderInstaller() : new BashEmbedderInstaller();
}
