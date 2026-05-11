# captain-memo v0.1.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship four additive features as v0.1.3 — PreCompact summarized-recap hook, identifier-match boost in hybrid search, branch metadata + soft same-branch retrieval boost, and a `Version:` line in `captain-memo stats` text output.

**Architecture:** All three search boosts (identifier, branch) live in a single new module `src/worker/rerank.ts` that runs between `reciprocalRankFusion` and `slice(0, topK)` in `HybridSearcher.search`. PreCompact hook joins the existing dispatcher pattern (one TS file per event, registered in `EVENTS` map). Branch metadata is added to `RawObservationEvent` and propagated into `documents.metadata.branch` during ingest. One nullable schema-equivalent field; no breaking changes.

**Tech Stack:** Bun + TypeScript, SQLite (`bun:sqlite`) + sqlite-vec, FTS5 (BM25), zod schemas, Claude Code plugin hooks system.

**Spec:** [`docs/specs/2026-05-11-captain-memo-v0.1.3-design.md`](../specs/2026-05-11-captain-memo-v0.1.3-design.md)

---

## File map

| Path | Status | Responsibility |
|---|---|---|
| `src/worker/rerank.ts` | Create | Identifier-token extractor + `applyBoosts` post-RRF reranker |
| `src/worker/branch.ts` | Create | `detectBranch(cwd)` git shell-out helper, with sync + async forms |
| `src/worker/search.ts` | Modify | `HybridSearcher.search` calls `applyBoosts` after RRF |
| `src/hooks/pre-compact.ts` | Create | PreCompact handler — reads stdin, summarizes, POSTs observation |
| `src/hooks/dispatcher.ts` | Modify | Add `PreCompact` → `../hooks/pre-compact.ts` to `EVENTS` map |
| `src/hooks/post-tool-use.ts` | Modify | Populate `branch` on captured `RawObservationEvent` |
| `src/shared/types.ts` | Modify | Add `branch?: string \| null` and `source?: string` to `RawObservationEvent` |
| `src/worker/ingest.ts` | Modify | Propagate `branch` from event into `documents.metadata.branch` |
| `src/cli/commands/stats.ts` | Modify | Print `Version:` line in text output |
| `plugin/hooks/hooks.json` | Modify | Register `PreCompact` hook |
| `tests/unit/rerank.test.ts` | Create | TDD coverage for extractor + applyBoosts |
| `tests/unit/branch.test.ts` | Create | TDD coverage for detectBranch |
| `tests/integration/search-boosts.test.ts` | Create | End-to-end fixture verifying boosts move chunks |
| `tests/hooks/pre-compact.test.ts` | Create | PreCompact handler test with mocked summarizer |
| `package.json` | Modify | Version bump to `0.1.3` |

---

## Pre-flight

### Task 0: Verify working tree + tests baseline

**Files:** none (verification only).

- [ ] **Step 1: Confirm working tree is clean and on master**

Run:
```bash
cd /home/kalin/projects/captain-memo
git status -sb
```
Expected: `## master...origin/master` with no untracked or modified files. If dirty: stash or commit first.

- [ ] **Step 2: Verify test suite is green before changes**

Run:
```bash
bun test 2>&1 | tail -20
```
Expected: all tests pass. If any pre-existing failure: note it, do not let your changes mask it.

- [ ] **Step 3: Verify typecheck is green**

Run:
```bash
bun run typecheck
```
Expected: no errors. Same caveat as above.

---

## Phase 1 — Bonus: `Version:` line in stats text output

Smallest feature → fastest first commit → confirms commit/test loop works before bigger work.

### Task 1.1: Add Version line to stats text output

**Files:**
- Modify: `src/cli/commands/stats.ts` — between `Project:` and `Indexing:` lines

- [ ] **Step 1: Modify `statsCommand` to print version**

Locate the block that prints `Project:` and `Indexing:`:
```typescript
console.log(`Project:        ${stats.project_id}`);
console.log(`Indexing:       ${indexingLine(stats.indexing)}`);
```

Insert one line between them:
```typescript
console.log(`Project:        ${stats.project_id}`);
console.log(`Version:        ${(stats as { version?: string }).version ?? 'unknown'}`);
console.log(`Indexing:       ${indexingLine(stats.indexing)}`);
```

(The `version` field already exists on the worker's `/stats` response — verified by `captain-memo stats --json | jq .version`. Cast is needed only if `StatsResponse` in `stats.ts` doesn't declare it; if it does, drop the cast.)

- [ ] **Step 2: Verify output**

Run:
```bash
captain-memo stats 2>&1 | head -10
```
Expected: a `Version:` line appears between `Project:` and `Indexing:` showing the worker's version.

- [ ] **Step 3: Verify `--json` output unchanged**

Run:
```bash
captain-memo stats --json | jq 'keys'
```
Expected: same key set as before (no schema change to JSON output).

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/stats.ts
git commit -m "$(cat <<'EOF'
feat(stats): show Version line in text output

The worker's /stats response already includes the version; surface it
in the human-readable output so users can confirm which captain-memo
they're running without --json.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — Identifier-match boost

### Task 2.1: TDD `extractIdentifierTokens`

**Files:**
- Create: `src/worker/rerank.ts`
- Create: `tests/unit/rerank.test.ts`

- [ ] **Step 1: Write failing test for extractor**

Create `tests/unit/rerank.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { extractIdentifierTokens } from '../../src/worker/rerank.ts';

describe('extractIdentifierTokens', () => {
  test('catches snake_case + dotted tokens', () => {
    expect(extractIdentifierTokens('how does contract_bills.fee work'))
      .toEqual(['contract_bills.fee']);
  });
  test('catches camelCase', () => {
    expect(extractIdentifierTokens('debug useEffect crash'))
      .toEqual(['useEffect']);
  });
  test('catches path-shaped tokens', () => {
    expect(extractIdentifierTokens('check src/main.py'))
      .toEqual(['src/main.py']);
  });
  test('catches PascalCase via internal lower-to-upper transition', () => {
    expect(extractIdentifierTokens('inspect MyClass shape'))
      .toEqual(['MyClass']);
  });
  test('skips plain-English tokens', () => {
    expect(extractIdentifierTokens('billing payment contract user'))
      .toEqual([]);
  });
  test('skips all-uppercase tokens (yelled words, not identifiers)', () => {
    expect(extractIdentifierTokens('FOO BAR'))
      .toEqual([]);
  });
  test('returns multiple identifiers from one query', () => {
    expect(extractIdentifierTokens('useEffect in src/main.py and contract_bills.fee'))
      .toEqual(['useEffect', 'src/main.py', 'contract_bills.fee']);
  });
  test('empty query returns empty array', () => {
    expect(extractIdentifierTokens('')).toEqual([]);
  });
  test('preserves internal punctuation but trims trailing comma', () => {
    expect(extractIdentifierTokens('useEffect, useState'))
      .toEqual(['useEffect', 'useState']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/rerank.test.ts
```
Expected: FAIL — `extractIdentifierTokens` not exported (module doesn't exist yet).

- [ ] **Step 3: Implement `extractIdentifierTokens`**

Create `src/worker/rerank.ts`:
```typescript
/**
 * Extract query tokens that look like code identifiers. A token qualifies if:
 *   - it contains `_`, `.`, or `/` (snake_case, dotted, paths), OR
 *   - it has an internal lowercase-to-uppercase transition (camelCase/PascalCase)
 *
 * Plain words and all-uppercase tokens are skipped — those are exactly the
 * queries where semantic ranking should win uncontested.
 */
export function extractIdentifierTokens(query: string): string[] {
  if (!query) return [];
  const rawTokens = query.split(/\s+/).filter(t => t.length > 0);
  // Strip trailing punctuation that isn't structural (commas, semicolons,
  // closing brackets), but keep internal `.`, `_`, `/`.
  const cleaned = rawTokens.map(t => t.replace(/[,;:!?)\]}'"]+$/u, ''));
  const codeShaped = /[_./]|[a-z][a-zA-Z]*[A-Z]/;
  return cleaned.filter(t => t.length > 0 && codeShaped.test(t));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/unit/rerank.test.ts
```
Expected: PASS, all 9 cases.

### Task 2.2: TDD `applyBoosts` (identifier portion only)

**Files:**
- Modify: `src/worker/rerank.ts` (append `applyBoosts`)
- Modify: `tests/unit/rerank.test.ts` (append tests)

- [ ] **Step 1: Write failing tests for applyBoosts**

Append to `tests/unit/rerank.test.ts`:
```typescript
import { applyBoosts } from '../../src/worker/rerank.ts';
import type { FusedItem } from '../../src/worker/search.ts';

describe('applyBoosts — identifier match', () => {
  const fakeChunks: Record<string, { content: string; branch: string | null }> = {
    'a': { content: 'this chunk mentions contract_bills.fee directly', branch: null },
    'b': { content: 'this chunk is about billing in general', branch: null },
    'c': { content: 'unrelated text about coffee', branch: null },
  };
  const getChunk = async (id: string) => fakeChunks[id]
    ? { id, content: fakeChunks[id].content, branch: fakeChunks[id].branch }
    : null;

  test('chunk containing the literal identifier outranks one that does not', async () => {
    const fused: FusedItem[] = [
      { id: 'b', score: 0.80 },
      { id: 'a', score: 0.50 },
      { id: 'c', score: 0.30 },
    ];
    const reranked = await applyBoosts(fused, {
      query: 'find contract_bills.fee usage',
      currentBranch: null,
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    // a's score: 0.50 * (1 + 0.3*1) = 0.65 → still below 0.80
    // But the test should be that 'a' moves UP relative to 'c', and 'b' is unchanged.
    expect(reranked.map(r => r.id)).toEqual(['b', 'a', 'c']);
    expect(reranked.find(r => r.id === 'a')!.score).toBeCloseTo(0.65, 2);
    expect(reranked.find(r => r.id === 'b')!.score).toBeCloseTo(0.80, 2);
  });

  test('boost cap prevents runaway amplification', async () => {
    const heavyMatch: FusedItem[] = [{ id: 'a', score: 0.5 }];
    const reranked = await applyBoosts(heavyMatch, {
      query: 'contract_bills.fee contract_bills.fee contract_bills.fee contract_bills.fee contract_bills.fee',
      currentBranch: null,
      getChunk,
      identifierBoost: true,
      branchBoost: true,
    });
    // 5 matches × 0.3 = +1.5 multiplier, capped to 2.0×: 0.5 * 2.0 = 1.0
    expect(reranked[0]!.score).toBeCloseTo(1.0, 2);
  });

  test('identifier boost disabled returns scores unchanged', async () => {
    const fused: FusedItem[] = [{ id: 'a', score: 0.5 }];
    const reranked = await applyBoosts(fused, {
      query: 'contract_bills.fee',
      currentBranch: null,
      getChunk,
      identifierBoost: false,
      branchBoost: true,
    });
    expect(reranked[0]!.score).toBeCloseTo(0.5, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/rerank.test.ts
```
Expected: FAIL — `applyBoosts` not exported.

- [ ] **Step 3: Implement `applyBoosts`**

Append to `src/worker/rerank.ts`:
```typescript
import type { FusedItem } from './search.ts';

export interface RerankChunk {
  id: string;
  content: string;
  branch: string | null;
}

export interface RerankContext {
  query: string;
  currentBranch: string | null;
  getChunk: (id: string) => Promise<RerankChunk | null>;
  identifierBoost: boolean;
  branchBoost: boolean;
}

const IDENTIFIER_BOOST_PER_MATCH = 0.3;
const IDENTIFIER_BOOST_CAP = 2.0;
const BRANCH_BOOST_MULTIPLIER = 1.1;

export async function applyBoosts(
  fused: FusedItem[],
  ctx: RerankContext,
): Promise<FusedItem[]> {
  const idTokens = ctx.identifierBoost ? extractIdentifierTokens(ctx.query) : [];

  // Short-circuit: no boost signals active and no branch to compare → return as-is.
  if (idTokens.length === 0 && !(ctx.branchBoost && ctx.currentBranch)) {
    return fused;
  }

  // Fetch content for all candidates in parallel.
  const enriched = await Promise.all(
    fused.map(async item => ({ item, chunk: await ctx.getChunk(item.id) })),
  );

  const reranked = enriched.map(({ item, chunk }) => {
    if (!chunk) return item;
    let score = item.score;

    // Identifier match boost: count literal occurrences of each id token.
    if (idTokens.length > 0) {
      const matches = idTokens.filter(t => chunk.content.includes(t)).length;
      if (matches > 0) {
        const multiplier = Math.min(
          1 + IDENTIFIER_BOOST_PER_MATCH * matches,
          IDENTIFIER_BOOST_CAP,
        );
        score *= multiplier;
      }
    }

    // Same-branch boost: chunk and worker on same branch → small bump.
    if (ctx.branchBoost && ctx.currentBranch && chunk.branch === ctx.currentBranch) {
      score *= BRANCH_BOOST_MULTIPLIER;
    }

    return { id: item.id, score };
  });

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run:
```bash
bun test tests/unit/rerank.test.ts
```
Expected: PASS, all 12 cases (9 from 2.1 + 3 from 2.2).

### Task 2.3: Wire `applyBoosts` into `HybridSearcher.search`

**Files:**
- Modify: `src/worker/search.ts` — `HybridSearcher.search` method
- Modify: `src/worker/search.ts` — `HybridSearcherOptions` interface

- [ ] **Step 1: Read current state**

Open `src/worker/search.ts:54-88`. The current `search()` runs vector + keyword in parallel, fuses with RRF, and slices to topK.

- [ ] **Step 2: Extend `HybridSearcherOptions` with rerank context dependencies**

Modify the interface (around line 47):
```typescript
export interface HybridSearcherOptions {
  vectorSearch: (embedding: number[], topK: number) => Promise<VectorHit[]>;
  keywordSearch: (query: string, topK: number) => Promise<KeywordHit[]>;
  getChunk?: (id: string) => Promise<import('./rerank.ts').RerankChunk | null>;
  rrfK?: number;
  perStrategyTopK?: number;
}
```

Add the field to the class constructor stash (around line 60):
```typescript
private getChunk?: HybridSearcherOptions['getChunk'];

constructor(opts: HybridSearcherOptions) {
  this.vectorSearch = opts.vectorSearch;
  this.keywordSearch = opts.keywordSearch;
  this.getChunk = opts.getChunk;
  this.rrfK = opts.rrfK ?? 60;
  this.perStrategyTopK = opts.perStrategyTopK ?? 25;
}
```

- [ ] **Step 3: Modify `search()` to call `applyBoosts` between RRF and slice**

Replace the existing `search()` method:
```typescript
async search(embedding: number[], query: string, topK: number, opts?: {
  currentBranch?: string | null;
}): Promise<FusedItem[]> {
  const [vectorResults, keywordResults] = await Promise.all([
    this.vectorSearch(embedding, this.perStrategyTopK).catch(err => {
      console.error('[search] vector half failed:', (err as Error).message);
      return [];
    }),
    this.keywordSearch(query, this.perStrategyTopK).catch(err => {
      console.error('[search] keyword half failed:', (err as Error).message);
      return [];
    }),
  ]);

  const vectorIds = vectorResults.map(r => r.id);
  const keywordIds = keywordResults.map(r => r.chunk_id);
  const fused = reciprocalRankFusion([vectorIds, keywordIds], this.rrfK);

  // Apply post-RRF boosts (identifier + branch) when getChunk is wired and
  // either boost is enabled. Env vars gate each boost independently.
  if (this.getChunk) {
    const { applyBoosts } = await import('./rerank.ts');
    const identifierBoost = process.env.CAPTAIN_MEMO_IDENTIFIER_BOOST !== '0';
    const branchBoost = process.env.CAPTAIN_MEMO_BRANCH_BOOST !== '0';
    if (identifierBoost || branchBoost) {
      const reranked = await applyBoosts(fused, {
        query,
        currentBranch: opts?.currentBranch ?? null,
        getChunk: this.getChunk,
        identifierBoost,
        branchBoost,
      });
      return reranked.slice(0, topK);
    }
  }
  return fused.slice(0, topK);
}
```

- [ ] **Step 4: Wire `getChunk` at the searcher's construction site**

Locate where `new HybridSearcher(...)` is called (likely in `src/worker/index.ts` — `grep -n "new HybridSearcher" src/`).

Add a `getChunk` adapter using `MetaStore.getChunkById`:
```typescript
const getChunk = async (id: string) => {
  const found = meta.getChunkById(id);
  if (!found) return null;
  return {
    id,
    content: found.chunk.text,
    branch: (found.document.metadata as { branch?: string | null }).branch ?? null,
  };
};

const searcher = new HybridSearcher({
  vectorSearch: /* existing */,
  keywordSearch: /* existing */,
  getChunk,
});
```

- [ ] **Step 5: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 6: Run full test suite**

Run:
```bash
bun test
```
Expected: all pre-existing tests pass + new rerank tests pass.

### Task 2.4: Integration test for identifier boost in real search

**Files:**
- Create: `tests/integration/search-boosts.test.ts`

- [ ] **Step 1: Write integration test**

Create `tests/integration/search-boosts.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { HybridSearcher, type FusedItem } from '../../src/worker/search.ts';

describe('HybridSearcher with identifier boost', () => {
  test('chunk containing literal identifier outranks chunk that does not', async () => {
    const chunks: Record<string, { text: string; branch: string | null }> = {
      'chunk-billing-vague': {
        text: 'billing is a complex area with many edge cases',
        branch: null,
      },
      'chunk-billing-literal': {
        text: 'function calculateFee() reads contract_bills.fee from the DB',
        branch: null,
      },
    };

    // Vector half ranks vague-billing higher (it's a closer semantic match to "billing").
    const vectorSearch = async () => [
      { id: 'chunk-billing-vague', distance: 0.1 },
      { id: 'chunk-billing-literal', distance: 0.3 },
    ];
    // Keyword half catches both equally.
    const keywordSearch = async () => [
      { chunk_id: 'chunk-billing-vague' },
      { chunk_id: 'chunk-billing-literal' },
    ];
    const getChunk = async (id: string) => chunks[id]
      ? { id, content: chunks[id].text, branch: chunks[id].branch }
      : null;

    const searcher = new HybridSearcher({ vectorSearch, keywordSearch, getChunk });
    const results: FusedItem[] = await searcher.search([0.1, 0.2], 'find contract_bills.fee in the code', 5);

    // Identifier boost should push the literal-match chunk to #1.
    expect(results[0]!.id).toBe('chunk-billing-literal');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
bun test tests/integration/search-boosts.test.ts
```
Expected: PASS.

### Task 2.5: Commit Phase 2

- [ ] **Step 1: Commit identifier-match boost work**

```bash
git add src/worker/rerank.ts src/worker/search.ts src/worker/index.ts \
        tests/unit/rerank.test.ts tests/integration/search-boosts.test.ts
git commit -m "$(cat <<'EOF'
feat(search): identifier-match boost for code-shaped query tokens

Queries like contract_bills.fee or useEffect should win literal matches
over chunks that are vaguely on-topic. After RRF fusion, the new rerank
module applies a multiplicative boost (1 + 0.3 × matched-token-count,
capped at 2.0×) for chunks whose content contains a verbatim query token
that looks like code (contains _, ., /, or has lowercase-to-uppercase
transition).

Disable via env var CAPTAIN_MEMO_IDENTIFIER_BOOST=0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(If your `git add` glob misses `src/worker/index.ts` because no edits landed there, drop it — the diff from Task 2.3 Step 4 might live elsewhere depending on the actual searcher construction site.)

---

## Phase 3 — Branch metadata + same-branch boost

The `applyBoosts` function already accepts a `branch` field on each chunk (built in Phase 2). Phase 3's job is to populate that field end-to-end: capture branch at the hook, thread it through the observation envelope, store it on the document metadata, and surface it through `getChunk`.

**Deviation from spec (intentional improvement):** The spec sketched an `ALTER TABLE observations ADD COLUMN branch` migration. After reading `src/worker/meta.ts`, the `documents` table already has a `metadata TEXT` column for exactly this kind of extension. Using `documents.metadata.branch` avoids the schema migration entirely while remaining queryable and persistent. Functionally equivalent; structurally simpler. No `ALTER TABLE` step.

### Task 3.1: TDD `detectBranch` helper

**Files:**
- Create: `src/worker/branch.ts`
- Create: `tests/unit/branch.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/branch.test.ts`:
```typescript
import { describe, test, expect } from 'bun:test';
import { detectBranchSync } from '../../src/worker/branch.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';

describe('detectBranchSync', () => {
  test('returns branch name inside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-test-'));
    try {
      execSync('git init -b feature/widget', { cwd: dir });
      execSync('git commit --allow-empty -m init', { cwd: dir });
      expect(detectBranchSync(dir)).toBe('feature/widget');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when cwd is not a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-test-'));
    try {
      expect(detectBranchSync(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when cwd does not exist', () => {
    expect(detectBranchSync('/nonexistent/path/captain-memo-test')).toBeNull();
  });

  test('returns HEAD literal when detached (not a branch name)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-branch-test-'));
    try {
      execSync('git init', { cwd: dir });
      execSync('git commit --allow-empty -m init', { cwd: dir });
      const sha = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
      execSync(`git checkout ${sha}`, { cwd: dir });
      // Detached HEAD: git returns "HEAD" — store as-is; rerank treats it like any
      // other branch label (won't match a real branch, so no boost fires).
      expect(detectBranchSync(dir)).toBe('HEAD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/unit/branch.test.ts
```
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `detectBranchSync`**

Create `src/worker/branch.ts`:
```typescript
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Resolve the current git branch for a working directory.
 * Returns null when:
 *   - the path doesn't exist
 *   - the path is not inside a git repo
 *   - git is not installed
 *   - any error occurs (we never throw — branch capture is best-effort)
 *
 * Detached HEAD returns the literal "HEAD" — that's what `git rev-parse
 * --abbrev-ref HEAD` produces in that state. We store it as-is rather than
 * inventing a different convention.
 */
export function detectBranchSync(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  try {
    const result = spawnSync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf-8', timeout: 2000 },
    );
    if (result.status !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run:
```bash
bun test tests/unit/branch.test.ts
```
Expected: PASS, all 4 cases.

### Task 3.2: Add `branch` and `source` to `RawObservationEvent`

**Files:**
- Modify: `src/shared/types.ts` — `RawObservationEvent` interface

- [ ] **Step 1: Extend the interface**

Locate `RawObservationEvent` in `src/shared/types.ts`. Add two optional fields:
```typescript
export interface RawObservationEvent {
  session_id: string;
  project_id: string;
  prompt_number: number;
  tool_name: string;
  tool_input_summary: string;
  tool_result_summary: string;
  files_read: string[];
  files_modified: string[];
  ts_epoch: number;
  /** Git branch at capture cwd, or null when not in a git repo. */
  branch?: string | null;
  /** Origin of the observation: "post-tool-use" (default), "pre-compact", etc. */
  source?: string;
}
```

- [ ] **Step 2: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors. (Existing callers don't set the new fields; they're optional.)

### Task 3.3: Populate `branch` in PostToolUse hook capture

**Files:**
- Modify: `src/hooks/post-tool-use.ts`

- [ ] **Step 1: Read current state**

Open `src/hooks/post-tool-use.ts`. Locate the spot where the `RawObservationEvent` is constructed (search for `tool_name:` or `session_id:`).

- [ ] **Step 2: Add branch capture**

Import the helper near the top:
```typescript
import { detectBranchSync } from '../worker/branch.ts';
```

In the event construction, add the branch field — capture from `process.cwd()` since the hook runs from the project root:
```typescript
const event: RawObservationEvent = {
  session_id: /* existing */,
  project_id: /* existing */,
  prompt_number: /* existing */,
  tool_name: /* existing */,
  tool_input_summary: /* existing */,
  tool_result_summary: /* existing */,
  files_read: /* existing */,
  files_modified: /* existing */,
  ts_epoch: /* existing */,
  branch: detectBranchSync(process.cwd()),  // NEW
};
```

- [ ] **Step 3: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Verify existing hook tests still pass**

Run:
```bash
bun test tests/hooks/post-tool-use.test.ts
```
Expected: PASS.

### Task 3.4: Propagate `branch` into `documents.metadata.branch` during ingest

**Files:**
- Modify: `src/worker/ingest.ts`

- [ ] **Step 1: Find the observation→document upsert site**

Run:
```bash
grep -n "upsertDocument\|metadata" src/worker/ingest.ts | head -20
```

Locate the path where a `RawObservationEvent` or `Observation` is turned into a `documents` row via `upsertDocument(...)`. The `metadata` field of `UpsertDocumentInput` is `Record<string, unknown>`.

- [ ] **Step 2: Inject branch into metadata**

In the metadata construction for an observation-derived document, include the branch from the source event:
```typescript
const metadata = {
  // ...existing metadata fields...
  branch: event.branch ?? null,
};
```

(Naming the source variable depends on the existing code — could be `obs`, `event`, `raw`, etc. Match local style.)

- [ ] **Step 3: Verify with a probe**

Submit a test observation and inspect the resulting document metadata. From a worker shell:
```bash
# After ingest runs once with the new code:
sqlite3 ~/.captain-memo/meta.db "SELECT source_path, metadata FROM documents WHERE channel='observation' ORDER BY id DESC LIMIT 3;"
```
Expected: at least one row's metadata JSON contains a `branch` field.

### Task 3.5: Integration test for branch boost

**Files:**
- Modify: `tests/integration/search-boosts.test.ts` — append branch test

- [ ] **Step 1: Add branch-boost test**

Append to `tests/integration/search-boosts.test.ts`:
```typescript
describe('HybridSearcher with branch boost', () => {
  test('same-branch chunk outranks cross-branch chunk with equal vector + keyword rank', async () => {
    const chunks: Record<string, { text: string; branch: string | null }> = {
      'chunk-main':    { text: 'function getThing returns the thing', branch: 'main' },
      'chunk-feature': { text: 'function getThing returns the thing', branch: 'feature/widget' },
    };
    // Vector + keyword rank them identically.
    const vectorSearch = async () => [
      { id: 'chunk-main', distance: 0.1 },
      { id: 'chunk-feature', distance: 0.1 },
    ];
    const keywordSearch = async () => [
      { chunk_id: 'chunk-main' },
      { chunk_id: 'chunk-feature' },
    ];
    const getChunk = async (id: string) => chunks[id]
      ? { id, content: chunks[id].text, branch: chunks[id].branch }
      : null;

    const searcher = new HybridSearcher({ vectorSearch, keywordSearch, getChunk });
    const results = await searcher.search([0.1, 0.2], 'getThing usage', 5, {
      currentBranch: 'feature/widget',
    });

    // Both have equal RRF score, but feature/widget chunk gets the 1.1× boost.
    expect(results[0]!.id).toBe('chunk-feature');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
bun test tests/integration/search-boosts.test.ts
```
Expected: PASS, both Phase-2 and new Phase-3 cases.

### Task 3.6: Wire `currentBranch` at search call sites

**Files:**
- Modify: the worker's search route handler (likely `src/worker/index.ts` or wherever `/search` is registered)

- [ ] **Step 1: Find search call sites**

Run:
```bash
grep -rn "searcher.search\|searcher\\.search" src/worker/ | head -10
```

- [ ] **Step 2: Pass `currentBranch` at each call site**

At each `searcher.search(...)` invocation, pass the worker's process cwd's branch:
```typescript
import { detectBranchSync } from './branch.ts';
// ...
const currentBranch = detectBranchSync(process.cwd());
const results = await searcher.search(embedding, query, topK, { currentBranch });
```

If branch detection is expensive enough to be worth caching for the worker's lifetime (it shouldn't be — 2s timeout, runs once per request), compute once at boot and reuse. Default: call per-request; revisit if profiling shows it matters.

- [ ] **Step 3: Run full suite**

```bash
bun test && bun run typecheck
```
Expected: all green.

### Task 3.7: Commit Phase 3

- [ ] **Step 1: Commit branch capture + boost work**

```bash
git add src/worker/branch.ts src/worker/ingest.ts src/worker/index.ts \
        src/hooks/post-tool-use.ts src/shared/types.ts \
        tests/unit/branch.test.ts tests/integration/search-boosts.test.ts
git commit -m "$(cat <<'EOF'
feat(observations): record git branch at capture + soft same-branch retrieval boost

Each observation now carries the git branch detected from cwd at capture
time (null when not in a git repo). Branch is propagated into the
parent document's metadata during ingest, so the search reranker can
read it via the existing chunk→document lookup.

At search time, when worker cwd is on a branch, chunks recorded on the
same branch get a 1.1× soft boost — never hides cross-branch results,
just nudges branch-local context up. Disable via env var
CAPTAIN_MEMO_BRANCH_BOOST=0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — PreCompact summarized-recap hook

### Task 4.1: Register PreCompact in dispatcher EVENTS map

**Files:**
- Modify: `src/hooks/dispatcher.ts`

- [ ] **Step 1: Add entry to EVENTS**

Open `src/hooks/dispatcher.ts:7-12`. Extend the map:
```typescript
const EVENTS: Record<string, string> = {
  UserPromptSubmit: '../hooks/user-prompt-submit.ts',
  SessionStart:     '../hooks/session-start.ts',
  PostToolUse:      '../hooks/post-tool-use.ts',
  Stop:             '../hooks/stop.ts',
  PreCompact:       '../hooks/pre-compact.ts',  // NEW
};
```

- [ ] **Step 2: Typecheck (handler doesn't exist yet — typecheck only checks dispatcher file)**

Run:
```bash
bun run typecheck
```
Expected: no errors (dynamic imports are not statically resolved).

### Task 4.2: TDD PreCompact handler — summarize and POST

**Files:**
- Create: `src/hooks/pre-compact.ts`
- Create: `tests/hooks/pre-compact.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/hooks/pre-compact.test.ts`:
```typescript
import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock the submitter — verifies the handler POSTs a pre-compact observation
// to the worker's submission API.
const submitMock = mock(async (_payload: unknown) => ({ ok: true }));
mock.module('../../src/hooks/shared.ts', () => ({
  submitObservation: submitMock,
  logHookError: (_event: string, _err: unknown) => {},
  readHookStdin: async () => ({
    session_id: 'ses_pc_1',
    transcript_path: '/tmp/transcript.txt',
    trigger: 'auto',
  }),
}));

// Mock the summarizer — returns a deterministic narrative.
const summarizeMock = mock(async (_input: string) => ({
  type: 'discovery' as const,
  title: 'Session summary at compaction',
  narrative: 'We did X and Y.',
  facts: ['fact-1'],
  concepts: ['concept-1'],
}));
mock.module('../../src/worker/summarizer.ts', () => ({
  runSummarizer: summarizeMock,
}));

beforeEach(() => {
  submitMock.mockClear();
  summarizeMock.mockClear();
});

describe('PreCompact handler', () => {
  test('reads stdin, summarizes, and submits with source=pre-compact', async () => {
    const { main } = await import('../../src/hooks/pre-compact.ts');
    await main();
    expect(submitMock).toHaveBeenCalledTimes(1);
    const payload = submitMock.mock.calls[0]![0] as { source?: string; session_id?: string };
    expect(payload.source).toBe('pre-compact');
    expect(payload.session_id).toBe('ses_pc_1');
  });

  test('exits 0 even when summarizer throws (never blocks compaction)', async () => {
    summarizeMock.mockImplementationOnce(async () => { throw new Error('boom'); });
    const { main } = await import('../../src/hooks/pre-compact.ts');
    await expect(main()).resolves.toBeUndefined();
    expect(submitMock).toHaveBeenCalledTimes(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
bun test tests/hooks/pre-compact.test.ts
```
Expected: FAIL — handler doesn't exist.

- [ ] **Step 3: Implement the handler**

Create `src/hooks/pre-compact.ts`. (The exact integration with the existing summarizer + submitter depends on the current shapes of `submitObservation`/`runSummarizer`; the handler shape below is the contract — adapt argument shapes to match what `src/hooks/shared.ts` and `src/worker/summarizer.ts` actually export.)

```typescript
import { readHookStdin, submitObservation, logHookError } from './shared.ts';
import { runSummarizer } from '../worker/summarizer.ts';
import { detectBranchSync } from '../worker/branch.ts';
import type { RawObservationEvent } from '../shared/types.ts';

export async function main(): Promise<void> {
  try {
    const env = await readHookStdin();
    // PreCompact stdin envelope shape (verify against CC docs/test): includes
    // session_id, transcript_path or similar context hint, and trigger reason.
    if (!env || typeof env !== 'object') {
      process.exit(0);
    }
    const sessionId = (env as { session_id?: string }).session_id ?? 'unknown';
    const projectId = process.env.CAPTAIN_MEMO_PROJECT_ID ?? 'default';

    // Build summarizer input from whatever PreCompact hands us. If only a
    // transcript path is given, read it; otherwise pass the envelope JSON.
    const summarizerInput = JSON.stringify(env);
    const summary = await runSummarizer(summarizerInput);
    if (!summary) {
      process.exit(0);
    }

    const event: RawObservationEvent & { source: string } = {
      session_id: sessionId,
      project_id: projectId,
      prompt_number: 0,
      tool_name: 'pre-compact',
      tool_input_summary: '',
      tool_result_summary: summary.narrative.slice(0, 2000),
      files_read: [],
      files_modified: [],
      ts_epoch: Math.floor(Date.now() / 1000),
      branch: detectBranchSync(process.cwd()),
      source: 'pre-compact',
    };

    await submitObservation(event);
  } catch (err) {
    logHookError('PreCompact', err);
  }
  // Always succeed — never block compaction.
  process.exit(0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
bun test tests/hooks/pre-compact.test.ts
```
Expected: PASS, both cases.

### Task 4.3: Register PreCompact in plugin manifest

**Files:**
- Modify: `plugin/hooks/hooks.json`

- [ ] **Step 1: Add PreCompact section**

Append to the `hooks` object (after the `Stop` entry, before the closing `}`):
```json
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/bin/captain-memo-hook PreCompact",
            "timeout": 30
          }
        ]
      }
    ]
```

Make sure the JSON commas are correct — the new entry should have a comma BEFORE it (after `Stop`'s closing `]`).

- [ ] **Step 2: Validate JSON**

Run:
```bash
jq . plugin/hooks/hooks.json
```
Expected: valid JSON pretty-printed back.

### Task 4.4: Manual smoke test in a real Claude Code session

- [ ] **Step 1: Reinstall the plugin so CC picks up the new manifest**

This depends on how captain-memo is registered. If linked via `captain-memo install`, re-run:
```bash
captain-memo install   # interactive; pick the same install path
```
Or, if you symlinked into `~/.claude/plugins/`, the manifest change is live without reinstall.

- [ ] **Step 2: Trigger a PreCompact in a CC session**

Open a CC session, fill context to near-compaction, let auto-compact fire (or trigger manually via the `/compact` command). Wait a few seconds.

- [ ] **Step 3: Verify a `source: "pre-compact"` observation landed**

```bash
sqlite3 ~/.captain-memo/observations.db \
  "SELECT id, type, title, substr(narrative, 1, 80) FROM observations
   WHERE files_read = '[]' AND tool_name='pre-compact'
   ORDER BY created_at_epoch DESC LIMIT 3;"
```
Or, if the worker exposes a list endpoint:
```bash
captain-memo observation list --limit 5
```
Expected: at least one fresh row whose narrative is a session summary.

### Task 4.5: Commit Phase 4

- [ ] **Step 1: Commit PreCompact hook work**

```bash
git add src/hooks/pre-compact.ts src/hooks/dispatcher.ts \
        plugin/hooks/hooks.json tests/hooks/pre-compact.test.ts
git commit -m "$(cat <<'EOF'
feat(hook): PreCompact summarized-recap observation

Register a PreCompact hook that fires just before Claude Code's context
window compacts. Handler reads CC's stdin envelope, calls the existing
summarizer to produce a structured recap of session activity, and
submits it as an observation with source="pre-compact".

Failure-safe: any error in stdin parsing, summarizer call, or submission
results in exit(0). Compaction is the user's emergency lifeline; the
captain must not stand in its way.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Release

### Task 5.1: Final test + typecheck sweep

- [ ] **Step 1: Full test suite**

Run:
```bash
bun test 2>&1 | tail -30
```
Expected: all tests pass.

- [ ] **Step 2: Typecheck**

Run:
```bash
bun run typecheck
```
Expected: no errors.

### Task 5.2: Bump version and release commit

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Bump version**

Edit `package.json`, change `"version": "0.1.2"` → `"version": "0.1.3"`.

- [ ] **Step 2: Commit the version bump as a chore commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore: release v0.1.3

PreCompact hook + identifier-match boost + branch metadata & boost +
Version line in stats text output. See docs/specs/2026-05-11-captain-memo-v0.1.3-design.md
and docs/plans/2026-05-11-captain-memo-v0.1.3.md.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.3: Tag and push

- [ ] **Step 1: Tag**

```bash
git tag v0.1.3
```

- [ ] **Step 2: Push commits + tag (both GitHub and GitLab via the multi-push origin)**

```bash
git push origin master v0.1.3
```
Expected: two `master -> master` lines (one per remote) and two `[new tag] v0.1.3 -> v0.1.3` lines.

- [ ] **Step 3: Verify both remotes show the tag**

```bash
gh api repos/kalinbogatzevski/captain-memo/tags --jq '.[0:3] | .[].name'
```
Expected: `v0.1.3` appears as the first entry.

### Task 5.4: Create the GitHub Release

- [ ] **Step 1: Run `gh release create` with hand-written notes**

```bash
gh release create v0.1.3 --title "v0.1.3 — PreCompact hook + search boosts + branch metadata" --notes "$(cat <<'EOF'
## What's new

- **PreCompact summarized-recap hook** — fires just before Claude Code compacts a session. Captures a structured recap (the existing summarizer applied to session activity) so the highest-signal moment doesn't vanish into the compaction void. Tagged \`source: "pre-compact"\` for later retrieval.
- **Identifier-match boost in hybrid search** — queries like \`contract_bills.fee\`, \`useEffect\`, or \`src/main.py\` now boost chunks that literally contain those tokens. Multiplicative bump (capped at 2.0×) applied post-RRF. Disable via \`CAPTAIN_MEMO_IDENTIFIER_BOOST=0\`.
- **Branch metadata + soft same-branch boost** — every observation now records its git branch at capture. Same-branch chunks get a 1.1× boost at retrieval. Never hides cross-branch results, just nudges branch-local context up. Disable via \`CAPTAIN_MEMO_BRANCH_BOOST=0\`.
- **\`Version:\` line in stats** — \`captain-memo stats\` text output now surfaces the running version (already available via \`--json\`).

## Schema

One non-breaking addition: \`branch\` field on observation envelopes flows into \`documents.metadata.branch\`. Existing rows: NULL — no backfill needed.

## Upgrade

\`\`\`bash
cd ~/projects/captain-memo && git pull && bun install
# or via the installer
captain-memo install
\`\`\`

**Full diff**: https://github.com/kalinbogatzevski/captain-memo/compare/v0.1.2...v0.1.3
EOF
)"
```

Expected: prints the GitHub release URL.

- [ ] **Step 2: Verify release page renders**

```bash
gh release view v0.1.3 | head -20
```
Expected: title + notes display correctly.

---

## Done criteria

All five phases checked off, plus:

- [ ] `bun test` and `bun run typecheck` both green at HEAD
- [ ] `git log v0.1.2..v0.1.3 --oneline` shows 5 commits matching the spec's release-plan list (4 features + 1 release)
- [ ] `gh release view v0.1.3` displays the hand-written notes
- [ ] One manual PreCompact smoke verified an observation with `source: "pre-compact"` landed (Task 4.4 Step 3)
- [ ] `captain-memo stats` shows the new `Version:` line and (after worker restart) reads `0.1.3`
