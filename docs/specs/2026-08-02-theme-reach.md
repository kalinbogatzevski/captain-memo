# Theme reach — why 124k observations yield ~14 clusters, and what would change it

**Status:** Measured. One fix shipped, one ceiling documented, one design open.
**Date:** 2026-08-02
**Prompted by:** "it is impossible for me to have only 4 themes on this captain" — correct.

---

## 1. The threshold was wrong (fixed)

`themeMinMembers` was 3, set by analogy to the fold path, whose comment reads *"two is a pair,
not a theme — summarising it costs a model call to restate what the higher-count row already
says."*

That reasoning does not transfer. In a **fold**, the survivor already states the fact, so a pair
is redundant. A **theme** is about the opposite thing: the same standing fact learned in session
A and *again* in session B weeks later. Two separate learning events is the phenomenon, not a
weak instance of it.

Measured on the same 13,835-row population, everything else held constant:

| `themeMinMembers` | candidate clusters |
|---|---|
| 3 | 4 |
| **2** | **14** |

Shipped as the new default. The judge remains the real gate and declines most of what it sees,
so the cost of looking at more is bounded.

## 2. What is NOT the limiter

Two hypotheses tested and rejected, both cheaply:

| gate | clusters | verdict |
|---|---|---|
| recency window 5,000 → 13,826 (whole surfaced set) | 4 → 4 | **not binding** |
| co-retrieval requirement removed entirely | 4 → 4 | **not binding** |

The co-retrieval result is worth keeping in mind: it costs nothing in reach on this corpus, so it
is pure precision gain. The window result means enlarging it is pointless on its own.

## 3. The real ceiling: themes see 11% of the corpus

`themeCandidateRows` filters to **surfaced** rows — those retrieved at least once.

```
live observations   124,799
surfaced             13,835   (11.1%)
```

110,964 observations are structurally invisible to the theme pass. And the rationale was wrong in
the same way it was wrong for supersede, where it was already caught and corrected:

> *"a stale fact that has never surfaced is exactly the one that ambushes you the day it finally
> does. On a real corpus the surfaced filter left 11.7% of rows reachable."*
> — `versionCandidateRows`, written earlier the same day

A fact **learned** three times is not the same as a fact **retrieved** three times. Themes want
repeated learning; the surfaced filter selects for repeated retrieval.

## 4. But removing it naively is not affordable

Clustering is all-pairs within each (project, branch) partition. On the full live corpus:

```
124,841 rows · 315 partitions · 1,339,804,978 in-partition pairs
  erp-platform/master alone:  48,556 rows -> 1,178,818,290 pairs
```

At the measured throughput (15.1M pairs in 33 s ≈ 460k pairs/s) that is **~48 minutes of dot
products per pass**, single-threaded — unviable as a background job and absurd against the 30 s
forced tick. The surfaced filter is therefore load-bearing today even though its stated reason
was wrong.

## 5. The open design: stop comparing all pairs

The fix is not to widen the filter but to drop the quadratic. For each candidate row, ask the
vector index for its k nearest neighbours instead of comparing it against every sibling:

- ~124k index queries instead of ~1.34bn dot products — roughly linear in corpus size.
- `src/worker/ivf.ts` already implements clustered vector search (`CAPTAIN_MEMO_IVF_*`,
  `minCorpusSize: 3000`, `probeClusters: 8`). It is **off by default** and this corpus is 141,243
  chunks — well past the threshold at which it pays.
- The grouping logic itself is unchanged: seed-anchored, scope-partitioned, guard-checked. Only
  neighbour *discovery* changes.

Until that lands, themes see the surfaced 11%, and the honest framing on the panel and in the
docs should say so rather than implying whole-corpus coverage.

## 5b. The k-NN route was attempted and is blocked on the index build (2026-08-02)

Measured on the live install rather than reasoned about:

| step | result |
|---|---|
| one `k=20` vector query, no centroids | **615 ms** (brute-forces all 143,231 vectors) |
| therefore 124,800 queries | ~21 hours — **worse** than all-pairs |
| centroids present? | **zero** — IVF has never run on this corpus |

So k-NN is not an alternative to the index; it *requires* it. Enabling
`CAPTAIN_MEMO_IVF_ENABLED=1` bootstraps correctly — 477 centroids for 143k vectors at
`targetPerCluster: 300` — but assignment then runs at:

```
256 rows per ~2 minutes, one CPU core pinned at 99%
-> ~18 hours to assign 143,253 vectors
```

`reassignCluster` performs one delete + insert per row against a partitioned `vec0` table, so the
cost is per-row rather than per-batch. That is the blocker, and it is in the vector store, not in
the theme pass.

**Turned back off** on this install. The partial state is harmless: `queryClustered` always
appends `UNCLUSTERED` to the probe list, so the 99.6% of vectors still in cluster `-1` remain
searchable. Verified after reverting — `/search/observations` returns correct hits in 1.6 s.

The work, in order:

1. **Batch `reassignCluster`.** One transaction per sweep slice instead of per row. Until this
   lands, the index cannot be built on a corpus this size.
2. Then k-NN, or better: group candidates by `cluster_id` and run all-pairs *within* each cluster
   (~300 vectors each), which is ~21M comparisons for the whole corpus instead of 1.34bn.
3. Only then does the surfaced filter come off.

## 6. Corrections this supersedes

- The claim that 4 clusters reflected a clean corpus. It reflected `minMembers: 3`.
- The claim that the recency window was the limiter (§2 — it is not).
- `themeCandidateRows`' doc comment implies it sees the corpus; it sees the surfaced ninth of it.
- §5's "the fix is k-NN against the vector index" was too quick. k-NN needs centroids, centroids
  need an 18-hour build, and the build needs batched reassignment first. The order matters.
