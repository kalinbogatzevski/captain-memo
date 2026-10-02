// The Windows ssh.exe (see fake-ssh.ts). Its mode is in fake-ssh.json beside it: "fail" | "run-locally" | { prints }.
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const how = JSON.parse(readFileSync(join(dirname(process.execPath), 'fake-ssh.json'), 'utf-8')) as 'fail' | 'run-locally' | { prints: string };
if (how === 'fail') process.exit(255);
if (typeof how === 'object') { process.stdout.write(how.prints + '\n'); process.exit(0); }

// `ssh [opts] host cmd`: options (some with a value), then the host, then the command words.
const args = process.argv.slice(2);
while (args[0]?.startsWith('-')) args.splice(0, ['-o', '-p', '-i', '-J', '-F', '-l'].includes(args[0]) ? 2 : 1);
args.shift();
if (process.env.FAKE_SSH_FAIL) process.exit(255);
// Git's own bash: a bare `bash` on a Windows PATH is often the WSL launcher stub. `git --exec-path` is <git>/mingw64/libexec/git-core.
const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf-8' }).stdout.trim();
const r = spawnSync(resolve(exec, '..', '..', '..', 'bin', 'bash.exe'), ['-c', args.join(' ')], { encoding: 'utf-8' });
process.stdout.write(r.stdout ?? '');
process.stderr.write(r.stderr ?? '');
process.exit(r.status ?? 255);
