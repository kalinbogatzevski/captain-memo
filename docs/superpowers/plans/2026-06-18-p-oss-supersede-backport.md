# P-OSS-Supersede — Supersede Backport to OSS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backport the P3 "supersede stale facts (conservative first slice)" stack from `federation` to the OSS `master` edition and ship it as `0.13.0`.

**Architecture:** Clean-copy the edition-agnostic files whose base is byte-identical between editions (verified `git diff master c377928 == 0`); hand-apply the P3 deltas to the two diverged files (`search-config.ts` OSS variant, `index.ts` local-only) and the CLI registry; fix the test literals the new required `Observation.superseded_by` field breaks; release.

**Tech Stack:** TypeScript on Bun; `bun:sqlite`; `bun test`; `bun run typecheck`; `bun run build:plugin`. Both editions are branches in one git repo, so clean-copy = `git checkout federation -- <path>`.

## Global Constraints

- **Detection OFF by default:** `qmConfig.supersedeEnabled` = `env.CAPTAIN_MEMO_QM_SUPERSEDE === '1'`, default false. No supersede link is created unless explicitly enabled.
- **Demote, never hide:** search consumption only multiplies a superseded hit's score by `supersedePenalty` (<1) and re-sorts; no hit is dropped. `findById`/drill-in unfiltered.
- **Reversible:** every link writes a `supersede_events` row; `unlinkSupersede` flips `superseded_by` to NULL + marks the event `undone = 1`.
- **`supersedePenalty`:** `legacy` = 1 (inert), `v2` = 0.5 (matches federation). With detection off (no links) demotion is inert → the release changes nothing out of the box.
- **Local-only:** OSS has no remote/federation code. `index.ts` `/search/all` is `localSearchAll` directly (no remote-merge); the demote sits inside `localSearchAll`. Do NOT introduce any remote concept.
- **Clean-copy is exact:** for files whose base is byte-identical (`observations-store.ts`, `qm.ts`, `shared/types.ts`, and their pre-existing tests), `git checkout federation -- <path>` yields *master + the P3 additions* and nothing else (verified).
- **Known pre-existing typecheck failure:** `src/cli/commands/restart.test.ts:46` TS2769 is pre-existing on master (byte-identical at base and head) — ignore ONLY that one; everything else must typecheck clean.
- **TDD/verification:** the ported modules carry the federation tests; each task runs its suites + `bun run typecheck` and ends with a commit. Branch: `feat/supersede-oss` (already created off `master`).

---

### Task 1: Core local stack (clean-copy + literal fixes)

**Files (clean-copy from `federation` HEAD):**
- Create: `src/worker/version-parse.ts`, `src/worker/supersede.ts`
- Overwrite (base byte-identical → = master + P3): `src/worker/observations-store.ts`, `src/worker/qm.ts`, `src/shared/types.ts`
- Tests (clean-copy): `tests/unit/version-parse.test.ts`, `tests/unit/supersede.test.ts`, `tests/unit/observations-store.test.ts`, `tests/unit/worker/qm.test.ts`, `tests/unit/promotion-judge.test.ts` (the last brings federation's `superseded_by: null` literal fix)
- Literal fixes (typecheck-driven): any `Observation` object literal master has that the new required field breaks — likely `tests/integration/dedup-command.test.ts`, `tests/unit/observation-queue.test.ts`, `tests/unit/promotion.test.ts`.

**Interfaces:**
- Consumes: existing `significantTokens` (`src/shared/title-similarity.ts`), `cosine` (`src/shared/vector-math.ts`), `QmConfig` (`src/worker/qm.ts`).
- Produces (for later tasks): `parseVersion`/`compareVersion`/`SemVer` (`version-parse.ts`); `runQmSupersedeSlice`/`applySupersedeDemotion`/`QmSupersedeDeps`/`QmSupersedeResult` (`supersede.ts`); `Observation.superseded_by: number | null`; store methods `linkSupersede`/`unlinkSupersede`/`supersededAmong`/`supersedeLinkCount`/`listSupersedeEvents`/`supersedeCandidateWindow` + `SupersedeCandidate` type; `QmConfig.supersedeEnabled`.

- [ ] **Step 1: Clean-copy the source + new modules from federation**

```bash
cd /home/kalin/projects/captain-memo
git checkout federation -- \
  src/worker/version-parse.ts \
  src/worker/supersede.ts \
  src/worker/observations-store.ts \
  src/worker/qm.ts \
  src/shared/types.ts
```

- [ ] **Step 2: Clean-copy the tests from federation**

```bash
git checkout federation -- \
  tests/unit/version-parse.test.ts \
  tests/unit/supersede.test.ts \
  tests/unit/observations-store.test.ts \
  tests/unit/worker/qm.test.ts \
  tests/unit/promotion-judge.test.ts
```

- [ ] **Step 3: Typecheck to surface broken `Observation` literals**

Run: `bun run typecheck 2>&1 | grep -v 'restart.test.ts'`
Expected: errors of the form `... Property 'superseded_by' is missing in type '{...}' but required in type 'Observation'` pointing at object literals (candidate files: `tests/integration/dedup-command.test.ts`, `tests/unit/observation-queue.test.ts`, `tests/unit/promotion.test.ts`, or any src file). Note the exact file:line of each.

- [ ] **Step 4: Fix each flagged literal**

For every `Observation` object literal the typecheck flagged, add the field next to the other lifecycle fields:

```ts
  superseded_by: null,
```

(If a flagged site uses `as Observation` on a partial object, it will not error — leave it. Only true object literals typed as `Observation` need the field.)

- [ ] **Step 5: Typecheck clean**

Run: `bun run typecheck 2>&1 | grep -v 'restart.test.ts:46'`
Expected: no output (no errors except the ignored pre-existing one).

- [ ] **Step 6: Run the copied suites**

Run: `bun test tests/unit/version-parse.test.ts tests/unit/supersede.test.ts tests/unit/observations-store.test.ts tests/unit/worker/qm.test.ts tests/unit/promotion-judge.test.ts`
Expected: all pass (version-parse 7, supersede 5, observations-store incl. the P3 store/window tests, qm incl. supersedeEnabled, promotion-judge).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(supersede): port core local stack — parser, store ledger, gated slice (P-OSS-supersede task 1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: OSS `search-config.ts` — `supersedePenalty`

**Files:**
- Modify: `src/worker/search-config.ts` (the OSS variant — no remote fields)
- Modify: `tests/unit/worker/search-config.test.ts` (append the config test)
- Modify: `tests/unit/worker/temporal-intent.test.ts` (fix its `RankConfig` literal broken by the new required field)

**Interfaces:**
- Produces: `RankConfig.supersedePenalty: number` (`legacy`=1, `v2`=0.5; env `CAPTAIN_MEMO_SUPERSEDE_PENALTY`).

- [ ] **Step 1: Write the failing config test** (append to `tests/unit/worker/search-config.test.ts`)

```ts
test('P-OSS supersede — supersedePenalty: legacy inert (1), v2 demotes (0.5), env override', () => {
  expect(resolveRankConfig('legacy', {}).supersedePenalty).toBe(1);
  expect(resolveRankConfig('v2', {}).supersedePenalty).toBe(0.5);
  expect(resolveRankConfig('v2', { CAPTAIN_MEMO_SUPERSEDE_PENALTY: '0.3' }).supersedePenalty).toBe(0.3);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/worker/search-config.test.ts -t supersedePenalty`
Expected: FAIL — `supersedePenalty` is `undefined`.

- [ ] **Step 3: Add the field to the `RankConfig` interface** (`src/worker/search-config.ts`, after `properNounBoostWeight`)

```ts
  supersedePenalty: number;     // score multiplier for superseded hits (1 = inert/no demote)
```

- [ ] **Step 4: Set it in both profiles**

In the `LEGACY` (or base) profile object, after `properNounBoostWeight: 1,`:

```ts
  supersedePenalty: 1,
```

In the `v2` profile object, after its `properNounBoostWeight` line:

```ts
    supersedePenalty: 0.5,
```

- [ ] **Step 5: Add the env override** in `resolveRankConfig`'s returned object (after the `properNounBoostWeight:` line; the OSS file already has the `num` helper)

```ts
    supersedePenalty: num(env.CAPTAIN_MEMO_SUPERSEDE_PENALTY, base.supersedePenalty),
```

- [ ] **Step 6: Config test passes**

Run: `bun test tests/unit/worker/search-config.test.ts`
Expected: all pass including the new supersedePenalty test.

- [ ] **Step 7: Fix the broken `RankConfig` literal in temporal-intent test**

Run: `bun run typecheck 2>&1 | grep -v 'restart.test.ts:46'`
Expected: a `Property 'supersedePenalty' is missing` error pointing at the `RankConfig` literal (the V2 fixture) in `tests/unit/worker/temporal-intent.test.ts`. Add to that literal:

```ts
  supersedePenalty: 1,
```

(If typecheck flags any other standalone `RankConfig` literal, add `supersedePenalty: 1` there too. Literals built via `resolveRankConfig` need no change.)

- [ ] **Step 8: Typecheck clean + temporal test passes**

Run: `bun run typecheck 2>&1 | grep -v 'restart.test.ts:46'` (expect no output) and `bun test tests/unit/worker/temporal-intent.test.ts` (expect pass).

- [ ] **Step 9: Commit**

```bash
git add src/worker/search-config.ts tests/unit/worker/search-config.test.ts tests/unit/worker/temporal-intent.test.ts
git commit -m "feat(supersede): supersedePenalty in OSS rank config (P-OSS-supersede task 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `index.ts` hand-port (local-only)

**Files:**
- Modify: `src/worker/index.ts`

**Interfaces:**
- Consumes: `runQmSupersedeSlice`, `applySupersedeDemotion` (`./supersede.ts`); `supersedeLinkCount`/`supersededAmong`/`linkSupersede`/`supersedeCandidateWindow`/`isProtected` (store); `qmConfig.supersedeEnabled`; `cfg.supersedePenalty`; existing `dropArchived`/`dropByLookup`/`localSearchAll`/`applyTemporalRerank`/`dropSunkForAutoInject`/`obsStore`/`repVec`/`recordQmRun`.

To see the exact federation edits to replicate (these are the source of truth — apply the same edits, minus nothing, since OSS already has no remote in these spots), inspect:
```bash
git -C /home/kalin/projects/captain-memo-fed diff 1d8a03c d7ac237 -- src/worker/index.ts   # repVec hoist + supersede timer
git -C /home/kalin/projects/captain-memo-fed diff d7ac237 acef2b3 -- src/worker/index.ts   # demoteSuperseded + 3 sites
git -C /home/kalin/projects/captain-memo-fed diff acef2b3 07d6017 -- src/worker/index.ts   # /stats supersede field
```

- [ ] **Step 1: Add the imports**

In the import that already pulls from `./supersede.ts` (added implicitly — if none exists yet, add a new import line near the other `./` worker imports):

```ts
import { runQmSupersedeSlice, applySupersedeDemotion } from './supersede.ts';
```

- [ ] **Step 2: Hoist `repVec`**

Move the `const repVec = (obsId: number): Float32Array | null => { ... }` declaration OUT of the `if (!opts.readOnly && obsStore && qmConfig.enabled && qmConfig.dedupEnabled) { ... }` block to just ABOVE that block (it depends only on `meta`, `vector`, `opts.projectId`). Delete the inner declaration. The dedup block must still reference the now-outer `repVec` — its body is unchanged:

```ts
// Shared representative-vector accessor: centroid of an observation's chunk vectors.
// Used by both QM auto-dedup and the P3 supersede sweep.
const repVec = (obsId: number): Float32Array | null => {
  const doc = meta.getDocument(`observation:${opts.projectId}:${obsId}`);
  if (!doc) return null;
  const vecs = meta.getChunksForDocument(doc.id)
    .map(c => vector.getEmbedding(c.chunk_id))
    .filter((v): v is Float32Array => v != null)
    .map(v => Array.from(v));
  const c = centroid(vecs);
  return c ? Float32Array.from(c) : null;
};
```

- [ ] **Step 3: Add the supersede sweep timer** immediately after the QM dedup block's closing (after its `setInterval` is assigned)

```ts
// Quartermaster supersede sweep (P3, opt-in, OFF by default). Sibling of the dedup
// timer: each slice pulls a bounded window of older→newest version pairs (entityKey-
// exact, (project,branch)-scoped), confirms each by cosine ≥ threshold against the
// newer's centroid, skips protected rows, and links the older as superseded — never
// hiding it (search demotes). Reuses repVec and the same abort/heartbeat discipline.
let qmSupersedeTimer: ReturnType<typeof setInterval> | null = null;
let qmSupersedePromise: Promise<unknown> | null = null;
if (!opts.readOnly && obsStore && qmConfig.enabled && qmConfig.supersedeEnabled) {
  const qmStore = obsStore;
  qmSupersedeTimer = setInterval(() => {
    if (qmSupersedePromise) return;
    const startedAt = Math.floor(Date.now() / 1000);
    qmSupersedePromise = runQmSupersedeSlice({
      candidates: () => qmStore.supersedeCandidateWindow(qmConfig.dedupWindow),
      representativeVector: repVec,
      isProtected: (id) => qmStore.isProtected(id),
      linkSupersede: (older, newer, m) => qmStore.linkSupersede(older, newer, m),
      shouldAbort: () => processBatchPromise != null || (obsQueue?.pendingCount() ?? 0) > 0,
      cfg: qmConfig,
      now: () => Math.floor(Date.now() / 1000),
      yieldToLoop: () => new Promise<void>(r => setImmediate(r)),
    })
      .then(r => {
        qmStore.recordQmRun({ job: 'supersede', startedAt, finishedAt: Math.floor(Date.now() / 1000),
          rowsScanned: r.scanned, merges: r.linked, skippedNoVector: r.skippedNoVector,
          abortedForIngest: r.aborted, errored: false });
        if (r.linked > 0) console.error(`[qm-supersede] linked ${r.linked} stale fact(s)` + (r.aborted ? ' (aborted for ingest)' : ''));
      })
      .catch(err => {
        qmStore.recordQmRun({ job: 'supersede', startedAt, finishedAt: Math.floor(Date.now() / 1000),
          rowsScanned: 0, merges: 0, skippedNoVector: 0, abortedForIngest: false, errored: true });
        console.error('[qm-supersede] ERROR', err);
      })
      .finally(() => { qmSupersedePromise = null; });
  }, qmConfig.dedupIntervalMs);
}
```

> If OSS `processBatchPromise`/`obsQueue` are named differently than federation, use whatever the existing dedup block's `shouldAbort` uses — copy that exact expression from the OSS dedup block.

- [ ] **Step 4: Clear the timer on shutdown**

Find where `qmDedupTimer` is cleared (search `clearInterval(qmDedupTimer)`) and add beside it:

```ts
if (qmSupersedeTimer) clearInterval(qmSupersedeTimer);
```

- [ ] **Step 5: Add `demoteSuperseded`** right after the `dropArchived` declaration

```ts
/**
 * Demote (never drop) hits whose backing observation has been superseded by a newer
 * version (P3). Multiplies their score by `penalty` (<1) and re-sorts. No-op when the
 * penalty is ≥ 1 (legacy/disabled) or nothing in view is superseded. Applied only to
 * observation-bearing surfaces; memory/skill hits carry no observation_id so it is inert
 * there by construction (not wired). Distinct from dropArchived (which hides folded dupes).
 */
const demoteSuperseded = <T extends { score: number; metadata: Record<string, unknown> }>(
  items: T[], penalty: number,
): T[] => {
  if (!obsStore || penalty >= 1 || items.length === 0) return items;
  const ids: number[] = [];
  for (const item of items) {
    const oid = item.metadata?.observation_id;
    if (typeof oid === 'number' && Number.isInteger(oid) && oid > 0) ids.push(oid);
  }
  if (ids.length === 0) return items;
  return applySupersedeDemotion(items, obsStore.supersededAmong(ids), penalty);
};
```

- [ ] **Step 6: Wire the three observation-bearing sites**

(a) `localSearchAll` final return — change `return dropArchived(results) as Hit[];` (or the equivalent OSS return) to:
```ts
return demoteSuperseded(dropArchived(results), config.supersedePenalty) as Hit[];
```
(use the actual `RankConfig` parameter name of `localSearchAll` — on federation it is `config`; confirm in the OSS signature).

(b) `/search/observations` — wrap the existing `dropArchived(...)` inside `applyTemporalRerank(...)` with the demote:
```ts
const results = applyTemporalRerank(
  demoteSuperseded(
    dropArchived(await searchByChannel(parsed.data.query, 'observation', parsed.data.top_k, filters, cfg)),
    cfg.supersedePenalty,
  ),
  parsed.data.query, cfg, Date.now(),
);
```

(c) `/inject/context` — insert demote between `dropArchived` and `dropSunkForAutoInject`:
```ts
const hits = applyTemporalRerank(
  dropSunkForAutoInject(demoteSuperseded(dropArchived(candidates), cfg.supersedePenalty)).slice(0, parsed.data.top_k),
  trimmed, cfg, Date.now(),
);
```

Do NOT wire `/search/memory` or `/search/skill`.

- [ ] **Step 7: Add the `/stats` supersede field** next to the existing `qm` block in the `/stats` handler

```ts
supersede: { links: obsStore ? obsStore.supersedeLinkCount() : 0 },
```

- [ ] **Step 8: Typecheck + worker-affecting suites**

Run: `bun run typecheck 2>&1 | grep -v 'restart.test.ts:46'` (expect no output) and `bun test tests/unit/worker/search-config.test.ts tests/unit/worker/temporal-intent.test.ts tests/integration/search-boosts.test.ts tests/unit/search.test.ts` (expect pass). Legacy and v2-no-links search is unchanged (demote returns input when penalty≥1 or nothing superseded); dedup path unchanged (repVec hoist behavior-identical).

- [ ] **Step 9: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat(supersede): wire detection sweep + demote-not-hide into OSS handlers (P-OSS-supersede task 3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: CLI — `captain-memo supersede`

**Files:**
- Create (clean-copy): `src/cli/commands/supersede.ts`, `tests/unit/supersede-command.test.ts`
- Modify: `src/cli/index.ts` (register the command)

**Interfaces:**
- Consumes: `unlinkSupersede`/`listSupersedeEvents`/`linkSupersede`/`supersedeLinkCount` (store, Task 1); the existing CLI dispatch in `src/cli/index.ts` (which already registers `dedup` the same way).

- [ ] **Step 1: Clean-copy the command + its test**

```bash
cd /home/kalin/projects/captain-memo
git checkout federation -- src/cli/commands/supersede.ts tests/unit/supersede-command.test.ts
```

- [ ] **Step 2: Register the command in `src/cli/index.ts`**

Add the import next to the other command imports (e.g. after the `dedup` import):
```ts
import { supersedeCommand } from './commands/supersede.ts';
```
Add the dispatch case next to `case 'dedup':` (match the exact surrounding style):
```ts
    case 'supersede':
      exit = await supersedeCommand(args.slice(1));
      break;
```
Add a help line where `dedup` is listed in the help text:
```ts
  supersede    list | undo <id> — inspect open supersede links and reverse them
```
(Match the indentation/format of the surrounding help entries exactly.)

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck 2>&1 | grep -v 'restart.test.ts:46'`
Expected: no output.

- [ ] **Step 4: Run the CLI test**

Run: `bun test tests/unit/supersede-command.test.ts`
Expected: all pass (list prints the link; undo drops `supersedeLinkCount()` to 0; missing-id errors with exit 2).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/supersede.ts tests/unit/supersede-command.test.ts src/cli/index.ts
git commit -m "feat(supersede): captain-memo supersede list/undo CLI (P-OSS-supersede task 4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Release `0.13.0`

**Files:**
- Modify: `package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `CHANGELOG.md`
- Rebuild: `plugin/dist/mcp-server.js`, `plugin/dist/captain-memo-hook.js`

- [ ] **Step 1: Confirm the current version line + the release ritual**

Run: `grep -n '"version"' package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json`
Expected: all show `0.12.0`. Read `CHANGELOG.md`'s top entry to match its format.

- [ ] **Step 2: Bump the three manifests to `0.13.0`**

Set `"version": "0.13.0"` in `package.json`, `.claude-plugin/marketplace.json`, and `plugin/.claude-plugin/plugin.json` (replace the `0.12.0` value in each).

- [ ] **Step 3: Add the CHANGELOG entry** at the top of `CHANGELOG.md` (match the existing entry format)

```markdown
## 0.13.0

- **Supersede stale facts (conservative first slice).** Version-aware supersede detection — when a newer version of the same fact appears (e.g. "talq v0.51.12" vs "v0.6.0"), the older observation is linked as superseded and **demoted (not hidden)** at search time. Detection is **OFF by default** (`CAPTAIN_MEMO_QM_SUPERSEDE=1` to enable); fully reversible. New `captain-memo supersede list|undo` CLI to inspect and reverse links. No behavior change out of the box.
```

- [ ] **Step 4: Rebuild the plugin bundles**

Run: `bun run build:plugin`
Expected: regenerates `plugin/dist/mcp-server.js` and `plugin/dist/captain-memo-hook.js` (so the committed-bundle freshness test passes).

- [ ] **Step 5: Full suite + typecheck (the release gate)**

Run: `bun run typecheck 2>&1 | grep -v 'restart.test.ts:46'` (expect no output) and `bun test 2>&1 | tail -20`
Expected: all pass, including `tests/**/plugin-manifest.test.ts` (manifest-version parity across the three manifests + committed-bundle freshness). Report any pre-existing unrelated failures rather than fixing them out of scope.

- [ ] **Step 6: Commit**

```bash
git add package.json .claude-plugin/marketplace.json plugin/.claude-plugin/plugin.json CHANGELOG.md plugin/dist/mcp-server.js plugin/dist/captain-memo-hook.js
git commit -m "release: 0.13.0 — supersede stale facts (detection off by default; demote-not-hide; supersede CLI)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-18-p-oss-supersede-backport-design.md`):
- §2 ports list → Tasks 1 (core + tests), 2 (search-config), 3 (index wiring + /stats), 4 (CLI). ✓
- §3 port mechanism (clean-copy byte-identical-base; hand-apply diverged) → Task 1 uses `git checkout federation --` for the verified-identical-base files; Tasks 2/3/4 hand-apply the diverged `search-config.ts`/`index.ts`/`cli/index.ts`. ✓
- §4 search-config supersedePenalty (field+LEGACY+v2+env) → Task 2. ✓
- §5 index.ts hand-port (repVec hoist, supersede timer, demote 3 sites, /stats, imports, local-only) → Task 3. ✓
- §6 decomposition (5 tasks) → Tasks 1-5. ✓
- §7 zero-change-when-off + no-dedup-regression + typecheck gate → Task 1 (gate off via copied qm.ts default), Task 3 Step 8 (legacy/v2-no-links unchanged; dedup unchanged). ✓
- §8 risks (index hand-port drift, test-literal breakage, release ritual) → Task 3 references the federation diffs; Tasks 1/2 are typecheck-driven for literals; Task 5 rebuilds bundles. ✓

**2. Placeholder scan:** No TBD/TODO. Clean-copy steps are exact `git checkout` commands; hand-apply steps carry the full code. Literal-fix steps are typecheck-driven with the exact fix shown (`superseded_by: null` / `supersedePenalty: 1`) and candidate file list — a defined procedure, not a hand-wave. Task 3 points at the three federation commit-diffs as the authoritative source for the index edits, with the full code inline as well.

**3. Type consistency:** `supersedePenalty` (Task 2) consumed by `demoteSuperseded` (Task 3). `applySupersedeDemotion`/`runQmSupersedeSlice` (Task 1, copied) imported by Task 3. `supersedeLinkCount`/`supersededAmong`/`supersedeCandidateWindow`/`linkSupersede`/`isProtected` (Task 1) used by Tasks 3-4. `qmConfig.supersedeEnabled` (Task 1) gates the Task 3 timer. `supersede.ts` CLI command (Task 4) + `unlinkSupersede`/`listSupersedeEvents` (Task 1). Consistent.

**Note for the executor:** Task 3 is the only non-mechanical task — `index.ts` diverges from federation (local-only), so the edits are applied by hand using the federation commit-diffs as reference. Verify after Step 2 that the dedup block still references the hoisted `repVec` and after Step 8 that the dedup path and legacy/v2-no-links search are unchanged.
