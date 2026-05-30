@echo off
REM Windows CLI shim for captain-memo. Invokes Bun directly on the TypeScript
REM entry point so there is no dependency on shebang dispatch (which cmd/PowerShell
REM cannot honor). %~dp0 is this file's directory (…\bin\); the source sits one
REM level up. Quotes guard against spaces in the install path. Requires bun on PATH.
bun "%~dp0..\src\cli\index.ts" %*
