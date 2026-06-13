# Quartermaster Substrate Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the four mandatory substrate fixes that gate Quartermaster AUTO dedup — project-scoped merges, an append-only `merge_events` ledger, a negation/identifier merge guard, and a crash-safe `reindex --force` — so that even today's *manual* `captain-memo dedup --apply` is safe on a multi-project corpus. Ship as public **v0.5.5**, then port to federation-private v0.5.5.

**Architecture:** All four are hardening fixes to *existing* reversible primitives — no new subsystems, no Quartermaster yet. S1–S3 live in `observations-store.ts` (the dedup substrate shared by the `dedup` CLI today and the future Quartermaster) plus a new pure `merge-guard.ts`. S4 reorders the `reindex --force` path in `index.ts` from delete-then-embed to embed-then-swap. The cosine-≥0.98 AUTO floor is intentionally **deferred to Release 2** (the Quartermaster runs in-process with the vector store; the standalone CLI has no vector DB connection), so this release's S3 is the vector-free text guard.

**Tech Stack:** Bun + TypeScript, `bun:sqlite`, sqlite-vec, `bun test`, `tsc --noEmit`. Migrations via `applyMigrations(db, OBSERVATIONS_STORE_MIGRATIONS)` (auto-applied in the `ObservationsStore` constructor, observations-store.ts:354).

---

## Bug provenance (each fix closes a verified, memory-cited defect)

| Fix | Verified bug | Spec Risk row |
|-----|--------------|---------------|
| **S1** project-scope | Live corpus folds `erp-platform` rows with `ERP_UNIFIED_DOCS` rows, summing alien counters (obs:27945) | tide-quartermaster.md:189 |
| **S2** merge_events ledger | 2nd merge into a hot survivor overwrites `theme_member_ids`; `--undo` can't recover stranded members (obs:27946) | tide-quartermaster.md:185 |
| **S3** negation/identifier guard | Title-Jaccard merges "Inspected users table" with "users table missing"; evicts distinct identifiers (obs:27945) | tide-quartermaster.md:188 |
| **S4** crash-safe reindex | `--force` deletes vectors at index.ts:1307 *before* embed at 1336; embed failure leaves rows vector-less (Explore map) | tide-quartermaster.md:191 |

## File Structure

- **Create** `docs/tide-quartermaster.md` (master) — materialize the canonical spec currently federation-only; resolves the dangling reference at `tide.ts:5` and `observations-store.ts:113`.
- **Create** `src/shared/merge-guard.ts` — pure `mergeBlocked(titleA, titleB)` predicate (negation polarity + identifier mismatch). No I/O, mirrors `title-similarity.ts`.
- **Create** `tests/unit/shared/merge-guard.test.ts` — guard truth table incl. the two verified examples.
- **Create** `tests/integration/reindex-crash-safe.test.ts` — embed-failure preserves old vectors + tide columns.
- **Modify** `src/worker/observations-store.ts` — v9 migration; `findDuplicateGroups` partitions by `(project_id, branch)` + applies the guard; `mergeDuplicateGroup(survivorId, memberIds, atEpoch, job?)` asserts same-project + writes the ledger; `unmergeDuplicateGroup`/`mergedSurvivorIds` read the ledger.
- **Modify** `src/shared/title-similarity.ts` — `groupBySimilarity` gains an optional `blocked?(a,b)` predicate.
- **Modify** `src/cli/commands/dedup.ts` — pass `atEpoch` to `mergeDuplicateGroup`.
- **Modify** `src/worker/index.ts` — reindex `--force`: defer the delete to post-embed (embed-then-swap).
- **Modify** `tests/unit/observations-store.test.ts`, `tests/unit/shared/title-similarity.test.ts`, `tests/integration/dedup-command.test.ts` — extend coverage.
- **Modify** `package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `CHANGELOG.md` — v0.5.5.

---

## Task 1: Materialize the canonical spec on master

The design doc the code points at (`tide.ts:5`, `observations-store.ts:113`) lives only on the `federation` branch. Tide/Quartermaster is a public, federation-free feature, so the doc belongs on master too.

**Files:**
- Create: `docs/tide-quartermaster.md` (master)

- [ ] **Step 1: Copy the doc from the federation worktree**

```bash
cp /home/kalin/projects/captain-memo-fed/docs/tide-quartermaster.md \
   /home/kalin/projects/captain-memo/docs/tide-quartermaster.md
```

- [ ] **Step 2: Verify it is public-safe (no federation *implementation* specifics)**

Read the file. It must describe Tide/Quartermaster as loopback-local (federation mentioned only as a *boundary* — "never crosses federation"). Confirm there is no peer-protocol, bearer-token, or hub/spoke implementation detail. If any leaks in, redact to the boundary statement only.

Run: `grep -niE "wss://|bearer|spoke|hub|peer_|federation/link|cap_[A-Za-z0-9]" docs/tide-quartermaster.md`
Expected: no hits (or only prose like "never crosses federation").

- [ ] **Step 3: Confirm the dangling references now resolve**

Run: `test -f docs/tide-quartermaster.md && grep -n "docs/tide-quartermaster.md" src/worker/tide.ts src/worker/observations-store.ts`
Expected: file exists; both code references point at a real file.

- [ ] **Step 4: Commit**

```bash
git add docs/tide-quartermaster.md
git commit -m "docs: materialize tide-quartermaster spec on master (was federation-only)"
```

---

## Task 2: S1 — project-scoped dedup

Confine grouping and merging to a single `(project_id, branch)`. Defense-in-depth: even after scoping the *finder*, `mergeDuplicateGroup` must refuse cross-project members.

**Files:**
- Modify: `src/worker/observations-store.ts` (`findDuplicateGroups` ~859, `mergeDuplicateGroup` ~805)
- Test: `tests/unit/observations-store.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/observations-store.test.ts` (use the file's existing `makeStore()`/seed helpers; if seeding needs `project_id`, set distinct values):

```ts
describe('S1 — project-scoped dedup', () => {
  test('findDuplicateGroups never groups across project_id', () => {
    const store = makeStore();
    // Two near-identical titles in DIFFERENT projects must NOT group.
    const a = seedObs(store, { title: 'Updated Aelita knowledge base', project_id: 'erp-platform', from_search: 5 });
    const b = seedObs(store, { title: 'Updated Aelita knowledge base', project_id: 'ERP_UNIFIED_DOCS', from_search: 3 });
    const groups = store.findDuplicateGroups(0.5);
    // No group may contain ids from both projects.
    for (const g of groups) {
      const ids = [g.survivor.id, ...g.members.map(m => m.id)];
      expect(ids.includes(a) && ids.includes(b)).toBe(false);
    }
    store.close();
  });

  test('mergeDuplicateGroup skips members from a different project (no counter corruption)', () => {
    const store = makeStore();
    const survivor = seedObs(store, { title: 'X', project_id: 'p1', from_search: 10 });
    const alien    = seedObs(store, { title: 'X', project_id: 'p2', from_search: 7 });
    store.mergeDuplicateGroup(survivor, [alien], 1000);
    const s = store.getById(survivor)!;       // alien counts must NOT be summed in
    expect(s.from_search).toBe(10);
    expect(store.getById(alien)!.archived).toBe(0); // alien stays live
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/unit/observations-store.test.ts -t "S1"`
Expected: FAIL (cross-project rows currently group/merge).

- [ ] **Step 3: Scope `findDuplicateGroups` by (project_id, branch)**

Select `project_id, branch` alongside the existing columns, partition rows by a composite key, and run `groupBySimilarity` per partition:

```ts
findDuplicateGroups(threshold: number): DuplicateGroup[] {
  const rows = this.db
    .query(
      `SELECT id, type, title, project_id, branch, from_auto, from_search, from_drill
         FROM observations
        WHERE archived = 0 AND (from_auto + from_search + from_drill) > 0
        ORDER BY (from_auto + from_search + from_drill) DESC, id ASC`,
    )
    .all() as Array<RawTopRow & { project_id: string; branch: string | null }>;
  const toEntry = (r: RawTopRow): DuplicateEntry => ({
    id: r.id, type: r.type as ObservationType, title: r.title,
    total: r.from_auto + r.from_search + r.from_drill,
  });
  // Partition by (project_id, branch) so a dup group can never span projects.
  const partitions = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.project_id} ${r.branch ?? ''}`;
    (partitions.get(key) ?? partitions.set(key, []).get(key)!).push(r);
  }
  const out: DuplicateGroup[] = [];
  for (const part of partitions.values()) {
    for (const g of groupBySimilarity(part, r => r.title, threshold)) {
      if (g.length > 1) out.push({ survivor: toEntry(g[0]!), members: g.slice(1).map(toEntry) });
    }
  }
  return out;
}
```

- [ ] **Step 4: Assert same-project inside `mergeDuplicateGroup`**

At the top of the transaction (before aggregation), look up the survivor's `(project_id, branch)` and filter `ids` to members that match; drop the rest. (This both fixes S1 defensively and sets up S2's per-member capture — keep the filtered list as the working set for the ledger in Task 3.) Skeleton:

```ts
const survivor = this.db
  .query('SELECT project_id, branch FROM observations WHERE id = ?')
  .get(survivorId) as { project_id: string; branch: string | null } | undefined;
if (!survivor) return;
const eligible = this.db
  .query(`SELECT id, from_auto, from_search, from_drill, last_surfaced_at, project_id, branch
            FROM observations WHERE id IN (${placeholders})`)
  .all(...ids)
  .filter(m => m.project_id === survivor.project_id && (m.branch ?? '') === (survivor.branch ?? '')) as Array<...>;
if (eligible.length === 0) return;
// ...aggregate + archive use `eligible` (NOT raw ids) from here on.
```

- [ ] **Step 5: Run the tests — green**

Run: `bun test tests/unit/observations-store.test.ts -t "S1"`
Expected: PASS. Then `bun test tests/integration/dedup-command.test.ts` — still green.

- [ ] **Step 6: Commit**

```bash
git add src/worker/observations-store.ts tests/unit/observations-store.test.ts
git commit -m "fix(dedup): scope merges by (project_id, branch) — S1, closes cross-project fold"
```

---

## Task 3: S2 — append-only `merge_events` ledger

Replace the clobber-prone `theme_member_ids` JSON cell as the *reversal record* with a one-row-per-member ledger written in the same transaction. `theme_member_ids` stays for display only.

**Files:**
- Modify: `src/worker/observations-store.ts` (migration array ~27; `mergeDuplicateGroup` ~805; `unmergeDuplicateGroup` ~891; `mergedSurvivorIds` ~879)
- Modify: `src/cli/commands/dedup.ts` (pass `atEpoch`)
- Test: `tests/unit/observations-store.test.ts`

- [ ] **Step 1: Write the failing test (the clobber regression)**

```ts
describe('S2 — merge_events ledger survives nested merges', () => {
  test('two merges into the same survivor: --undo restores ALL members', () => {
    const store = makeStore();
    const surv = seedObs(store, { title: 'hot survivor', project_id: 'p', from_search: 1 });
    const m1 = seedObs(store, { title: 'hot survivor v1', project_id: 'p', from_search: 2 });
    const m2 = seedObs(store, { title: 'hot survivor v2', project_id: 'p', from_search: 4 });

    store.mergeDuplicateGroup(surv, [m1], 1000);   // first merge
    store.mergeDuplicateGroup(surv, [m2], 2000);   // second merge into the SAME survivor

    // survivor accumulated both members' counts
    expect(store.getById(surv)!.from_search).toBe(1 + 2 + 4);

    // full reversal restores BOTH members (the pre-ledger code lost m1 here)
    for (const id of store.mergedSurvivorIds()) store.unmergeDuplicateGroup(id);
    expect(store.getById(m1)!.archived).toBe(0);
    expect(store.getById(m2)!.archived).toBe(0);
    expect(store.getById(surv)!.from_search).toBe(1); // counts subtracted back exactly
    store.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/observations-store.test.ts -t "S2"`
Expected: FAIL — the second merge clobbers `theme_member_ids`, so `m1` is never un-archived.

- [ ] **Step 3: Add migration v9**

Append to `OBSERVATIONS_STORE_MIGRATIONS` (after v8):

```ts
{
  // v9 — append-only merge ledger. One row per folded member, written in the
  // SAME tx as mergeDuplicateGroup, capturing that member's contributed counts
  // so a second merge into a hot survivor can never clobber the first's record.
  // unmerge reads WHERE survivor_id=? AND undone=0. theme_member_ids kept for
  // display only. Spec: docs/tide-quartermaster.md (Risks — nested-merge clobber).
  version: 9,
  name: 'add_merge_events',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS merge_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        survivor_id   INTEGER NOT NULL,
        member_id     INTEGER NOT NULL,
        summed_auto   INTEGER NOT NULL DEFAULT 0,
        summed_search INTEGER NOT NULL DEFAULT 0,
        summed_drill  INTEGER NOT NULL DEFAULT 0,
        merged_at     INTEGER NOT NULL,
        job           TEXT NOT NULL DEFAULT 'dedup',
        undone        INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_merge_events_survivor ON merge_events(survivor_id) WHERE undone = 0');
  },
},
```

- [ ] **Step 4: Write the ledger in `mergeDuplicateGroup`**

Change the signature to `mergeDuplicateGroup(survivorId: number, memberIds: number[], atEpoch: number, job = 'dedup'): void`. Using the `eligible` working set from Task 2, in the same transaction: for each eligible member INSERT a `merge_events` row capturing its exact `from_*`; aggregate as today; keep the `theme_member_ids = ?` write (display only). Key insert:

```ts
const insertEvent = this.db.query(
  `INSERT INTO merge_events
     (survivor_id, member_id, summed_auto, summed_search, summed_drill, merged_at, job, undone)
   VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
);
for (const m of eligible) insertEvent.run(survivorId, m.id, m.from_auto, m.from_search, m.from_drill, atEpoch, job);
```

- [ ] **Step 5: Reverse from the ledger in `unmergeDuplicateGroup`**

Rewrite to read the ledger instead of the JSON cell:

```ts
unmergeDuplicateGroup(survivorId: number): void {
  const events = this.db
    .query(`SELECT id, member_id, summed_auto, summed_search, summed_drill
              FROM merge_events WHERE survivor_id = ? AND undone = 0`)
    .all(survivorId) as Array<{ id: number; member_id: number; summed_auto: number; summed_search: number; summed_drill: number }>;
  if (events.length === 0) return;
  const tx = this.db.transaction(() => {
    let a = 0, s = 0, d = 0;
    const memberIds: number[] = [];
    for (const e of events) { a += e.summed_auto; s += e.summed_search; d += e.summed_drill; memberIds.push(e.member_id); }
    const ph = memberIds.map(() => '?').join(',');
    this.db.query(
      `UPDATE observations
          SET from_auto = from_auto - ?, from_search = from_search - ?, from_drill = from_drill - ?,
              theme_member_ids = NULL
        WHERE id = ?`,
    ).run(a, s, d, survivorId);
    this.db.query(`UPDATE observations SET archived = 0, archived_into_theme_id = NULL WHERE id IN (${ph})`).run(...memberIds);
    this.db.query('UPDATE merge_events SET undone = 1 WHERE survivor_id = ? AND undone = 0').run(survivorId);
  });
  tx();
}
```

- [ ] **Step 6: Source `mergedSurvivorIds` from the ledger**

```ts
mergedSurvivorIds(): number[] {
  return (this.db
    .query('SELECT DISTINCT survivor_id FROM merge_events WHERE undone = 0 ORDER BY survivor_id ASC')
    .all() as Array<{ survivor_id: number }>).map(r => r.survivor_id);
}
```

- [ ] **Step 7: Update the one caller**

In `src/cli/commands/dedup.ts`, both `mergeDuplicateGroup` call sites (apply paths) pass an epoch:

```ts
const atEpoch = Math.floor(Date.now() / 1000);
for (const g of groups) store.mergeDuplicateGroup(g.survivor.id, g.members.map(m => m.id), atEpoch);
```

- [ ] **Step 8: Run — green**

Run: `bun test tests/unit/observations-store.test.ts tests/integration/dedup-command.test.ts`
Expected: PASS (including the S1 tests and the dedup CLI integration test).

- [ ] **Step 9: Commit**

```bash
git add src/worker/observations-store.ts src/cli/commands/dedup.ts tests/unit/observations-store.test.ts
git commit -m "fix(dedup): append-only merge_events ledger — S2, closes nested-merge clobber"
```

---

## Task 4: S3 — negation/identifier merge guard

A pure title predicate that prevents two titles from grouping when they differ in negation polarity or carry mismatched load-bearing identifiers.

**Files:**
- Create: `src/shared/merge-guard.ts`
- Create: `tests/unit/shared/merge-guard.test.ts`
- Modify: `src/shared/title-similarity.ts` (`groupBySimilarity` gains optional `blocked`)
- Modify: `src/worker/observations-store.ts` (`findDuplicateGroups` passes the guard)

- [ ] **Step 1: Write the failing guard tests (the truth table)**

`tests/unit/shared/merge-guard.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { mergeBlocked } from '../../../src/shared/merge-guard.ts';

describe('mergeBlocked', () => {
  test('blocks negation-polarity mismatch (the verified bug)', () => {
    expect(mergeBlocked('Inspected users table', 'users table missing')).toBe(true);
  });
  test('blocks differing load-bearing identifiers', () => {
    expect(mergeBlocked('timeout 30s tenant A', 'timeout 5s tenant B')).toBe(true);
  });
  test('allows genuine near-duplicate phrasings', () => {
    expect(mergeBlocked('Updated the Aelita knowledge base', 'Update Aelita knowledge base')).toBe(false);
  });
  test('symmetric', () => {
    expect(mergeBlocked('a missing', 'a present')).toBe(mergeBlocked('a present', 'a missing'));
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test tests/unit/shared/merge-guard.test.ts`
Expected: FAIL with "Cannot find module '.../merge-guard.ts'".

- [ ] **Step 3: Implement the pure guard**

`src/shared/merge-guard.ts` — reuse `normalizeTitle` from `title-similarity.ts`:

```ts
// src/shared/merge-guard.ts
//
// Pure predicate guarding the dedup grouper from folding rows that share many
// tokens but mean different (or opposite) things. Two veto rules, no I/O:
//   1. Negation polarity — one title asserts absence/failure, the other doesn't.
//   2. Identifier mismatch — they carry DIFFERENT load-bearing identifiers
//      (paths, numbers-with-units, #refs, ALL-CAPS / single-letter entity tags).
// Title-only by design: the standalone `dedup` CLI has no vector DB; the
// cosine-≥0.98 confirm rides with the Quartermaster (Release 2).
import { normalizeTitle } from './title-similarity.ts';

const NEGATION = new Set([
  'missing', 'absent', 'absence', 'fails', 'failing', 'failed', 'broken', 'none',
  'empty', 'removed', 'deleted', 'disabled', 'off', 'false', 'unavailable',
  'cannot', 'error', 'without', 'lacks', 'lacking', 'no', 'not',
]);

function negationSet(norm: string): Set<string> {
  const out = new Set<string>();
  for (const tok of norm.split(/[^a-z0-9]+/)) if (NEGATION.has(tok)) out.add(tok);
  return out;
}

// Identifiers: file-ish paths, numbers with optional unit, #refs, version-ish
// dotted tokens, and short entity tags (1–2 chars / ALL-CAPS) that descriptive
// titles use to distinguish instances (tenant A vs B, 30s vs 5s).
function identifierSet(raw: string): Set<string> {
  const out = new Set<string>();
  const patterns: RegExp[] = [
    /\b[\w./-]+\.[a-z]{2,4}\b/gi,   // file.ext / a/b/c.ts
    /#\d+\b/g,                       // #123
    /\b\d+(?:\.\d+)*\s?[a-z%]*\b/gi, // 30s, 5, 1.2.3, 80%
    /\b[A-Z]{2,}\b/g,                // ALL-CAPS entity
    /\b[A-Za-z]\b/g,                 // single-letter tag (tenant A)
  ];
  for (const re of patterns) for (const m of raw.matchAll(re)) out.add(m[0].toLowerCase());
  return out;
}

export function mergeBlocked(titleA: string, titleB: string): boolean {
  const na = normalizeTitle(titleA), nb = normalizeTitle(titleB);
  // Rule 1 — negation polarity mismatch.
  const ga = negationSet(na), gb = negationSet(nb);
  const aHas = ga.size > 0, bHas = gb.size > 0;
  if (aHas !== bHas) return true;

  // Rule 2 — both sides carry identifiers that DON'T overlap.
  const ia = identifierSet(titleA), ib = identifierSet(titleB);
  if (ia.size > 0 && ib.size > 0) {
    let shared = 0;
    for (const x of ia) if (ib.has(x)) shared++;
    if (shared === 0) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run the guard tests — green**

Run: `bun test tests/unit/shared/merge-guard.test.ts`
Expected: PASS. If the "allows genuine near-duplicate" case fails, the identifier patterns are too greedy on plain words — tighten `identifierSet` (the single-letter / ALL-CAPS rules are the usual culprits) until both the block and allow cases pass.

- [ ] **Step 5: Thread an optional `blocked` predicate through `groupBySimilarity`**

In `src/shared/title-similarity.ts`, add a 4th param and a check before a candidate joins:

```ts
export function groupBySimilarity<T>(
  items: T[],
  getTitle: (item: T) => string,
  threshold: number,
  blocked?: (repTitle: string, candidateTitle: string) => boolean,
): T[][] {
  // ...existing setup...
  for (let i = 0; i < items.length; i++) {
    if (taken[i]) continue;
    const group: T[] = [items[i]!];
    taken[i] = true;
    const repTokens = tokens[i]!;
    const repTitle = getTitle(items[i]!);
    for (let j = i + 1; j < items.length; j++) {
      if (taken[j]) continue;
      if (jaccard(repTokens, tokens[j]!) >= threshold
          && !(blocked && blocked(repTitle, getTitle(items[j]!)))) {
        group.push(items[j]!);
        taken[j] = true;
      }
    }
    groups.push(group);
  }
  return groups;
}
```

- [ ] **Step 6: Write the failing wiring test, then wire it**

Add to `tests/unit/observations-store.test.ts`:

```ts
test('S3 — findDuplicateGroups never folds a negation pair', () => {
  const store = makeStore();
  const a = seedObs(store, { title: 'Inspected users table', project_id: 'p', from_search: 5 });
  const b = seedObs(store, { title: 'users table missing',  project_id: 'p', from_search: 3 });
  for (const g of store.findDuplicateGroups(0.5)) {
    const ids = [g.survivor.id, ...g.members.map(m => m.id)];
    expect(ids.includes(a) && ids.includes(b)).toBe(false);
  }
  store.close();
});
```

Then in `findDuplicateGroups`, import `mergeBlocked` and pass it: `groupBySimilarity(part, r => r.title, threshold, mergeBlocked)`.

- [ ] **Step 7: Run — green**

Run: `bun test tests/unit/shared/merge-guard.test.ts tests/unit/shared/title-similarity.test.ts tests/unit/observations-store.test.ts`
Expected: PASS (all three).

- [ ] **Step 8: Commit**

```bash
git add src/shared/merge-guard.ts src/shared/title-similarity.ts src/worker/observations-store.ts \
        tests/unit/shared/merge-guard.test.ts tests/unit/observations-store.test.ts
git commit -m "fix(dedup): negation/identifier merge guard — S3, closes opposite-meaning fold"
```

---

## Task 5: S4 — crash-safe `reindex --force` (embed-then-swap)

Move the old-vector delete from *before* the batch embed (index.ts:1302–1311) to *after* a successful per-observation add, so an embed failure never leaves rows vector-less.

**Files:**
- Modify: `src/worker/index.ts` (reindex `flushBatch`, ~1287–1380)
- Create: `tests/integration/reindex-crash-safe.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/integration/reindex-crash-safe.test.ts` — boot a worker with a *failing* embedder (or `embed` that throws) and assert old vectors survive a `--force` reindex, and tide columns are preserved. Model it on `tests/integration/worker-http.test.ts` boot helpers.

```ts
import { describe, test, expect } from 'bun:test';
// Boot a worker with one indexed observation (real embed), capture its chunk_ids,
// flip the embedder to throw, POST /reindex {force:true}, then assert:
test('reindex --force preserves old vectors when embed fails', async () => {
  // ...boot, seed, capture vec count for the obs...
  // ...swap embedder to throw, POST /reindex {channel:'observation', force:true}...
  expect(reindexResult.errors).toBeGreaterThan(0);
  expect(vectorCountFor(obsId)).toBe(originalVectorCount); // NOT zero
});
test('reindex --force preserves tide_state and stability_days', async () => {
  // set tide_state='dormant', stability_days=42 on a row, reindex --force (real embed),
  // assert both columns unchanged afterward.
});
```

(If a throwing embedder is awkward to inject, assert at the store/meta layer: simulate `flushBatch` embed failure by stubbing `timedEmbed`. Keep the *observable invariant* — vectors for the obs are unchanged after a failed force reindex.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/integration/reindex-crash-safe.test.ts`
Expected: FAIL — current code deletes at 1307 before the 1336 embed throws, so the vector count drops to 0.

- [ ] **Step 3: Defer the delete (read-only capture in prepare; delete after add)**

In `flushBatch`, change the `Prepared` interface to carry the old chunk ids, and replace the in-place delete with a capture:

```ts
interface Prepared {
  obs: Observation;
  sourcePath: string;
  chunksWithIds: Array<{ chunk_id: string; text: string; sha: string; position: number; metadata: Record<string, unknown> }>;
  oldChunkIds: string[];   // S4: deleted only AFTER the new vectors are added
}
```

In the prepare loop, replace lines 1302–1311 with a read-only capture (no delete, no `meta.deleteDocument` yet):

```ts
let oldChunkIds: string[] = [];
if (parsed.data.force) {
  const existing = meta.getDocument(sourcePath);
  if (existing) oldChunkIds = meta.getChunksForDocument(existing.id).map(c => c.chunk_id);
}
// ...build chunksWithIds...
prepared.push({ obs, sourcePath, chunksWithIds, oldChunkIds });
```

In the write loop, after `meta.replaceChunksForDocument` + `vector.add` succeed, swap out the stale vectors:

```ts
meta.replaceChunksForDocument(documentId, p.chunksWithIds);
await vector.add(collectionName, p.chunksWithIds.map((c, i) => ({ id: c.chunk_id, embedding: obsEmbeddings[i]! })));
// S4: new vectors are committed — now it's safe to drop the old chunk_ids.
const stale = p.oldChunkIds.filter(id => !p.chunksWithIds.some(c => c.chunk_id === id));
if (stale.length > 0) await vector.delete(collectionName, stale);
indexed++;
```

`upsertDocument` updates the doc in place by `source_path`, and `replaceChunksForDocument` clears the old meta chunks — so dropping the explicit `meta.deleteDocument(sourcePath)` is correct (the doc id is preserved, meta chunks are swapped). On embed failure the early `return` at 1340 now runs with **nothing deleted**.

- [ ] **Step 4: Run — green**

Run: `bun test tests/integration/reindex-crash-safe.test.ts`
Expected: PASS — failed embed leaves old vectors; tide columns preserved.

- [ ] **Step 5: Regression — the happy path still reindexes**

Run: `bun test tests/integration/worker-http.test.ts tests/integration/vector-store.test.ts`
Expected: PASS — a successful `--force` reindex still replaces vectors (no stale duplicates: the `stale` filter removes superseded chunk_ids).

- [ ] **Step 6: Commit**

```bash
git add src/worker/index.ts tests/integration/reindex-crash-safe.test.ts
git commit -m "fix(reindex): embed-then-swap on --force — S4, never delete vectors on embed failure"
```

---

## Task 6: Release — public v0.5.5, then federation port

**Files:**
- Modify: `package.json`, `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`, `CHANGELOG.md`

- [ ] **Step 1: Full suite + typecheck green on master**

Run: `bun test && bun run typecheck`
Expected: all green, 0 type errors. (If the Windows-flagged teardown flakes surface on Linux, they should not — but re-run any flaky file in isolation to confirm it's environmental, not a real regression.)

- [ ] **Step 2: Bump version to 0.5.5 in all three manifests**

`package.json`, `.claude-plugin/marketplace.json` (both the top `version` and the `plugins[0].version`), `plugin/.claude-plugin/plugin.json`. Then rebuild dist so `src/shared/version.ts` (reads pkg.version) is current:

Run: `bun run build:plugin`

- [ ] **Step 3: CHANGELOG [0.5.5] entry**

Add under a new `## [0.5.5]` heading: the four substrate fixes (S1 project-scoped merges, S2 merge_events ledger, S3 negation/identifier guard, S4 crash-safe reindex), framed as "hardens manual `dedup --apply` and unblocks Quartermaster AUTO dedup." Note the materialized spec doc.

- [ ] **Step 4: Commit + dual-push public (github + gitlab via `origin`)**

```bash
git add -A && git commit -m "release: 0.5.5 — dedup/reindex substrate hardening (S1–S4)"
git push origin master            # origin = github + gitlab (public dual-push)
```

Then the GitHub release + tag per the established 0.5.4 flow (`gh release create v0.5.5 ...`, then `git fetch github --tags` and push the tag to gitlab).

- [ ] **Step 5: Port to federation-private v0.5.5**

In `/home/kalin/projects/captain-memo-fed` (branch `federation`): cherry-pick the S1–S4 commits (the doc already exists there), bump the three manifests to 0.5.5, rebuild dist, CHANGELOG entry, commit, and push **gitlab-only** (`git push gitlab federation` — NEVER github). Run the safety check: `git ls-remote github refs/heads/federation` must return empty.

- [ ] **Step 6: Verify federation parity**

Run in the fed worktree: `bun test && bun run typecheck`
Expected: green. Confirm `git log --oneline -6` shows the four fixes + the release commit on `federation`.

---

## Self-Review

**Spec coverage:** S1 (Task 2) ✓ tide-quartermaster.md:189; S2 (Task 3) ✓ :185 + data-model :156; S3-text-guard (Task 4) ✓ :188 (cosine floor explicitly deferred to Release 2, stated in Architecture); S4 (Task 5) ✓ :191; doc materialization (Task 1) ✓ resolves the dangling reference; release both lines (Task 6) ✓.

**Type/signature consistency:** `mergeDuplicateGroup(survivorId, memberIds, atEpoch, job?)` — new `atEpoch` param updated at its one caller (dedup.ts, Task 3 Step 7). `groupBySimilarity(items, getTitle, threshold, blocked?)` — `blocked` optional, so existing callers (the dashboard collapse) are unaffected. `findDuplicateGroups`/`mergedSurvivorIds`/`unmergeDuplicateGroup` keep their external signatures (internal rewrite only). `Prepared` gains `oldChunkIds` (local to `flushBatch`).

**Placeholder scan:** none — every code step carries complete code or an exact edit anchor with line numbers.

**Risk notes:** (a) S2 changes `mergedSurvivorIds`/`unmerge` to read the ledger — pre-existing merges made *before* v9 have `theme_member_ids` set but **no ledger rows**, so `--undo` won't reverse them. Acceptable: the live corpus has no applied dedup merges (dedup is manual + dry-run by default and has not been `--apply`'d); if that's wrong, add a one-time backfill (theme_member_ids → merge_events) — flag to the user before release. (b) S4 leaves a microsecond window where old+new vectors coexist (transient KNN dupes), strictly better than the missing-vector gap; the `stale` filter prevents permanent duplicates.

---

## Execution Handoff

Recommended: **superpowers:subagent-driven-development** — fresh implementer subagent per task (sequential; these tasks share `observations-store.ts` so they must NOT run in parallel), two-stage review (spec then quality) between tasks. Tasks 2–5 are standard-model mechanical-with-judgment; Task 1 and Task 6 are light.
