import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_GRACE_DAYS, describeSessionOf, parseInstalledPaths, planPrune, pluginRootFromEnviron, readCacheTrees,
  type CacheTree,
} from '../../src/shared/plugin-cache.ts';

const DAY = 86_400_000;
const NOW = 1_788_000_000_000;
const GRACE = DEFAULT_GRACE_DAYS * DAY;
const ROOT = '/home/u/.claude/plugins/cache/captain-memo/captain-memo';

function tree(version: string, orphanedDaysAgo: number | null): CacheTree {
  return {
    plugin: 'captain-memo',
    manifestName: 'captain-memo',
    version,
    path: `${ROOT}/${version}`,
    orphanedAtMs: orphanedDaysAgo === null ? null : NOW - orphanedDaysAgo * DAY,
  };
}

/** The whole point of the fixture: three superseded trees of different ages beside the active one, so
 *  every gate is exercised in ONE plan — which is what the live host cannot show (there, active + a
 *  same-day orphan means the correct plan deletes nothing). */
const TREES = [
  tree('0.49.0', null),   // active
  tree('0.20.0', 0),      // orphaned today
  tree('0.12.1', 9),      // orphaned past grace
  tree('0.11.0', 40),     // orphaned long past grace
];
const ACTIVE = new Set([`${ROOT}/0.49.0`]);

const run = (over: Partial<Parameters<typeof planPrune>[0]> = {}) => planPrune({
  trees: TREES, installedPaths: ACTIVE, livePins: new Set<string>(), nowMs: NOW, graceMs: GRACE, ...over,
});
const doomed = (over?: Partial<Parameters<typeof planPrune>[0]>) =>
  run(over).filter(e => e.prune).map(e => e.tree.version).sort();

test('prunes only trees orphaned past the grace period', () => {
  expect(doomed()).toEqual(['0.11.0', '0.12.1']);
});

test('the active tree is never pruned, even when marked orphaned past grace', () => {
  // A stale .orphaned_at on the tree installed_plugins.json points at must lose to the inventory.
  const trees = [{ ...tree('0.49.0', 40) }, tree('0.11.0', 40)];
  expect(planPrune({ trees, installedPaths: ACTIVE, livePins: new Set(), nowMs: NOW, graceMs: GRACE })
    .filter(e => e.prune).map(e => e.tree.version)).toEqual(['0.11.0']);
});

test('a trailing slash in installed_plugins.json still protects the active tree', () => {
  expect(doomed({ installedPaths: new Set([`${ROOT}/0.11.0/`]) })).toEqual(['0.12.1']);
});

test('a tree a live process is loaded from is kept', () => {
  expect(doomed({ livePins: new Set([`${ROOT}/0.11.0`]) })).toEqual(['0.12.1']);
});

test('unknown live pins (no /proc) prune nothing at all', () => {
  expect(doomed({ livePins: null })).toEqual([]);
});

test('a tree Claude Code has not marked orphaned is kept however old it looks', () => {
  expect(doomed({ trees: [tree('0.11.0', null)] })).toEqual([]);
});

test('every kept tree says which gate held it', () => {
  for (const e of run().filter(x => !x.prune)) expect(e.reason.length).toBeGreaterThan(0);
});

test('parseInstalledPaths collects every plugin and scope, and fails closed on junk', () => {
  const json = JSON.stringify({
    plugins: {
      'a@m': [{ scope: 'user', installPath: '/c/a/1' }, { scope: 'project', installPath: '/c/a/2' }],
      'b@m': [{ scope: 'user', installPath: '/c/b/1' }],
      'c@m': 'not-an-array',
      'd@m': [{ scope: 'user' }],
    },
  });
  expect(parseInstalledPaths(json)).toEqual(new Set(['/c/a/1', '/c/a/2', '/c/b/1']));
  // null (not an empty set) — "cannot tell what is active" must not read as "nothing is active".
  expect(parseInstalledPaths('{ not json')).toBeNull();
  expect(parseInstalledPaths('{"version":2}')).toBeNull();
});

test('pluginRootFromEnviron reads CLAUDE_PLUGIN_ROOT out of a NUL-separated block', () => {
  expect(pluginRootFromEnviron('PATH=/bin\0CLAUDE_PLUGIN_ROOT=/c/p/1/\0HOME=/h\0')).toBe('/c/p/1');
  expect(pluginRootFromEnviron('PATH=/bin\0HOME=/h\0')).toBeNull();
  expect(pluginRootFromEnviron('CLAUDE_PLUGIN_ROOT=\0')).toBeNull();
  // A prefix match must not count — NOT_CLAUDE_PLUGIN_ROOT is a different variable.
  expect(pluginRootFromEnviron('XCLAUDE_PLUGIN_ROOT=/c/p/1\0')).toBeNull();
});

test('a truncated or nonsense .orphaned_at is treated as NO marker, not as epoch 0', () => {
  // Number('') is 0, which reads as "orphaned in 1970" — past every grace window. Left unguarded this
  // deletes a tree orphaned seconds ago, with no grace, which is the worst tree to lose.
  const root = mkdtempSync(join(tmpdir(), 'cm-cache-'));
  const versions: Record<string, string | null> = {
    'empty': '', 'blank': '  \n', 'junk': 'abc', 'hex': '0x10', 'seconds': '1788000000',
    'good': String(NOW - 9 * DAY), 'unmarked': null,
  };
  for (const [v, body] of Object.entries(versions)) {
    const dir = join(root, 'mkt', 'captain-memo', v);
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'captain-memo', version: v }));
    if (body !== null) writeFileSync(join(dir, '.orphaned_at'), body);
  }
  const trees = readCacheTrees(root).filter(t => t.manifestName === 'captain-memo');
  expect(trees.length).toBe(7);
  const marked = trees.filter(t => t.orphanedAtMs !== null).map(t => t.version).sort();
  expect(marked).toEqual(['good']);   // and NOT empty/blank/junk/hex, nor the seconds-not-ms value
  const plan = planPrune({ trees, installedPaths: new Set(), livePins: new Set(), nowMs: NOW, graceMs: GRACE });
  expect(plan.filter(e => e.prune).map(e => e.tree.version)).toEqual(['good']);
  rmSync(root, { recursive: true, force: true });
});

test('an installed_plugins.json whose schema moved fails closed rather than dropping the veto', () => {
  // Parseable, lists plugins, yields no installPath — the field was renamed under us. An empty set here
  // would silently retire the active-tree veto; null makes the caller prune nothing.
  expect(parseInstalledPaths(JSON.stringify({ plugins: { 'a@m': [{ scope: 'user', path: '/c/a/1' }] } }))).toBeNull();
  // …but a genuinely empty plugins map is knowledge, not drift: an empty set, not null.
  expect(parseInstalledPaths(JSON.stringify({ plugins: {} }))).toEqual(new Set());
});

test('describeSessionOf walks the pinning child to its session, parens in comm and all', () => {
  // The pin lands on the MCP child; the SESSION is its parent. /proc/<pid>/stat is
  // `pid (comm) state ppid …` and comm can contain spaces and parens — parsing before the LAST ')'
  // reads the wrong field and reports the wrong session, which is how a remedy names the wrong thing.
  const root = mkdtempSync(join(tmpdir(), 'cm-sess-'));
  const proc = join(root, 'proc'), sessions = join(root, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const stat = (pid: number, comm: string, ppid: number) => {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1 4194304`);
  };
  const session = (pid: number, entrypoint: string, name: string) =>
    writeFileSync(join(sessions, `${pid}.json`), JSON.stringify({ pid, entrypoint, name }));

  stat(200, 'bun', 100); session(100, 'claude-desktop', 'erp-platform-04');
  expect(describeSessionOf(200, sessions, proc)).toEqual({ entrypoint: 'claude-desktop', name: 'erp-platform-04' });

  stat(201, 'bun (mcp) x', 101); session(101, 'sdk-cli', 'capcache');
  expect(describeSessionOf(201, sessions, proc)).toEqual({ entrypoint: 'sdk-cli', name: 'capcache' });

  // No session for the parent — fall back to the pid itself (a session with no plugin child).
  stat(202, 'claude', 1); session(202, 'cli', 'local');
  expect(describeSessionOf(202, sessions, proc)).toEqual({ entrypoint: 'cli', name: 'local' });

  stat(203, 'bun', 999);
  expect(describeSessionOf(203, sessions, proc)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});
