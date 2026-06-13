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
export function formatUpgradeBanner(from: string, to: string): string {
  return [
    `⚓ Captain Memo self-upgraded: v${from} → v${to}`,
    '  The worker restarts automatically to pick up the new version.',
    '  Run `captain-memo install` if you want a full refresh (hooks/MCP/services).',
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

/** Read marker → decide → persist the running version → return the upgrade banner (or '').
 *  Silent on first run and when unchanged/older. Never throws (fail-open). */
export function consumeUpgradeNotice(dataDir: string, runningVersion: string): string {
  try {
    const marker = readMarker(dataDir);
    const action = decideUpdateAction(runningVersion, marker);
    if (action === 'same-or-older') return '';
    writeMarker(dataDir, runningVersion);
    return action === 'upgraded' ? formatUpgradeBanner(marker!, runningVersion) : '';
  } catch {
    return '';
  }
}
