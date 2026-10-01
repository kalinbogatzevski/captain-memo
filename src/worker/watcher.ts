import chokidar, { type FSWatcher } from 'chokidar';
import { dirname, join } from 'path';

export type WatcherEvent = 'add' | 'change' | 'unlink';

export interface FileWatcherOptions {
  paths: string[];
  debounceMs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (type: WatcherEvent, path: string) => any;
}

interface WatchTarget {
  dir: string;
}

/**
 * Resolve a list of paths (which may include glob-like patterns such as
 * `/some/dir/*.md` or `~/.claude/projects/* /memory/*.md`) into concrete
 * { dir } watch targets.
 *
 * chokidar v4 removed glob support, so we expand `*` segments at start time
 * via Bun.Glob, then watch each concrete leaf dir directly. Caveat: dirs
 * created AFTER startup are not watched until the worker restarts.
 */
function resolveTargets(paths: string[]): WatchTarget[] {
  const targets: WatchTarget[] = [];
  for (const rawPath of paths) {
    // Bun.Glob patterns use forward slashes on every platform. `path.join()`
    // produces backslashes on Windows, and leaving them intact makes both the
    // wildcard-segment scan and Bun.Glob parse the pattern incorrectly.
    const p = process.platform === 'win32' ? rawPath.replace(/\\/g, '/') : rawPath;
    const dir = dirname(p);

    // If only the basename has a glob (e.g., "/some/dir/*.md"), the dirname is
    // already concrete — watch it directly. New files matching the pattern
    // will fire on chokidar's `add` event even if the dir was empty at start.
    if (!dir.includes('*')) {
      targets.push({ dir });
      continue;
    }

    // Otherwise (e.g., "~/.claude/projects/* /memory/*.md"), find the longest
    // non-glob ancestor as the scan root, then ask Bun.Glob to enumerate
    // matches under it. The matches' dirnames are the concrete directories
    // we hand to chokidar.
    const segments = p.split('/');
    const rootSegments: string[] = [];
    const patternSegments: string[] = [];
    for (const seg of segments) {
      if (patternSegments.length > 0 || seg.includes('*')) {
        patternSegments.push(seg);
      } else {
        rootSegments.push(seg);
      }
    }
    const root = rootSegments.join('/') || '/';
    const pattern = patternSegments.join('/');

    const dirs = new Set<string>();
    try {
      const glob = new Bun.Glob(pattern);
      // dot:true — see expandWatchPaths: hidden dirs (.claude/, .github/, .cursor/)
      // hold repo-level memory, and dot:false makes the watcher blind to them.
      for (const rel of glob.scanSync({ cwd: root, dot: true })) {
        dirs.add(dirname(join(root, rel)));
      }
    } catch (err) {
      console.error(`[FileWatcher] glob expansion failed for ${rawPath}:`, err);
      continue;
    }

    if (dirs.size === 0) {
      console.error(
        `[FileWatcher] glob ${rawPath} matched no files at startup — ` +
        `nothing to watch yet (will need a worker restart once files exist)`,
      );
      continue;
    }

    for (const d of dirs) targets.push({ dir: d });
  }
  return targets;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private opts: FileWatcherOptions;

  constructor(opts: FileWatcherOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const debounceMs = this.opts.debounceMs ?? 500;
    const targets = resolveTargets(this.opts.paths);

    // Deduplicate dirs
    const dirs = [...new Set(targets.map(t => t.dir))];

    // An event is ours only when one of the configured patterns matches the file itself. The directories
    // above are watched whole, and the old filter pooled every pattern's extension: `AGENTS*.md` gave none,
    // so a host with only such patterns indexed every file in ~/.codex (logs_2.sqlite-wal, models_cache.json).
    const globs = this.opts.paths.map(p => new Bun.Glob(p.replace(/\\/g, '/')));
    const matchesFilter = (p: string) => {
      const file = p.replace(/\\/g, '/');
      return globs.some(g => g.match(file));
    };

    this.watcher = chokidar.watch(dirs, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: debounceMs,
        pollInterval: 50,
      },
      persistent: true,
      depth: 0,
    });

    this.watcher.on('add', path => {
      if (matchesFilter(path)) this.dispatch('add', path);
    });
    this.watcher.on('change', path => {
      if (matchesFilter(path)) this.dispatch('change', path);
    });
    this.watcher.on('unlink', path => {
      if (matchesFilter(path)) this.dispatch('unlink', path);
    });

    // Wait for ready
    await new Promise<void>(resolve => {
      this.watcher!.once('ready', () => resolve());
    });
  }

  private async dispatch(type: WatcherEvent, path: string): Promise<void> {
    try {
      await this.opts.onEvent(type, path);
    } catch (err) {
      console.error(`[FileWatcher] handler error for ${type} ${path}:`, err);
    }
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
