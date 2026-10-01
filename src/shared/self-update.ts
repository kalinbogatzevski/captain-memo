// src/shared/self-update.ts — visible self-upgrade detection (git-free).
//
// Claude Code's GitHub-marketplace auto-fetch delivers new plugin versions, and the
// existing session-start self-heal restarts the now-stale worker. This module adds the one
// missing piece for a *visible* self-upgrade: a persistent version marker + a user-facing
// "upgraded" banner. All I/O is best-effort and confined to DATA_DIR/.install-version (the
// Captain's own state) — it NEVER touches worker.env, config, or corpus data.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

export const MARKER_FILENAME = '.install-version';

/** Compare two semver-ish versions by numeric major.minor.patch. A leading `v` is tolerated
 *  and any -prerelease / +build suffix is ignored. Returns -1 | 0 | 1. Numeric, not lexical
 *  (so 0.10.0 > 0.9.0). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): number[] =>
    v.replace(/^v/i, '').split('+')[0]!.split('-')[0]!.split('.').map(n => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

export type UpdateAction = 'first-run' | 'upgraded' | 'same-or-older';

/** Decide what happened since the last recorded version. */
export function decideUpdateAction(running: string, marker: string | null): UpdateAction {
  if (marker === null) return 'first-run';
  return compareSemver(running, marker) > 0 ? 'upgraded' : 'same-or-older';
}

/** The user-facing banner shown in the SessionStart systemMessage on an upgrade. */
export function formatUpgradeBanner(from: string, to: string, news: string[] = []): string {
  return [
    `⚓ Captain Memo self-upgraded: v${from} → v${to}`,
    ...news,
    '  The worker restarts automatically to pick up the new version.',
    '  Run `captain-memo install` if you want a full refresh (hooks/MCP/services).',
  ].join('\n');
}

/** Banner for the OPT-IN autonomous git self-update (CAPTAIN_MEMO_AUTO_UPDATE=1). Distinct from
 *  formatUpgradeBanner because here Captain actively fast-forwarded the checkout + restarted the
 *  worker itself, rather than just noticing a marketplace refresh. */
export function formatAutoUpdateBanner(from: string, to: string, installFailed?: boolean, news: string[] = []): string {
  const lines = [
    `⚓ Captain Memo auto-updated: v${from} → v${to}`,
    ...news,
    '  Fast-forwarded your checkout to the latest stable tag and restarted the worker.',
  ];
  if (installFailed) lines.push('  ⚠ `bun install` failed — run it in your checkout if the worker misbehaves.');
  lines.push('  Opt out with CAPTAIN_MEMO_AUTO_UPDATE=0.');
  return lines.join('\n');
}

/** Banner when a newer release was found but a safety gate refused to apply it (local edits, detached HEAD, a
 *  fast-forward that does not apply). This used to go to the hook error log only, so the checkout stayed on the
 *  old version indefinitely without the user ever being told. */
export function formatAutoUpdateBlockedBanner(from: string, code: string | undefined, reason: string | undefined): string {
  return [
    `⚓ Captain Memo auto-update is BLOCKED: a newer release is available but was not applied (${reason || code || 'unknown reason'}).`,
    `  Your checkout stays on v${from} until this is fixed: commit or stash local edits and make sure a branch is checked out,`,
    '  or update by hand with `git pull` and `captain-memo install`.',
  ].join('\n');
}

/** Banner when an auto-update's new code failed to boot and Captain rolled the checkout back. */
export function formatRollbackBanner(from: string, attempted: string, rolledBack: boolean): string {
  return rolledBack
    ? [
        `⚓ Captain Memo auto-update to v${attempted} FAILED to start — rolled back to v${from}.`,
        '  Your worker is running the previous version again. The bad tag is skipped until it changes.',
      ].join('\n')
    : [
        `⚓ Captain Memo auto-update to v${attempted} FAILED to start AND rollback failed.`,
        '  Run `git status` in your checkout and `captain-memo install` to recover.',
      ].join('\n');
}

function markerPath(dataDir: string): string {
  return join(dataDir, MARKER_FILENAME);
}

/** The last version session-start announced, or null if absent/blank/unreadable. */
export function readMarker(dataDir: string): string | null {
  try {
    const raw = readFileSync(markerPath(dataDir), 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Persist the marker atomically (temp+rename), creating DATA_DIR. Best-effort — never throws. */
export function writeMarker(dataDir: string, version: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const final = markerPath(dataDir);
    const tmp = `${final}.tmp-${process.pid}`;
    writeFileSync(tmp, `${version}\n`, 'utf-8');
    renameSync(tmp, final);
  } catch {
    /* a failed marker write just means we re-detect next run — never fatal */
  }
}

/** Read marker → decide → persist the running version → the upgrade to announce ({from, to}), or null.
 *  Null on first run and when unchanged/older. Never throws (fail-open). */
export function consumeUpgrade(dataDir: string, runningVersion: string): { from: string; to: string } | null {
  try {
    const marker = readMarker(dataDir);
    const action = decideUpdateAction(runningVersion, marker);
    if (action === 'same-or-older') return null;
    writeMarker(dataDir, runningVersion);
    return action === 'upgraded' ? { from: marker!, to: runningVersion } : null;
  } catch {
    return null;
  }
}

/** consumeUpgrade, formatted: the upgrade banner (or ''), without the what's-new lines the hook adds. */
export function consumeUpgradeNotice(dataDir: string, runningVersion: string): string {
  const up = consumeUpgrade(dataDir, runningVersion);
  return up ? formatUpgradeBanner(up.from, up.to) : '';
}
