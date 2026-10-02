// What the Windows ssh.cmd runs (see fake-ssh.ts): argv = --fake=<fail|run> | --fake-prints=<text>, then the ssh arguments.
import { spawnSync } from 'child_process';
import { resolve } from 'path';

const args = process.argv.slice(2);
const mode = args.shift() ?? '';
if (mode === '--fake=fail') process.exit(255);
if (mode.startsWith('--fake-prints=')) { process.stdout.write(mode.slice('--fake-prints='.length) + '\n'); process.exit(0); }

// `ssh [opts] host cmd`: options (some with a value), then the host, then the command words.
while (args[0]?.startsWith('-')) args.splice(0, ['-o', '-p', '-i', '-J', '-F', '-l'].includes(args[0]) ? 2 : 1);
args.shift();
if (process.env.FAKE_SSH_FAIL) process.exit(255);
// Git's own bash: a bare `bash` on a Windows PATH is often the WSL launcher stub. `git --exec-path` is <git>/mingw64/libexec/git-core.
const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf-8' }).stdout.trim();
const r = spawnSync(resolve(exec, '..', '..', '..', 'bin', 'bash.exe'), ['-c', args.join(' ')], { encoding: 'utf-8' });
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
process.exit(r.status ?? 255);
