import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

/** REAL git, no network and no service manager: a clone one release behind a local bare origin's tag `v99.0.0`, with a local
 *  edit, so the opt-in auto-update finds the release and its dirty-tree gate refuses it before anything is applied. `env`
 *  (GIT_DIR / GIT_WORK_TREE) aims the hook's git at the fixture; without it the hook's own `git rev-parse --show-toplevel`
 *  would resolve to THIS checkout. */
export function makeDirtyCloneBehindOrigin(root: string): { env: Record<string, string>; head: string; git: (cwd: string, ...args: string[]) => string } {
  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync(['git', '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  mkdirSync(origin); mkdirSync(work);
  git(origin, 'init', '--bare', '-b', 'main');
  git(work, 'init', '-b', 'main');
  writeFileSync(join(work, 'package.json'), '{"name":"captain-memo","version":"0.0.1"}\n');
  git(work, 'add', 'package.json'); git(work, 'commit', '-m', 'one');
  git(work, 'remote', 'add', 'origin', origin);
  writeFileSync(join(work, 'package.json'), '{"name":"captain-memo","version":"99.0.0"}\n');
  git(work, 'commit', '-am', 'two'); git(work, 'tag', 'v99.0.0');
  git(work, 'push', 'origin', 'main', 'v99.0.0');
  git(work, 'reset', '--hard', 'HEAD~1');                                              // the clone is one release behind origin's tag
  writeFileSync(join(work, 'package.json'), '{"name":"captain-memo","version":"0.0.1"} \n');   // ...and has a local edit
  return { env: { GIT_DIR: join(work, '.git'), GIT_WORK_TREE: work }, head: git(work, 'rev-parse', 'HEAD'), git };
}
