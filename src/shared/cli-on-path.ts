// src/shared/cli-on-path.ts — "is this CLI installed?" for the summarizer chain, on every OS.
//
// The old probe was `Bun.spawn(['which', bin])` with a non-zero exit or a thrown spawn as "not on PATH".
// Windows has no `which`, so the spawn itself threw and EVERY CLI provider (claude-code, codex, agy) was
// reported "not on PATH" there, whatever was installed or logged in — reproduced 2026-09-16 on a Windows
// captain: `which codex` → "Executable not found in $PATH: which", while Bun.which('codex') resolved
// %APPDATA%\npm\codex.cmd. Bun.which honours PATHEXT (.cmd/.exe) on Windows and plain PATH elsewhere,
// needs no subprocess, and returns the resolved path — which the transport then spawns exactly, instead
// of re-resolving a bare name.
export function cliOnPath(bin: string): string | null {
  try { return Bun.which(bin); } catch { return null; }
}
