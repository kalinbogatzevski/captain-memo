@echo off
REM Windows CLI shim for captain-memo, for running FROM THE CHECKOUT (bin\captain-memo <cmd>). Invokes Bun
REM directly on the TypeScript entry point (no shebang dispatch on Windows). %~dp0 is this file's directory
REM (...\bin\); the source sits one level up. NOT the file the installer puts on PATH: that one is written by
REM `captain-memo install` with the checkout's absolute path (a copy of this file would point at nothing).
REM Quotes guard against spaces in the install path. Requires bun on PATH.
bun "%~dp0..\src\cli\index.ts" %*
