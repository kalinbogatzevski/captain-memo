# Recency-aware ranking (gentle temporal blend)

**Date:** 2026-07-11
**Status:** Design — awaiting review
**Editions:** OSS (`master`) **and** federation (`federation`)
**Owner ask:** blend a recency signal into `/search/all` ranking so fresh observations
outrank stale ones for "current/latest" moving facts, as a *gentle tiebreaker* that
never buries a genuinely-relevant older fact.

---

## 1. Problem

For a *moving* fact ("what is the current TalQ release?"), an outdated observation can
tie or outrank the correct fresh one, because observations are an append-only log and a
stale snapshot ("current stable 0.58.3") is semantically ~identical to the fresh one
("current stable 0.60.1"). Ranking needs a recency signal that gently favours fresher
entries at near-ties without letting recency dominate relevance.

## 2. Verified current state (what already exists)

Investigation (6-agent read of both trees) found the feature is ~70–80% already built.
There are **three** local recency mechanisms plus one federation-only:

| Mechanism | Shape | Channel-aware | When | Default | File |
|---|---|---|---|---|---|
| `applyRecencyDecay` | `score *= exp(-ln2·age/hl)` | observation-only; missing-ts → ×1 | retrieval; **inert when Tide on** | 90d | `index.ts:1064` |
| **Tide** (active) | `score *= B0+(1-B0)·buoyancy` power-law, bounded [0.30,1] | per-channel S0 {obs 7, mem 60, skill 180}; obs-only | retrieval; **ON** | on | `tide.ts` |
| **`applyTemporalRerank`** | **recency-DOMINANT reorder** (sort by recency key) | undated → key 0 (sinks memory below fresh obs) | **merge/re-rank step** (correct seam); pure + unit-tested | 7d; **ON in `v2`, OFF in `federated`** | `temporal-intent.ts` |
| `applyRemoteRenorm` (fed) | `score *= exp(-ln2·age/hl)` on peer `created_at` | remote-only | merge | 30d | `remote-merge.ts` |

Key facts driving the design:

- `temporal-intent.ts` is **byte-identical** between editions. Only `search-config.ts`
  diverges (fed adds the `federated` profile + remote/dead knobs and flips the default
  profile to `federated`).
- **The user's runtime = federation worker → `federated` profile → `temporalIntent:false`**,
  so the merge-step recency currently **does not fire at all** there. That is why the live
  repro shows stale (1.16) ≈ fresh (1.18) *interleaved* rather than reordered. Only Tide's
  always-on gentle power-law is acting, and it cannot separate near-identical text.
- On `v2` (OSS default) `applyTemporalRerank` **does** fire, but as a **recency-dominant
  reorder** — the exact "recency dominates / buries relevant older facts" behaviour the
  request says to avoid. Its two tests (`temporal-intent.test.ts:41`, `:61`) *encode* that
  behaviour and their comments show a gentle blend was previously **deliberately replaced**
  by recency-primary. This design reverses that decision, consciously (see Risks §7).
- Observation chunks carry `metadata.created_at_epoch`; memory/skill chunks do **not**
  (they are undated at the merge step). Channel is on `hit.channel`.

## 3. Design

Rewrite `applyTemporalRerank` from a recency-**dominant reorder** into a gentle,
**bounded multiplicative blend**, then sort by the blended score. Keep it query-gated on
temporal intent (Tide stays the always-on baseline). Pure, deterministic, `nowMs`-injected —
same signature, so the existing test harness is reused.

### 3.1 Scoring rule

For each hit:

```
recencyFactor(hit) =
  1                                             if channel !== 'observation'   (memory/skill/remote exempt)
  1                                             if half-life <= 0 OR no created_at_epoch OR age <= 0  (neutral)
  floor + (1 - floor) * exp(-ln2 * ageDays / hl)   otherwise, bounded in [floor, 1]

final = hit.score * recencyFactor(hit)
```

Then `sort((a,b) => b.final - a.final || a.origIndex - b.origIndex)` (stable).

- **Bounded floor** is what makes it *gentle*: a maximally-stale observation keeps `≥ floor`
  of its relevance, so it is demoted but never zeroed. A fresh hit (factor ≈1) overtakes an
  older one only if its base relevance exceeds `floor ×` the older one's — i.e. recency
  reorders near-ties, never buries a much-more-relevant older fact.
- **Gate** (unchanged intent): no-op unless `cfg.temporalIntent && hits.length > 1 &&
  detectTemporalIntent(query)`. The `temporalHalfLifeDays <= 0` clause is dropped from the
  gate (a 0 half-life now yields factor 1 naturally, per-channel).
- **Blend window:** keep `temporalTopN` — blend/sort the top-N, leave the tail untouched
  (matches "recency mainly reorders near-ties").
- The function **mutates `score` to the blended value** (consistent with sibling
  `applyRecencyDecay` / `applyRemoteRenorm`), so returned results show the score they were
  actually ranked by.

### 3.2 Channel model

- **observation** → decays with half-life `temporalHalfLifeDays`.
- **memory / skill / remote** → exempt (factor 1.0), so curated references are protected
  and can rank at or above fresh observations. This mirrors the existing observation-only
  gate in `applyRecencyDecay` (`index.ts:1071`) — reuse the established convention rather
  than invent a per-channel map. Per-channel *rates* are a trivial follow-up if ever needed
  (YAGNI now; the request's concrete ask is "observation decays, memory little/none,
  skill none").

### 3.3 Config (reuse the existing 4-point pattern in `search-config.ts`)

- **Reuse `temporalHalfLifeDays`** (already wired in both editions) as the observation
  recency half-life. New default **21d** (was 7d) — mid of the requested 14–30d range.
- **Add `temporalFloor`** (bounded-multiplier floor), env `CAPTAIN_MEMO_TEMPORAL_FLOOR`,
  default **0.5**. This is the "gentleness / weight" knob you asked to confirm. Lower =
  sharper (more recency-dominant); higher = gentler; 1.0 = recency off.
- Keep `temporalTopN` (blend window, default 10).
- `relevanceFloor` is no longer consumed by this path → mark deprecated in a comment; leave
  the field (pre-existing; avoids churning `search-config.test.ts`).

Per profile:

| Profile | temporalIntent | temporalHalfLifeDays | temporalFloor | Net |
|---|---|---|---|---|
| `legacy` | false | 0 | 1 | byte-identical, frozen (gate off) |
| `v2` (OSS default) | true | **21** (was 7) | **0.5** | gentle blend replaces the dominant reorder |
| `federated` (fed default) | **true** (was false) | **21** (was 0) | **0.5** | **feature turns ON for the fed runtime** |

**Confirmed defaults (owner said "go"):** half-life **21d**, floor **0.5**, memory/skill
**exempt**, **query-gated** (not always-on), scope **recency-only** this change.

### 3.4 Interaction with Tide (intentional, no reconciliation code)

Tide (always-on, power-law, floor 0.30, obs-only) stays the baseline; the temporal blend
adds *extra* freshness pressure **only on "current/latest" queries**. On a temporal query
both apply to observations → compound floor 0.30×0.5 = 0.15 worst case (a very stale obs on
a temporal query keeps ≥15% of its relevance — acceptable and on-intent). memory/skill are
×1 in **both**, so curated stays protected. Non-temporal queries: blend does not fire →
older relevant facts fully protected (this gating *is* the "don't bury older facts"
guarantee for the general case). `applyRecencyDecay` remains inert while Tide is on — no
double-decay to reconcile, no code change there.

## 4. Files to change (both editions)

`temporal-intent.ts` is identical across branches → same rewrite in
`/home/kalin/projects/captain-memo` (master) and `/home/kalin/projects/captain-memo-fed`
(federation). `search-config.ts` differs → per-branch profile/env edits.

1. **`src/worker/temporal-intent.ts`** (both): rewrite `applyTemporalRerank` per §3.1–3.2.
   Update the module header comment (no longer "recency-dominant").
2. **`src/worker/search-config.ts`** (both): add `temporalFloor` field + `LEGACY` default (1)
   + `v2`/`federated` overrides (0.5) + env resolve `CAPTAIN_MEMO_TEMPORAL_FLOOR`; bump
   `temporalHalfLifeDays` to 21 in `v2` (+ `federated`); set `federated.temporalIntent = true`.
   Deprecation comment on `relevanceFloor`. (Fed's dead `recencyHalfLifeDays` /
   `recencyDominance` become redundant — leave for a separate cleanup, out of scope here.)
3. **`tests/unit/worker/temporal-intent.test.ts`** (both): update the `V2` literal
   (`temporalHalfLifeDays: 21`, add `temporalFloor: 0.5`); **replace** the two tests that
   encode the old dominant behaviour with their new correct expectations:
   - `:41` "undated memory sinks beneath a dated observation" → memory (exempt) now ranks
     **at/above** a fresh observation of equal-or-lower relevance.
   - `:61` "absolute freshest wins over higher-score" → the **higher-relevance** hit now
     wins the near-tie (gentle blend). Keep `:29`, `:35` (they still pass under the blend —
     a 120-day-old hit is many half-lives down).
   - Add the acceptance test (§6).
4. **`search-config.test.ts`** (both, if present): update the `federated` invariant
   assertion — federated local ranking now changes **for temporal-intent queries only**;
   non-temporal queries remain legacy-identical (relaxation is intentional, see §7).

## 5. Where it applies (unchanged seam)

All existing `applyTemporalRerank` call sites, uniformly: `/search/all`, `/search/memory`,
`/search/skill`, `/search/observations`, and auto-inject/envelope (index.ts ~1526/1540/1559/
1590/1889 on master; ~1871/1892/1912/1944/2296 on fed, after `mergeWithRemote`). No new call
sites; recency is applied at the merge/re-rank step after per-channel retrieval, as required.

## 6. Acceptance test (pure unit test, deterministic)

In `temporal-intent.test.ts`, reusing the `hit(id, score, ageDays)` factory + fixed `NOW`
+ the resolved profile (`temporalHalfLifeDays: 21`, `temporalFloor: 0.5`, `temporalIntent:
true`, `temporalTopN: 10`):

```
seed:
  hit('obs-0601', 0.90,   1)                        // fresh 0.60.1 observation
  hit('obs-0583', 0.95, 220)                        // STALE 0.58.3, HIGHER raw score
  hit('obs-0521', 0.90, 400)                        // stale 0.52.x
  hit('obs-0481', 0.90, 600)                        // stale 0.48.x
  { ...hit('mem-0601', 0.90, null), channel:'memory' }  // curated reference (undated → exempt)
query 'what is the current TalQ release'   // matches TEMPORAL_RE

assert: rank(obs-0601) and rank(mem-0601) are strictly above rank(obs-0583),
        rank(obs-0521), rank(obs-0481).
```

Hand-computed (hl=21, floor=0.5): mem-0601 = 0.90 (×1), obs-0601 = 0.885, obs-0583 = 0.475,
obs-0521/0481 ≈ 0.45 → both 0.60.1 entries strictly above all stale. The test discriminates:
it fails if the blend is still recency-dominant (memory sinks) OR if floor=1 (0.95 stale
beats 0.90 fresh).

**Live repro (verify phase):** after deploying to the fed clone's worker, re-run
`search_all("what is the current TalQ release")` and confirm the 0.58.x/0.52.x/0.48.x
observations drop below the fresh 0.60.1 + curated reference.

## 7. Risks & tradeoffs

- **Deliberate reversal of a prior decision.** The codebase previously moved *from* a blend
  *to* recency-primary (test `:61` comment). We are reverting to a (bounded) blend because
  the owner wants a gentle tiebreaker. Tradeoff: for a "latest X" query where the newest
  entry is *slightly less* textually relevant, it will **not** be forced to #1 unless its
  relevance exceeds `floor ×` the older one's. Mitigation: `temporalFloor` is the tuning
  knob (lower → sharper). Default 0.5 is the compromise.
- **`federated` invariant relaxed.** The fed header advertises "federated == byte-identical
  legacy LOCAL ranking." After this, federated local ranking changes **for temporal-intent
  queries** (the whole point — the feature must work on the fed runtime). Non-temporal
  queries stay legacy-identical. The invariant test is updated to reflect this.
- **Re-minted stale facts are NOT fixed by recency.** Repro row #4 ("Retrieved current
  stable 0.58.3", re-minted this session) has a **fresh `created_at`** → any created_at-based
  recency (this feature) and Tide's `last_surfaced_at` both treat it as fresh. The genuine
  fix is **version supersession** (0.60.1 supersedes 0.58.3), which exists (`supersede.ts`)
  but is off by default and semver-title-only. **Out of scope** here (owner chose recency-only);
  tracked as follow-up. This change cleanly fixes the genuinely-old 0.52.x/0.48.x rows.

## 8. Out of scope (follow-ups)

- Topic-dedupe / supersession for re-minted duplicates (the real fix for row #4).
- Per-channel *decay rates* for memory/skill (currently exempt).
- Retention/compaction of the observation log (Tide tiering already exists, off by default).
- Removing fed's now-redundant dead knobs (`recencyHalfLifeDays`, `recencyDominance`).
