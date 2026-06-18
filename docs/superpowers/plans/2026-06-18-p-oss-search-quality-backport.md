# P-OSS — Search-Quality Backport (OSS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backport the local search-quality stack (weighted fusion, temporal-intent recency re-rank, proper-noun boost, rank profiles, eval harness) from `federation` to the OSS `master` edition, shipping as a release with `v2` as the default.

**Architecture:** Clean-copy the federation modules whose `master` base is byte-identical (`git show federation:<path>`); author an OSS-tailored `search-config.ts` (no remote/recencyDominance fields; default profile = `v2`); hand-port the local wiring into `master`'s `index.ts` (no remote-merge, no inbox block); then release (version bump + CHANGELOG + bundle rebuild).

**Tech Stack:** TypeScript on Bun; `bun:test`; the eval harness ports along.

## Global Constraints

- **Branch/worktree:** `feat/search-quality-oss` (off `master`), worktree `/home/kalin/projects/captain-memo`. (No worker runs from here — safe to edit.)
- **Clean-copy source is the `federation` branch** (same repo, shared `.git`): `git show federation:<path> > <path>`. Verified byte-identical base for `search.ts`/`rerank.ts`/`recall-audit.ts`/`meta.ts`, so the federation versions are exactly `master` + the local additions.
- **Exclude all federation-only remote pieces:** do NOT copy `remote-merge.ts`; no `mergeWithRemote`, no `/search/all` fan-out, no `remote*` knobs/schemas/env.
- **OSS `search-config.ts` divergence:** `RankConfig` omits `remoteRenormalize`/`remoteWeight`/`remoteHalfLifeDays` and `recencyDominance`; `defaultProfileName` falls back to **`v2`**.
- **`legacy` profile still reproduces old ranking** (the opt-out); but v2 is now the default — the release intentionally changes out-of-the-box ranking (covered by version bump + CHANGELOG).
- Test runner `bun test <file>`; tests import from `bun:test`. `bun run typecheck` must pass (note any pre-existing master typecheck errors at Task 1 and treat those as out of scope). No new runtime deps. TDD, frequent commits.

---

## File Structure

**Create:** `src/worker/search-config.ts` (OSS variant), `src/worker/temporal-intent.ts` (copy), `src/eval/{metrics,oracle,judge,golden,run,retry}.ts` (copy), `src/cli/commands/eval.ts` (copy), + tests.
**Copy (overwrite from federation):** `src/worker/search.ts`, `src/worker/rerank.ts`, `src/worker/recall-audit.ts`.
**Modify:** `src/worker/index.ts` (hand-port wiring), `src/cli/index.ts` (register `eval`), the 6 release files (Task 5).

---

## Task 1: OSS `search-config.ts`

**Files:**
- Create: `src/worker/search-config.ts`
- Test: `tests/unit/worker/search-config.test.ts`

**Interfaces:**
- Produces: `RankProfileName`, `FusionMode`, `RankConfig` (OSS shape), `RANK_PROFILES`, `defaultProfileName`, `resolveRankConfig`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/worker/search-config.test.ts
import { test, expect } from 'bun:test';
import { RANK_PROFILES, resolveRankConfig, defaultProfileName } from '../../../src/worker/search-config.ts';

test('legacy reproduces today\'s ranking (rrf 60/25, features off)', () => {
  const l = RANK_PROFILES.legacy;
  expect(l.fusionMode).toBe('rrf');
  expect(l.rrfK).toBe(60);
  expect(l.perStrategyTopK).toBe(25);
  expect(l.temporalIntent).toBe(false);
  expect(l.properNounBoost).toBe(false);
});

test('v2 = weighted + temporal + proper-noun', () => {
  const v = RANK_PROFILES.v2;
  expect(v.fusionMode).toBe('weighted');
  expect(v.vectorWeight).toBeCloseTo(0.7, 6);
  expect(v.keywordWeight).toBeCloseTo(0.3, 6);
  expect(v.temporalIntent).toBe(true);
  expect(v.properNounBoost).toBe(true);
  expect(v.temporalHalfLifeDays).toBe(7);
  expect(v.temporalTopN).toBe(10);
  expect(v.relevanceFloor).toBeCloseTo(0.6, 6);
  expect(v.properNounBoostWeight).toBeCloseTo(1.15, 6);
});

test('OSS default profile is v2 (ships better ranking out of the box)', () => {
  expect(defaultProfileName({})).toBe('v2');
  expect(defaultProfileName({ CAPTAIN_MEMO_RANK_PROFILE: 'legacy' })).toBe('legacy');
  expect(defaultProfileName({ CAPTAIN_MEMO_RANK_PROFILE: 'bogus' })).toBe('v2');
});

test('no remote/recencyDominance fields on RankConfig', () => {
  expect('remoteWeight' in RANK_PROFILES.v2).toBe(false);
  expect('recencyDominance' in RANK_PROFILES.v2).toBe(false);
});

test('env overrides apply', () => {
  const c = resolveRankConfig('legacy', { CAPTAIN_MEMO_RRF_K: '40', CAPTAIN_MEMO_TEMPORAL_INTENT: '1', CAPTAIN_MEMO_RELEVANCE_FLOOR: '0.5' });
  expect(c.rrfK).toBe(40);
  expect(c.temporalIntent).toBe(true);
  expect(c.relevanceFloor).toBeCloseTo(0.5, 6);
});
```

- [ ] **Step 2: Run test → FAIL** (`bun test tests/unit/worker/search-config.test.ts` — module not found).

- [ ] **Step 3: Write `src/worker/search-config.ts`**

```ts
// Central rank-profile config (OSS edition). Mirrors the loadXxxConfig pattern:
// a num()/bool() helper and a pure resolver. v2 is the OSS DEFAULT (ships the
// search-quality ranking out of the box); `legacy` reproduces the prior ranking.
export type RankProfileName = 'legacy' | 'v2';
export type FusionMode = 'rrf' | 'weighted';

export interface RankConfig {
  profile: RankProfileName;
  fusionMode: FusionMode;
  rrfK: number;
  perStrategyTopK: number;
  vectorWeight: number;
  keywordWeight: number;
  temporalIntent: boolean;
  properNounBoost: boolean;
  temporalHalfLifeDays: number; // recency half-life (days) for the temporal re-rank (0 = re-rank off)
  temporalTopN: number;         // candidate pool the temporal re-rank reorders
  relevanceFloor: number;       // fraction of top score a hit must reach to be recency-promotable
  properNounBoostWeight: number;// rare-token boost multiplier (1 = no-op)
}

const LEGACY: RankConfig = {
  profile: 'legacy',
  fusionMode: 'rrf',
  rrfK: 60,
  perStrategyTopK: 25,
  vectorWeight: 0.5,
  keywordWeight: 0.5,
  temporalIntent: false,
  properNounBoost: false,
  temporalHalfLifeDays: 0,
  temporalTopN: 0,
  relevanceFloor: 0,
  properNounBoostWeight: 1,
};

export const RANK_PROFILES: Record<RankProfileName, RankConfig> = {
  legacy: LEGACY,
  v2: {
    ...LEGACY,
    profile: 'v2',
    fusionMode: 'weighted',
    vectorWeight: 0.7,
    keywordWeight: 0.3,
    temporalIntent: true,
    properNounBoost: true,
    temporalHalfLifeDays: 7,
    temporalTopN: 10,
    relevanceFloor: 0.6,
    properNounBoostWeight: 1.15,
  },
};

function isProfileName(v: string | undefined): v is RankProfileName {
  return v === 'legacy' || v === 'v2';
}

/** OSS default = v2 (ships the better ranking). Set CAPTAIN_MEMO_RANK_PROFILE=legacy to opt out. */
export function defaultProfileName(env: Record<string, string | undefined>): RankProfileName {
  const v = env.CAPTAIN_MEMO_RANK_PROFILE;
  return isProfileName(v) ? v : 'v2';
}

export function resolveRankConfig(
  requestProfile: string | undefined,
  env: Record<string, string | undefined>,
): RankConfig {
  const num = (v: string | undefined, d: number): number => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
  };
  const bool = (v: string | undefined, d: boolean): boolean =>
    v === '1' ? true : v === '0' ? false : d;
  const name: RankProfileName = isProfileName(requestProfile) ? requestProfile : defaultProfileName(env);
  const base = RANK_PROFILES[name];
  const fm = env.CAPTAIN_MEMO_FUSION_MODE;
  return {
    ...base,
    rrfK: num(env.CAPTAIN_MEMO_RRF_K, base.rrfK),
    perStrategyTopK: num(env.CAPTAIN_MEMO_PER_STRATEGY_TOP_K, base.perStrategyTopK),
    fusionMode: fm === 'weighted' || fm === 'rrf' ? fm : base.fusionMode,
    vectorWeight: num(env.CAPTAIN_MEMO_VECTOR_WEIGHT, base.vectorWeight),
    keywordWeight: num(env.CAPTAIN_MEMO_KEYWORD_WEIGHT, base.keywordWeight),
    temporalIntent: bool(env.CAPTAIN_MEMO_TEMPORAL_INTENT, base.temporalIntent),
    properNounBoost: bool(env.CAPTAIN_MEMO_PROPER_NOUN_BOOST, base.properNounBoost),
    temporalHalfLifeDays: num(env.CAPTAIN_MEMO_TEMPORAL_HALF_LIFE_DAYS, base.temporalHalfLifeDays),
    temporalTopN: num(env.CAPTAIN_MEMO_TEMPORAL_TOP_N, base.temporalTopN),
    relevanceFloor: num(env.CAPTAIN_MEMO_RELEVANCE_FLOOR, base.relevanceFloor),
    properNounBoostWeight: num(env.CAPTAIN_MEMO_PROPER_NOUN_BOOST_WEIGHT, base.properNounBoostWeight),
  };
}
```

- [ ] **Step 4: Run test → PASS** (5 tests). Then `bun run typecheck` (record any pre-existing master errors as out-of-scope baseline).

- [ ] **Step 5: Commit**

```bash
git add src/worker/search-config.ts tests/unit/worker/search-config.test.ts
git commit -m "feat(search): OSS rank-profile config (v2 default; no remote fields)"
```

---

## Task 2: Port the local ranking modules

**Files:**
- Copy (overwrite): `src/worker/search.ts`, `src/worker/rerank.ts`, `src/worker/recall-audit.ts`
- Create: `src/worker/temporal-intent.ts`
- Copy tests: `tests/unit/worker/search.test.ts`, `tests/unit/worker/weighted-fusion.test.ts`, `tests/unit/worker/rerank.test.ts`, `tests/unit/worker/temporal-intent.test.ts`, `tests/unit/worker/recall-audit.test.ts`, `tests/unit/recall-audit.test.ts`

**Interfaces:** these modules are self-contained (search.ts/rerank.ts read config via plain opts, not RankConfig; temporal-intent.ts reads only surviving RankConfig fields).

- [ ] **Step 1: Copy the source modules from federation**

```bash
cd /home/kalin/projects/captain-memo
for f in src/worker/search.ts src/worker/rerank.ts src/worker/recall-audit.ts src/worker/temporal-intent.ts; do
  git show "federation:$f" > "$f"
done
```

- [ ] **Step 2: Copy the corresponding tests from federation**

```bash
for t in tests/unit/worker/search.test.ts tests/unit/worker/weighted-fusion.test.ts tests/unit/worker/rerank.test.ts tests/unit/worker/temporal-intent.test.ts tests/unit/worker/recall-audit.test.ts tests/unit/recall-audit.test.ts; do
  mkdir -p "$(dirname "$t")"; git show "federation:$t" > "$t"
done
```

- [ ] **Step 3: Adjust the temporal-intent test's `V2` fixture to the OSS RankConfig shape**

`tests/unit/worker/temporal-intent.test.ts` builds a literal `V2: RankConfig`. The federation version includes `remoteRenormalize`/`remoteWeight`/`remoteHalfLifeDays`/`recencyDominance` — REMOVE those four lines from that fixture object so it matches the OSS `RankConfig` (TypeScript will otherwise error on excess/missing properties). The fixture should contain exactly: `profile, fusionMode, rrfK, perStrategyTopK, vectorWeight, keywordWeight, temporalIntent, properNounBoost, temporalHalfLifeDays, temporalTopN, relevanceFloor, properNounBoostWeight`. Leave every test body unchanged.

- [ ] **Step 4: Run tests + typecheck**

Run: `bun test tests/unit/worker/search.test.ts tests/unit/worker/weighted-fusion.test.ts tests/unit/worker/rerank.test.ts tests/unit/worker/temporal-intent.test.ts tests/unit/worker/recall-audit.test.ts tests/unit/recall-audit.test.ts && bun run typecheck`
Expected: PASS. If typecheck flags the temporal-intent `V2` fixture for remote/recencyDominance fields, you missed Step 3 — fix and re-run. (If `recall-audit.test.ts` has a `SAMPLE_ENTRY` fixture, it must include `rank_profile` since the copied `recall-audit.ts` makes the field required — add `rank_profile: 'legacy'` if the copied test doesn't already.)

- [ ] **Step 5: Commit**

```bash
git add src/worker/search.ts src/worker/rerank.ts src/worker/recall-audit.ts src/worker/temporal-intent.ts tests/unit/worker/search.test.ts tests/unit/worker/weighted-fusion.test.ts tests/unit/worker/rerank.test.ts tests/unit/worker/temporal-intent.test.ts tests/unit/worker/recall-audit.test.ts tests/unit/recall-audit.test.ts
git commit -m "feat(search): port weighted fusion + rare-token boost + temporal re-rank + recall-audit field (local)"
```

---

## Task 3: Port the eval harness + CLI

**Files:**
- Create: `src/eval/metrics.ts`, `src/eval/oracle.ts`, `src/eval/judge.ts`, `src/eval/golden.ts`, `src/eval/run.ts`, `src/eval/retry.ts`, `src/cli/commands/eval.ts`
- Create tests: `tests/unit/eval/metrics.test.ts`, `tests/unit/eval/oracle.test.ts`, `tests/unit/eval/judge.test.ts`, `tests/unit/eval/golden.test.ts`, `tests/unit/eval/run.test.ts`, `tests/unit/eval/retry.test.ts`, `tests/fixtures/eval/golden.seed.jsonl`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Copy eval modules + CLI + tests + fixture from federation**

```bash
cd /home/kalin/projects/captain-memo
for f in src/eval/metrics.ts src/eval/oracle.ts src/eval/judge.ts src/eval/golden.ts src/eval/run.ts src/eval/retry.ts src/cli/commands/eval.ts \
         tests/unit/eval/metrics.test.ts tests/unit/eval/oracle.test.ts tests/unit/eval/judge.test.ts tests/unit/eval/golden.test.ts tests/unit/eval/run.test.ts tests/unit/eval/retry.test.ts \
         tests/fixtures/eval/golden.seed.jsonl; do
  mkdir -p "$(dirname "$f")"; git show "federation:$f" > "$f"
done
```

- [ ] **Step 2: Register the `eval` command in `src/cli/index.ts`**

Add the import alongside the other command imports:
```ts
import { evalCommand } from './commands/eval.ts';
```
Add a `case` in the dispatch switch (after `case 'dedup':`):
```ts
    case 'eval':
      exit = await evalCommand(args.slice(1));
      break;
```
Add a help line in the `HELP` template (after the `dedup` line):
```
  eval         Run the search-quality eval harness (seed | run --profile=legacy,v2)
```

- [ ] **Step 3: Run eval tests + typecheck**

Run: `bun test tests/unit/eval/ && bun run typecheck`
Expected: PASS (the eval modules are edition-agnostic; they call the worker over HTTP and don't import `RankConfig`).

- [ ] **Step 4: Commit**

```bash
git add src/eval tests/unit/eval tests/fixtures/eval/golden.seed.jsonl src/cli/commands/eval.ts src/cli/index.ts
git commit -m "feat(eval): port eval harness + captain-memo eval CLI to OSS"
```

---

## Task 4: Hand-port the `index.ts` wiring (local-only)

**Files:** Modify `src/worker/index.ts`.

**Interfaces:** consumes `resolveRankConfig`/`RankConfig` (Task 1), `applyTemporalRerank` (Task 2). Mirrors the federation wiring MINUS remote-merge and MINUS the inbox block (OSS `index.ts` has neither).

- [ ] **Step 1: Add imports**

Near the other worker imports (the `writeRecallAuditLine` import already exists at ~line 63):
```ts
import { resolveRankConfig, type RankConfig } from './search-config.ts';
import { applyTemporalRerank } from './temporal-intent.ts';
```

- [ ] **Step 2: Add `rank_profile` to the five schemas**

Append `rank_profile: z.enum(['legacy', 'v2']).optional(),` inside each of: `SearchRequestSchema` (163-167), `MemorySearchSchema` (169-174), `SkillSearchSchema` (176-180), `ObservationSearchSchema` (182-189), `InjectContextSchema` (235-242).

- [ ] **Step 3: Thread config through the search helpers**

`searchWithRecency` (1018) — add a `config: RankConfig` param and forward the knobs:
```ts
  const searchWithRecency = async (embedding: number[], query: string, k: number, config: RankConfig) => {
    const branchBoostEnabled = process.env.CAPTAIN_MEMO_BRANCH_BOOST !== '0';
    const currentBranch = branchBoostEnabled ? detectBranchSyncCached(process.cwd()) : null;
    const raw = await searcher.search(embedding, query, k, {
      currentBranch,
      rrfK: config.rrfK,
      perStrategyTopK: config.perStrategyTopK,
      fusionMode: config.fusionMode,
      vectorWeight: config.vectorWeight,
      keywordWeight: config.keywordWeight,
      properNounBoost: config.properNounBoost,
      properNounBoostWeight: config.properNounBoostWeight,
    });
    return tideConfig.enabled ? raw : applyRecencyDecay(raw);
  };
```
`searchByChannel` (1027) — add a trailing `config: RankConfig` param; change its internal call to `searchWithRecency(embedding, query, candidatePool, config)`.
`localSearchAll` (1156) — add a trailing `config: RankConfig` param; change its internal call to `searchWithRecency(embedding, query, topK, config)`.

- [ ] **Step 4: Resolve config + apply temporal re-rank in each handler**

`POST /search/all` (1346) — replace the body so it resolves cfg, passes it down, and re-ranks (no remote):
```ts
        const { query, top_k } = parsed.data;
        const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);
        const visible = applyTemporalRerank(await localSearchAll(query, top_k, cfg), query, cfg, Date.now());
        const by_channel: Record<string, number> = {};
        for (const r of visible) by_channel[r.channel] = (by_channel[r.channel] ?? 0) + 1;
        bumpRetrievalFromResults(visible, 'search');
        return Response.json({ results: visible, by_channel });
```
`POST /search/memory` (1358), `POST /search/skill` (1373), `POST /search/observations` (1385) — in each, resolve `const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);` and wrap the results:
```ts
        const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);
        const results = applyTemporalRerank(
          dropArchived(await searchByChannel(parsed.data.query, /*channel*/, parsed.data.top_k, filters, cfg)),
          parsed.data.query, cfg, Date.now(),
        );
```
(Use each handler's existing channel literal `'memory'`/`'skill'`/`'observation'`. Keep the `bumpRetrievalFromResults(results, 'search')` + `return Response.json({ results })` lines.)

`POST /inject/context` (1633) — after `const trimmed = parsed.data.prompt.trim();`, resolve `const cfg = resolveRankConfig(parsed.data.rank_profile, process.env);`. Change the `searchWithRecency(embedding, trimmed, parsed.data.top_k * 3)` call to pass `cfg`. Change the hits assembly line (`const hits = dropSunkForAutoInject(dropArchived(candidates)).slice(0, parsed.data.top_k);`) to wrap with the re-rank:
```ts
        const hits = applyTemporalRerank(
          dropSunkForAutoInject(dropArchived(candidates)).slice(0, parsed.data.top_k),
          trimmed, cfg, Date.now(),
        );
```

- [ ] **Step 5: Tag recall-audit with `rank_profile`**

In the inject recall-audit `writeRecallAuditLine({...})` object (1710), add `rank_profile: cfg.profile,` (the copied `recall-audit.ts` makes the field required). Also extend the local `BoostedProvenance` type in that block to include `rareToken?: number` so a rare-token boost shows in the audit:
```ts
          type BoostedProvenance = { identifier?: number; branch?: number; rareToken?: number } | undefined;
```

- [ ] **Step 6: Run the full worker suite + typecheck**

Run: `bun test tests/unit/worker/ tests/unit/recall-audit.test.ts && bun run typecheck`
Expected: PASS. Verify no handler still calls the old arities of `searchWithRecency`/`searchByChannel`/`localSearchAll`. (Legacy profile reproduces old ranking; v2 — now the default — applies the new path.)

- [ ] **Step 7: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat(search): wire rank profiles + temporal re-rank into OSS handlers (local-only)"
```

---

## Task 5: Release (version bump + CHANGELOG + bundle rebuild)

**Files:** `package.json`, `plugin.json` (or `.claude-plugin/plugin.json`), `marketplace.json` (or `.claude-plugin/marketplace.json`), `CHANGELOG.md`, `plugin/dist/mcp-server.js`, `plugin/dist/captain-memo-hook.js`.

- [ ] **Step 1: Confirm the version files + current version**

```bash
cd /home/kalin/projects/captain-memo
grep -RnE '"version"' package.json .claude-plugin/*.json plugin.json marketplace.json 2>/dev/null | head
```
Note the current `master` version (`0.11.2`).

- [ ] **Step 2: Bump the version in all manifests**

Set the new version (a minor bump — `0.12.0` unless the OSS version line dictates otherwise) in every manifest that carries one (`package.json`, the plugin manifest, the marketplace manifest). Use the SAME string in all of them (the `plugin-manifest.test.ts` asserts parity).

- [ ] **Step 3: Add the CHANGELOG entry**

Prepend a dated entry to `CHANGELOG.md`:
```
## <new version> — search quality

- Hybrid search now blends real cosine + BM25 (weighted fusion), with temporal-intent
  detection that surfaces the newest fact for "latest/current/last …" queries, plus a
  proper-noun boost for rare named entities. Enabled by default (the new `v2` rank
  profile). Set `CAPTAIN_MEMO_RANK_PROFILE=legacy` to restore the prior ranking.
- New `captain-memo eval` harness (freshness oracle + optional LLM judge) for measuring
  ranking quality against a golden query set.
```

- [ ] **Step 4: Rebuild the committed plugin bundles**

Run: `bun run build:plugin`
(This regenerates `plugin/dist/mcp-server.js` + `plugin/dist/captain-memo-hook.js` so they embed the new version — the `plugin-manifest.test.ts` "committed bundle embeds current version" check passes.)

- [ ] **Step 5: Full verification**

Run: `bun test && bun run typecheck`
Expected: full suite green (including `plugin-manifest.test.ts` parity + bundle-freshness). Investigate any failure before committing.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "release: <new version> — search quality (weighted fusion + temporal intent + proper-noun boost; v2 default)"
```

- [ ] **Step 7: (Human) merge + publish**

Merging `feat/search-quality-oss` into `master` and publishing to the marketplace is the human's action after review.

---

## Self-Review

**Spec coverage (vs `2026-06-18-p-oss-search-quality-backport-design.md`):**
- §2 ports (weighted fusion, rare-token, rank_profile field, temporal intent, config, eval, index wiring) → Tasks 1–4 ✓; excluded remote pieces never referenced ✓
- §3 port mechanism (clean copy + new + hand-port) → Task 2/3 copy, Task 1 new, Task 4 hand-port ✓
- §4 OSS search-config (no remote/recencyDominance; default v2) → Task 1 ✓
- §5 decomposition → Tasks 1–5 ✓
- §5 release ritual (6 files + bundle rebuild + manifest tests) → Task 5 ✓

**Placeholder scan:** none. `git show federation:<path>` is the complete copy instruction (content is verbatim in federation). Task 4 Step 4's `/*channel*/` is an explicit substitute-the-literal instruction (per handler), not a missing-logic placeholder.

**Type consistency:** OSS `RankConfig` (Task 1) is consumed by `searchWithRecency`/`localSearchAll`/`searchByChannel` (Task 4) and by the copied `temporal-intent.ts` (Task 2, reads only surviving fields). `applyTemporalRerank` generic covers `Hit` and `EnvelopeHit`. The copied `search.ts`/`rerank.ts` read config via `search()` opts (`fusionMode`/`vectorWeight`/`keywordWeight`/`properNounBoost`/`properNounBoostWeight`/`rrfK`/`perStrategyTopK`), all forwarded in Task 4 Step 3 — names match.
