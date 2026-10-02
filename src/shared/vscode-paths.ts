// VS Code's USER folder per OS: where `mcp.json` (default profile) and `prompts/` live. Windows %APPDATA%\Code\User, macOS
// ~/Library/Application Support/Code/User, Linux ~/.config/Code/User (VS Code docs, "User Settings" file locations). Only
// the Linux path has been seen on a real machine here. Segments are relative to the home directory, derived from it and not
// from %APPDATA%, so a test home stays hermetic. No imports: skill-refresh.ts (hook bundle) shares it with cross-ai.ts.
import { join } from 'path';

export type VscodeOs = 'win32' | 'darwin' | 'linux';
export const VSCODE_OSES: readonly VscodeOs[] = ['win32', 'darwin', 'linux'];

export function vscodeUserDirSegments(os: VscodeOs): string[] {
  if (os === 'win32') return ['AppData', 'Roaming', 'Code', 'User'];
  if (os === 'darwin') return ['Library', 'Application Support', 'Code', 'User'];
  return ['.config', 'Code', 'User'];
}

export function vscodeUserDirFor(os: VscodeOs, home: string): string {
  return join(home, ...vscodeUserDirSegments(os));
}
