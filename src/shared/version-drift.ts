// src/shared/version-drift.ts — pure, git-/network-free helpers for `captain-memo doctor`'s
// version-drift checks. No I/O here: doctor.ts gathers the inputs (worker /stats, git refs,
// /federation/status) and calls these for the verdicts. Kept OSS-safe (no federation imports)
// so the SAME file ships byte-identical on master and federation.
import { compareSemver } from './self-update.ts';

export type DriftStatus = 'PASS' | 'WARN' | 'FAIL';
export interface DriftVerdict {
  status: DriftStatus;
  detail: string;
  remedy?: string;
}

/** Check A — running worker version vs the installed (on-disk) VERSION.
 *  running===null means the worker is unreachable / reported no version: the existing
 *  `worker service` check already owns that failure, so we skip (PASS) rather than double-flag. */
export function decideWorkerDrift(running: string | null, installed: string): DriftVerdict {
  if (!running) return { status: 'PASS', detail: 'worker version unknown — skipped' };
  const cmp = compareSemver(running, installed);
  if (cmp === 0) return { status: 'PASS', detail: `worker on v${running} (matches install)` };
  if (cmp < 0) {
    return {
      status: 'FAIL',
      detail: `worker stale — running v${running}, installed v${installed}`,
      remedy: 'captain-memo install   (the worker is serving old code; this force-restarts it onto the installed version)',
    };
  }
  // running > installed: the worker is NEWER than this checkout — the clone is behind.
  return {
    status: 'WARN',
    detail: `worker newer than checkout — running v${running} > installed v${installed}`,
    remedy: 'this clone is behind the running worker — pull + reinstall, or a reinstall here would DOWNGRADE the worker',
  };
}

/** One remote-tracking branch carrying a parseable package.json version. */
export interface RemoteCandidate {
  ref: string;      // e.g. 'gitlab/federation' (refs/remotes/<ref>)
  branch: string;   // the branch portion, e.g. 'federation'
  version: string;  // version string from <ref>:package.json
}

/** Parse `git for-each-ref --format='%(refname:short)' refs/remotes/` output into RemoteCandidate[].
 *  CRITICAL: %(refname:short) collapses the symbolic remote HEAD `refs/remotes/<remote>/HEAD` to the
 *  BARE remote name (e.g. `origin`, NO `/HEAD` suffix), which a `endsWith('/HEAD')` filter misses — that
 *  bare entry would otherwise become a phantom candidate whose branch == the remote NAME, yielding a
 *  bogus `git checkout origin` remedy. So we skip refs with no `/` (the symbolic-HEAD alias) AND any
 *  explicit trailing HEAD ref. `versionFor(ref)` reads <ref>:package.json version; refs w/o one dropped. */
export function parseRemoteCandidates(
  forEachRefOutput: string,
  versionFor: (ref: string) => string | null,
): RemoteCandidate[] {
  const out: RemoteCandidate[] = [];
  for (const ref of forEachRefOutput.split('\n').map(s => s.trim()).filter(Boolean)) {
    const slash = ref.indexOf('/');
    if (slash < 0) continue;             // bare remote name = the symbolic HEAD alias (e.g. 'origin') — skip
    if (ref.endsWith('/HEAD')) continue; // explicit '<remote>/HEAD' — skip
    const version = versionFor(ref);
    if (!version) continue;
    out.push({ ref, branch: ref.slice(slash + 1), version });
  }
  return out;
}

export type UpgradeTarget =
  | { kind: 'upgrade'; ref: string; branch: string; version: string }   // newer AND continues this line
  | { kind: 'divergent'; candidates: RemoteCandidate[] }                 // newer exist but none continue this line
  | { kind: 'current' };                                                 // nothing newer than HEAD

/** Check B — given HEAD's version and the remote branches, pick the SAFE upgrade target.
 *  "Safe" = a branch that is strictly newer AND contains HEAD (`containsHead(ref)` true), so
 *  switching to it never silently drops this captain's features. For the Windows case this
 *  uniquely selects `federation` (which contains a folded feat/session-ctl-p0) and rejects
 *  `master` (which does not). When newer branches exist but NONE contain HEAD, we report them
 *  as `divergent` so doctor warns without giving a follow-the-wrong-line command. */
export function pickUpgradeTarget(
  headVersion: string,
  candidates: RemoteCandidate[],
  containsHead: (ref: string) => boolean,
): UpgradeTarget {
  const newer = candidates.filter(c => compareSemver(c.version, headVersion) === 1);
  if (newer.length === 0) return { kind: 'current' };
  const containing = newer.filter(c => containsHead(c.ref));
  if (containing.length === 0) return { kind: 'divergent', candidates: newer };
  const best = containing.reduce((a, b) => (compareSemver(b.version, a.version) === 1 ? b : a));
  return { kind: 'upgrade', ref: best.ref, branch: best.branch, version: best.version };
}

/** Check C — the newest version known across the federation: max(own, …member versions).
 *  Absent/garbage member versions are ignored (compareSemver parses non-numeric segments to 0,
 *  so they can never exceed a real version; the explicit guard just avoids touching empties). */
export function computeLatestFleetVersion(
  own: string,
  memberVersions: ReadonlyArray<string | undefined | null>,
): string {
  let max = own;
  for (const v of memberVersions) {
    if (!v || !/\d/.test(v)) continue;
    if (compareSemver(v, max) === 1) max = v;
  }
  return max;
}
