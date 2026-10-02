// A stand-in `ssh` for the tests that exercise the deploy guard end to end. No host is ever contacted: the stub either fails,
// prints a canned answer, or runs the remote command locally (so `md5sum <file>` hashes a file in a temp "server" folder).
// POSIX: a shell script named `ssh`. Windows: `ssh.cmd` (Bun's spawn resolves it through PATHEXT, ahead of System32\OpenSSH\ssh.exe
// when its folder is first on PATH) that runs fake-ssh-run.ts, so output is LF-only and nothing depends on cmd.exe quoting.
import { writeFileSync, chmodSync } from 'fs';
import { join } from 'path';

export type FakeSsh = 'run-locally' | 'fail' | { prints: string };

// ssh [opts] host cmd: drop the options and the host, run the command locally. FAKE_SSH_FAIL=1 makes it fail like a dead host.
const RUN_LOCALLY_SH = '#!/bin/bash\nwhile [[ "$1" == -* ]]; do case "$1" in -o|-p|-i|-J|-F|-l) shift 2;; *) shift;; esac; done\nshift\n[ -n "$FAKE_SSH_FAIL" ] && exit 255\nexec bash -c "$*"\n';

export function installFakeSsh(dir: string, how: FakeSsh): void {
  if (process.platform === 'win32') {
    const mode = how === 'fail' ? '--fake=fail' : how === 'run-locally' ? '--fake=run' : `"--fake-prints=${how.prints}"`;
    writeFileSync(join(dir, 'ssh.cmd'), `@echo off\r\n"${process.execPath}" "${join(import.meta.dir, 'fake-ssh-run.ts')}" ${mode} %*\r\n`);
    return;
  }
  const body = how === 'fail' ? '#!/bin/sh\nexit 255\n' : how === 'run-locally' ? RUN_LOCALLY_SH : `#!/bin/sh\necho "${how.prints}"\n`;
  writeFileSync(join(dir, 'ssh'), body);
  chmodSync(join(dir, 'ssh'), 0o755);
}
