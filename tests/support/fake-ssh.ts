// A stand-in `ssh` for the tests that exercise the deploy guard end to end. No host is ever contacted: the stub either fails,
// prints a canned answer, or runs the remote command locally (so `md5sum <file>` hashes a file in a temp "server" folder).
// POSIX: a shell script named `ssh`. Windows: a real ssh.exe, compiled once per machine from fake-ssh-run.ts with `bun build
// --compile` (a .cmd cannot do it: Bun refuses to pass `;` or `&&` in an argument to a .cmd) and hardlinked into each stub folder,
// where it reads its mode from fake-ssh.json. Its folder must be first on PATH so it wins over System32\OpenSSH\ssh.exe.
import { writeFileSync, chmodSync, existsSync, mkdirSync, renameSync, linkSync, copyFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

export type FakeSsh = 'run-locally' | 'fail' | { prints: string };

// ssh [opts] host cmd: drop the options and the host, run the command locally. FAKE_SSH_FAIL=1 makes it fail like a dead host.
const RUN_LOCALLY_SH = '#!/bin/bash\nwhile [[ "$1" == -* ]]; do case "$1" in -o|-p|-i|-J|-F|-l) shift 2;; *) shift;; esac; done\nshift\n[ -n "$FAKE_SSH_FAIL" ] && exit 255\nexec bash -c "$*"\n';

const RUNNER = join(import.meta.dir, 'fake-ssh-run.ts');

function windowsExe(): string {
  const cache = join(tmpdir(), `cm-fake-ssh-${createHash('sha1').update(readFileSync(RUNNER)).digest('hex').slice(0, 10)}`);
  const exe = join(cache, 'ssh.exe');
  if (!existsSync(exe)) {
    mkdirSync(cache, { recursive: true });
    const building = join(cache, `build-${process.pid}.exe`);
    const r = spawnSync(process.execPath, ['build', '--compile', RUNNER, '--outfile', building], { encoding: 'utf-8' });
    if (r.status !== 0 || !existsSync(building)) throw new Error(`could not build the fake ssh.exe: ${r.stderr || r.stdout}`);
    try { renameSync(building, exe); } catch { /* another process built it first */ }
  }
  return exe;
}

export function installFakeSsh(dir: string, how: FakeSsh): void {
  if (process.platform === 'win32') {
    const dest = join(dir, 'ssh.exe');
    try { linkSync(windowsExe(), dest); } catch { copyFileSync(windowsExe(), dest); }
    writeFileSync(join(dir, 'fake-ssh.json'), JSON.stringify(how));
    return;
  }
  const body = how === 'fail' ? '#!/bin/sh\nexit 255\n' : how === 'run-locally' ? RUN_LOCALLY_SH : `#!/bin/sh\necho "${how.prints}"\n`;
  writeFileSync(join(dir, 'ssh'), body);
  chmodSync(join(dir, 'ssh'), 0o755);
}
