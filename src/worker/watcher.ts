import chokidar, { type FSWatcher } from 'chokidar';
import { dirname, basename, extname } from 'path';

export type WatcherEvent = 'add' | 'change' | 'unlink';

export interface FileWatcherOptions {
  paths: string[];
  debounceMs?: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onEvent: (type: WatcherEvent, path: string) => any;
}

interface WatchTarget {
  dir: string;
  extFilter: string | null; // e.g. '.md', or null = watch all
}

/**
 * Resolve a list of paths (which may include glob-like patterns such as
 * `/some/dir/*.md`) into { dir, extFilter } watch targets.
 *
 * Note: chokidar v4 removed glob support, so we watch the parent directory
 * and filter events by extension ourselves.
 */
function resolveTargets(paths: string[]): WatchTarget[] {
  return paths.map(p => {
    const base = basename(p);
    if (base.startsWith('*')) {
      // e.g. "*.md" → extFilter = '.md', or "*" → no filter
      const ext = base.replace(/^\*/, ''); // "*.md" → ".md", "*" → ""
      return { dir: dirname(p), extFilter: ext || null };
    }
    // Exact file path — watch its directory, filter to that exact file
    return { dir: dirname(p), extFilter: extname(p) || null };
  });
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

    // Build combined extension filter (null = no filter = watch all)
    const extFilters = targets
      .map(t => t.extFilter)
      .filter((e): e is string => e !== null);
    const hasFilter = extFilters.length > 0;
    const matchesFilter = (p: string) =>
      !hasFilter || extFilters.some(ext => p.endsWith(ext));

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
