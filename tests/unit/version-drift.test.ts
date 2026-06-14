import { test, expect, describe } from 'bun:test';
import {
  decideWorkerDrift,
  pickUpgradeTarget,
  parseRemoteCandidates,
  computeLatestFleetVersion,
  type RemoteCandidate,
} from '../../src/shared/version-drift.ts';

describe('decideWorkerDrift (check A)', () => {
  test('equal versions PASS', () => {
    const v = decideWorkerDrift('0.10.1', '0.10.1');
    expect(v.status).toBe('PASS');
  });

  test('running OLDER than installed FAILs with reinstall remedy', () => {
    const v = decideWorkerDrift('0.8.0', '0.10.1');
    expect(v.status).toBe('FAIL');
    expect(v.detail).toContain('0.8.0');
    expect(v.detail).toContain('0.10.1');
    expect(v.remedy).toContain('captain-memo install');
  });

  test('running NEWER than installed WARNs (clone behind)', () => {
    const v = decideWorkerDrift('0.10.1', '0.8.0');
    expect(v.status).toBe('WARN');
  });

  test('unknown running version is skipped as PASS', () => {
    const v = decideWorkerDrift(null, '0.10.1');
    expect(v.status).toBe('PASS');
  });
});

describe('pickUpgradeTarget (check B)', () => {
  // The exact Windows topology: HEAD on feat/session-ctl-p0 @ 0.8.0.
  // gitlab/federation @ 0.10.1 CONTAINS HEAD (p0 was folded in); github/master @ 0.10.1 does NOT.
  const winCandidates: RemoteCandidate[] = [
    { ref: 'gitlab/federation', branch: 'federation', version: '0.10.1' },
    { ref: 'github/master', branch: 'master', version: '0.10.1' },
  ];
  const containsHead = (ref: string) => ref === 'gitlab/federation';

  test('recommends the branch that CONTAINS HEAD (federation), never master', () => {
    const t = pickUpgradeTarget('0.8.0', winCandidates, containsHead);
    expect(t.kind).toBe('upgrade');
    if (t.kind === 'upgrade') {
      expect(t.branch).toBe('federation');
      expect(t.ref).toBe('gitlab/federation');
      expect(t.version).toBe('0.10.1');
    }
  });

  test('no newer remote → current', () => {
    const t = pickUpgradeTarget('0.10.1', winCandidates, containsHead);
    expect(t.kind).toBe('current');
  });

  test('newer exists but none contain HEAD → divergent', () => {
    const t = pickUpgradeTarget('0.8.0', winCandidates, () => false);
    expect(t.kind).toBe('divergent');
    if (t.kind === 'divergent') expect(t.candidates.length).toBe(2);
  });

  test('picks the HIGHEST version among containing candidates', () => {
    const cands: RemoteCandidate[] = [
      { ref: 'r/a', branch: 'a', version: '0.9.0' },
      { ref: 'r/b', branch: 'b', version: '0.10.1' },
    ];
    const t = pickUpgradeTarget('0.8.0', cands, () => true);
    expect(t.kind).toBe('upgrade');
    if (t.kind === 'upgrade') expect(t.version).toBe('0.10.1');
  });
});

describe('parseRemoteCandidates (check B ref parsing)', () => {
  // %(refname:short) collapses refs/remotes/<remote>/HEAD to the BARE remote name.
  const blob = [
    'origin',              // ← symbolic HEAD alias (bare remote name) — MUST be skipped
    'origin/HEAD',         // ← explicit symbolic HEAD — MUST be skipped
    'origin/master',
    'gitlab/federation',
    'github/HEAD',         // ← skipped
    '',                    // ← blank — skipped
  ].join('\n');
  const versions: Record<string, string> = {
    'origin/master': '0.10.1',
    'gitlab/federation': '0.10.1',
  };
  const versionFor = (ref: string) => versions[ref] ?? null;

  test('skips bare remote name and */HEAD, keeps real branches', () => {
    const cands = parseRemoteCandidates(blob, versionFor);
    expect(cands.map(c => c.ref).sort()).toEqual(['gitlab/federation', 'origin/master']);
    // branch portion is everything after the FIRST slash — never the remote name
    expect(cands.find(c => c.ref === 'gitlab/federation')!.branch).toBe('federation');
    expect(cands.some(c => c.branch === 'origin' || c.branch === 'gitlab')).toBe(false);
  });

  test('drops refs whose package.json version is unreadable', () => {
    const cands = parseRemoteCandidates('a/b\nc/d', () => null);
    expect(cands).toEqual([]);
  });
});

describe('computeLatestFleetVersion (check C)', () => {
  test('returns the max across self + members', () => {
    expect(computeLatestFleetVersion('0.8.0', ['0.10.1', '0.9.0'])).toBe('0.10.1');
  });

  test('own version wins when newest', () => {
    expect(computeLatestFleetVersion('0.10.1', ['0.8.0', '0.9.0'])).toBe('0.10.1');
  });

  test('ignores absent / garbage member versions', () => {
    expect(computeLatestFleetVersion('0.10.1', [undefined, null, '', 'not-a-version'])).toBe('0.10.1');
  });

  test('empty member list returns own', () => {
    expect(computeLatestFleetVersion('0.10.1', [])).toBe('0.10.1');
  });
});
