# captain-memo v1 — Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundation of `captain-memo` — a manually-usable MCP plugin that indexes memory files + skill bodies + observations into Voyage-embedded Chroma, exposes hybrid search via 8 MCP tools and a basic CLI, and watches the filesystem for incremental updates. Hooks, summarizer, migration, federation, and optimization land in Plans 2 and 3.

**Architecture:** Long-running worker process (bun, port 39888) owns the Chroma + SQLite + Voyage clients and exposes an HTTP API. A separate stdio MCP server (started fresh per Claude Code session) and a CLI both talk to the worker via HTTP. Pure-logic modules (chunkers, RRF, sha) are unit-tested with no external deps; integration tests bring up real Chroma + a mocked Voyage HTTP server.

**Tech Stack:**
- **Runtime:** bun ≥1.1.14 (matches claude-mem's pattern)
- **Language:** TypeScript (strict mode), ESM-only
- **Storage:** `bun:sqlite` for metadata + FTS5 keyword search, Chroma (via `@modelcontextprotocol/sdk` stdio subprocess) for vectors
- **HTTP server:** `Bun.serve()` (built-in, no express)
- **MCP server:** `@modelcontextprotocol/sdk`
- **File watching:** `chokidar` (with `awaitWriteFinish`)
- **Token counting:** `gpt-tokenizer` (cl100k_base, matches Voyage tokenization within ~5%)
- **Schema validation:** `zod`
- **IDs:** `nanoid`
- **Tests:** `bun:test` (built-in)

Spec reference: `~/projects/captain-memo/docs/specs/2026-05-06-captain-memo-design.md`

---

## File Structure

```
~/projects/captain-memo/
├── package.json                           # bun deps + scripts
├── tsconfig.json                           # strict TS config
├── .gitignore                              # node_modules, dist, .captain-memo/
├── bin/
│   └── captain-memo                          # CLI shebang entry point (bun)
├── src/
│   ├── mcp-server.ts                       # Stdio MCP — talks to worker over HTTP
│   ├── shared/
│   │   ├── types.ts                        # Hit, Chunk, Document, ChannelType, etc.
│   │   ├── sha.ts                          # sha256 hex digest
│   │   ├── tokens.ts                       # tiktoken-compatible token counter
│   │   ├── paths.ts                        # ~/.captain-memo data dir resolution
│   │   └── id.ts                           # chunk_id / cluster_id generators
│   ├── worker/
│   │   ├── index.ts                        # Long-running worker bootstrap (Bun.serve)
│   │   ├── meta.ts                         # SQLite store: documents, chunks, FTS5
│   │   ├── embedder.ts                     # Voyage HTTP client (batch + retry)
│   │   ├── chroma.ts                       # Chroma MCP-subprocess wrapper
│   │   ├── search.ts                       # Hybrid: vector + FTS5 + RRF fusion
│   │   ├── watcher.ts                      # chokidar wrapper (debounced)
│   │   ├── ingest.ts                       # Diff + chunk + embed pipeline
│   │   └── chunkers/
│   │       ├── memory-file.ts              # 1 chunk per memory file
│   │       ├── skill.ts                    # Section-aware (## headers)
│   │       └── observation.ts              # Per-field (narrative + facts[])
│   └── cli/
│       ├── index.ts                        # CLI entry (parses argv)
│       ├── client.ts                       # HTTP client to worker
│       └── commands/
│           ├── status.ts
│           ├── stats.ts
│           ├── reindex.ts
│           └── worker.ts                   # `worker start|stop|restart`
└── tests/
    ├── unit/
    │   ├── sha.test.ts
    │   ├── tokens.test.ts
    │   ├── meta.test.ts
    │   ├── embedder.test.ts
    │   ├── search.test.ts
    │   └── chunkers/
    │       ├── memory-file.test.ts
    │       ├── skill.test.ts
    │       └── observation.test.ts
    ├── integration/
    │   ├── ingest.test.ts                  # Real Chroma, mocked Voyage
    │   └── worker-mcp.test.ts              # Full MCP roundtrip
    └── fixtures/
        ├── memory-files/                   # Sample memory MD files
        └── skills/                         # Sample SKILL.md files
```

---

## Implementation Tasks

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `bin/captain-memo`
- Create: `src/` directory structure (empty placeholders)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "captain-memo",
  "version": "0.1.0-alpha",
  "description": "Local memory layer for Claude Code — Voyage-embedded, hybrid search, federated remotes",
  "type": "module",
  "private": true,
  "engines": {
    "bun": ">=1.1.14"
  },
  "bin": {
    "captain-memo": "./bin/captain-memo"
  },
  "scripts": {
    "test": "bun test",
    "test:unit": "bun test tests/unit/",
    "test:integration": "bun test tests/integration/",
    "typecheck": "tsc --noEmit",
    "worker:start": "bun src/worker/index.ts",
    "mcp:start": "bun src/mcp-server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.25.1",
    "chokidar": "^4.0.3",
    "gpt-tokenizer": "^2.5.1",
    "nanoid": "^5.0.7",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "tests/**/*", "bin/**/*"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
bun.lockb
dist/
.captain-memo/
*.tsbuildinfo
.DS_Store
*.log
```

- [ ] **Step 4: Create `bin/captain-memo` entry point**

```typescript
#!/usr/bin/env bun
import { main } from '../src/cli/index.ts';
main(process.argv.slice(2));
```

Make executable:
```bash
chmod +x bin/captain-memo
```

- [ ] **Step 5: Create directory structure**

```bash
mkdir -p src/{shared,worker/chunkers,cli/commands}
mkdir -p tests/{unit/chunkers,integration,fixtures/memory-files,fixtures/skills}
```

- [ ] **Step 6: Install dependencies**

Run: `bun install`
Expected: `bun.lockb` created, `node_modules/` populated.

- [ ] **Step 7: Sanity check**

Run: `bun run typecheck`
Expected: Exit 0 (no source files yet, but TS config valid).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json .gitignore bin/captain-memo .gitignore
git commit -m "feat: project scaffolding — package.json, tsconfig, dirs, CLI entry"
```

---

### Task 2: Test framework sanity check

**Files:**
- Create: `tests/unit/sanity.test.ts`

- [ ] **Step 1: Write a trivial test**

```typescript
// tests/unit/sanity.test.ts
import { test, expect } from 'bun:test';

test('sanity — bun:test runs', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/unit/sanity.test.ts`
Expected: `1 pass, 0 fail`

- [ ] **Step 3: Commit**

```bash
git add tests/unit/sanity.test.ts
git commit -m "test: sanity check for bun:test framework"
```

---

### Task 3: SHA256 helper

**Files:**
- Create: `src/shared/sha.ts`
- Create: `tests/unit/sha.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/sha.test.ts
import { test, expect } from 'bun:test';
import { sha256Hex } from '../../src/shared/sha.ts';

test('sha256Hex — produces stable hex digest', () => {
  expect(sha256Hex('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
});

test('sha256Hex — different inputs produce different digests', () => {
  expect(sha256Hex('hello')).not.toBe(sha256Hex('hello!'));
});

test('sha256Hex — handles empty string', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sha.test.ts`
Expected: FAIL with "Cannot find module '../../src/shared/sha.ts'"

- [ ] **Step 3: Implement**

```typescript
// src/shared/sha.ts
export function sha256Hex(input: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(input);
  return hasher.digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sha.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/shared/sha.ts tests/unit/sha.test.ts
git commit -m "feat(shared): sha256Hex helper using Bun.CryptoHasher"
```

---

### Task 4: Token counter

**Files:**
- Create: `src/shared/tokens.ts`
- Create: `tests/unit/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/tokens.test.ts
import { test, expect } from 'bun:test';
import { countTokens } from '../../src/shared/tokens.ts';

test('countTokens — counts ASCII text', () => {
  expect(countTokens('hello world')).toBe(2);
});

test('countTokens — handles empty string', () => {
  expect(countTokens('')).toBe(0);
});

test('countTokens — counts multibyte (Bulgarian)', () => {
  // "Здравей" should produce multiple tokens
  expect(countTokens('Здравей')).toBeGreaterThan(1);
});

test('countTokens — long text scales roughly linearly', () => {
  const short = countTokens('hello world');
  const long = countTokens('hello world '.repeat(100));
  expect(long).toBeGreaterThan(short * 50);
});
```

- [ ] **Step 2: Run test — verify failure**

Run: `bun test tests/unit/tokens.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```typescript
// src/shared/tokens.ts
import { encode } from 'gpt-tokenizer';

export function countTokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}
```

- [ ] **Step 4: Run test — verify pass**

Run: `bun test tests/unit/tokens.test.ts`
Expected: `4 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/shared/tokens.ts tests/unit/tokens.test.ts
git commit -m "feat(shared): countTokens helper using gpt-tokenizer (cl100k_base)"
```

---

### Task 5: Type definitions

**Files:**
- Create: `src/shared/types.ts`

- [ ] **Step 1: Define core types**

```typescript
// src/shared/types.ts
export type ChannelType = 'memory' | 'skill' | 'observation' | 'remote';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export type ObservationType =
  | 'bugfix' | 'feature' | 'refactor'
  | 'discovery' | 'decision' | 'change';

export type DocType =
  | 'memory_file' | 'skill_section' | 'skill_summary'
  | 'observation' | 'session_summary' | 'mem_md_stub';

export interface Document {
  id: number;
  source_path: string;
  channel: ChannelType;
  project_id: string;
  sha: string;
  mtime_epoch: number;
  last_indexed_epoch: number;
  metadata: Record<string, unknown>;
}

export interface Chunk {
  id: number;
  document_id: number;
  chunk_id: string;          // Stable, exposed externally
  text: string;
  sha: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface ChunkInput {
  text: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface Hit {
  doc_id: string;
  source_path: string;
  title: string;
  snippet: string;
  score: number;             // 0-1, RRF-fused
  channel: ChannelType;
  metadata: Record<string, unknown>;
}

export interface SearchOptions {
  query: string;
  top_k?: number;
  channels?: ChannelType[];
  type?: string;
  files?: string[];
  since?: string;
  project?: string;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: Exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(shared): core type definitions (Document, Chunk, Hit, etc.)"
```

---

### Task 6: ID generator + paths

**Files:**
- Create: `src/shared/id.ts`
- Create: `src/shared/paths.ts`
- Create: `tests/unit/id.test.ts`

- [ ] **Step 1: Write the failing test for id**

```typescript
// tests/unit/id.test.ts
import { test, expect } from 'bun:test';
import { newChunkId, parseDocId } from '../../src/shared/id.ts';

test('newChunkId — produces channel-prefixed id', () => {
  const id = newChunkId('memory', 'feedback_test');
  expect(id).toMatch(/^memory:feedback_test:[A-Za-z0-9_-]{8}$/);
});

test('newChunkId — same source produces different ids on multiple calls', () => {
  const a = newChunkId('memory', 'x');
  const b = newChunkId('memory', 'x');
  expect(a).not.toBe(b);
});

test('parseDocId — extracts channel and source', () => {
  const parsed = parseDocId('memory:feedback_test:abc12345');
  expect(parsed).toEqual({ channel: 'memory', source: 'feedback_test', shortId: 'abc12345' });
});

test('parseDocId — returns null on malformed input', () => {
  expect(parseDocId('not-a-doc-id')).toBeNull();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/id.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement id generator**

```typescript
// src/shared/id.ts
import { customAlphabet } from 'nanoid';
import type { ChannelType } from './types.ts';

const shortId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-', 8);

export function newChunkId(channel: ChannelType, source: string): string {
  return `${channel}:${source}:${shortId()}`;
}

export interface ParsedDocId {
  channel: ChannelType;
  source: string;
  shortId: string;
}

export function parseDocId(id: string): ParsedDocId | null {
  const parts = id.split(':');
  if (parts.length < 3) return null;
  const [channel, source, shortIdPart] = [parts[0], parts.slice(1, -1).join(':'), parts[parts.length - 1]];
  if (!channel || !source || !shortIdPart) return null;
  if (!['memory', 'skill', 'observation', 'remote'].includes(channel)) return null;
  return { channel: channel as ChannelType, source, shortId: shortIdPart };
}
```

- [ ] **Step 4: Implement paths helper**

```typescript
// src/shared/paths.ts
import { homedir } from 'os';
import { join } from 'path';

export const DATA_DIR = process.env.CAPTAIN_MEMO_DATA_DIR ?? join(homedir(), '.captain-memo');

export const META_DB_PATH = join(DATA_DIR, 'meta.sqlite3');
export const QUEUE_DB_PATH = join(DATA_DIR, 'queue.db');
export const PENDING_EMBED_DB_PATH = join(DATA_DIR, 'pending_embed.db');
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const ARCHIVE_DIR = join(DATA_DIR, 'archive');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');

export const DEFAULT_WORKER_PORT = 39888;
export const DEFAULT_VOYAGE_ENDPOINT = 'http://localhost:8124/v1/embeddings';
```

- [ ] **Step 5: Run — verify pass**

Run: `bun test tests/unit/id.test.ts`
Expected: `4 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add src/shared/id.ts src/shared/paths.ts tests/unit/id.test.ts
git commit -m "feat(shared): id generators (newChunkId, parseDocId) + paths constants"
```

---

### Task 7: Memory file chunker

**Files:**
- Create: `src/worker/chunkers/memory-file.ts`
- Create: `tests/unit/chunkers/memory-file.test.ts`
- Create: `tests/fixtures/memory-files/feedback_example.md`

- [ ] **Step 1: Create fixture**

```markdown
<!-- tests/fixtures/memory-files/feedback_example.md -->
---
name: feedback_example
description: An illustrative feedback memory for testing
type: feedback
---

Always use erp-components, no custom page styles.

**Why:** custom styles drift over time and break the design system's visual coherence.
**How to apply:** when adding new UI, reach for `.erp-card`, `.erp-form-row` etc. before writing CSS.
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/chunkers/memory-file.test.ts
import { test, expect } from 'bun:test';
import { chunkMemoryFile } from '../../../src/worker/chunkers/memory-file.ts';
import { readFileSync } from 'fs';

const fixture = readFileSync('tests/fixtures/memory-files/feedback_example.md', 'utf-8');

test('chunkMemoryFile — produces exactly one chunk per file', () => {
  const chunks = chunkMemoryFile(fixture, '/abs/path/feedback_example.md');
  expect(chunks).toHaveLength(1);
});

test('chunkMemoryFile — chunk text excludes frontmatter', () => {
  const [chunk] = chunkMemoryFile(fixture, '/abs/path/feedback_example.md');
  expect(chunk.text).not.toContain('---');
  expect(chunk.text).not.toContain('name: feedback_example');
  expect(chunk.text).toContain('Always use erp-components');
});

test('chunkMemoryFile — metadata extracts frontmatter fields', () => {
  const [chunk] = chunkMemoryFile(fixture, '/abs/path/feedback_example.md');
  expect(chunk.metadata.memory_type).toBe('feedback');
  expect(chunk.metadata.description).toBe('An illustrative feedback memory for testing');
  expect(chunk.metadata.filename_id).toBe('feedback_example');
});

test('chunkMemoryFile — handles file with no frontmatter', () => {
  const noFrontmatter = '# Plain content\n\nJust some text.';
  const chunks = chunkMemoryFile(noFrontmatter, '/abs/path/note.md');
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text).toContain('Just some text');
  expect(chunks[0]!.metadata.memory_type).toBeUndefined();
});
```

- [ ] **Step 3: Run — verify fail**

Run: `bun test tests/unit/chunkers/memory-file.test.ts`
Expected: module not found.

- [ ] **Step 4: Implement**

```typescript
// src/worker/chunkers/memory-file.ts
import { basename } from 'path';
import type { ChunkInput } from '../../shared/types.ts';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

interface ParsedFrontmatter {
  raw: string;
  body: string;
  fields: Record<string, string>;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    return { raw: '', body: content, fields: {} };
  }
  const raw = match[1] ?? '';
  const fields: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return { raw, body: content.slice(match[0].length), fields };
}

export function chunkMemoryFile(content: string, sourcePath: string): ChunkInput[] {
  const { body, fields } = parseFrontmatter(content);
  const filenameId = basename(sourcePath, '.md');

  const metadata: Record<string, unknown> = {
    doc_type: 'memory_file',
    filename_id: filenameId,
    source_path: sourcePath,
  };
  if (fields.type) metadata.memory_type = fields.type;
  if (fields.description) metadata.description = fields.description;
  if (fields.name) metadata.name = fields.name;

  return [{
    text: body.trim(),
    position: 0,
    metadata,
  }];
}
```

- [ ] **Step 5: Run — verify pass**

Run: `bun test tests/unit/chunkers/memory-file.test.ts`
Expected: `4 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add src/worker/chunkers/memory-file.ts tests/unit/chunkers/memory-file.test.ts tests/fixtures/memory-files/feedback_example.md
git commit -m "feat(chunker): memory-file chunker — 1 chunk per file, frontmatter to metadata"
```

---

### Task 8: Skill body chunker

**Files:**
- Create: `src/worker/chunkers/skill.ts`
- Create: `tests/unit/chunkers/skill.test.ts`
- Create: `tests/fixtures/skills/example-skill.md`

- [ ] **Step 1: Create fixture skill**

```markdown
<!-- tests/fixtures/skills/example-skill.md -->
---
name: example-skill
description: A test skill with multiple sections and code blocks
---

# Example Skill

This is the introductory paragraph that captures the skill's purpose.

## Architecture

The skill follows a layered architecture pattern. Layer 1 handles input,
layer 2 transforms, layer 3 emits.

```typescript
function transform(input: string): string {
  // intentional code block — must not be split
  return input.toUpperCase();
}
```

More architecture prose after the code block.

## Usage

Invoke via the standard skill loader. The skill expects a string input.

### Edge cases

Empty input → empty output. Null input → throws.

## Anti-patterns

Don't bypass layer 2. Don't mutate inputs.
```

- [ ] **Step 2: Write the failing test**

```typescript
// tests/unit/chunkers/skill.test.ts
import { test, expect } from 'bun:test';
import { chunkSkill } from '../../../src/worker/chunkers/skill.ts';
import { readFileSync } from 'fs';

const fixture = readFileSync('tests/fixtures/skills/example-skill.md', 'utf-8');

test('chunkSkill — splits on ## headers', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  // Expect: 1 summary chunk + 3 ## sections (Architecture, Usage, Anti-patterns)
  // Section headers should match
  const sectionTitles = chunks
    .filter(c => c.metadata.doc_type === 'skill_section')
    .map(c => c.metadata.section_title);
  expect(sectionTitles).toEqual(['Architecture', 'Usage', 'Anti-patterns']);
});

test('chunkSkill — produces a skill_summary chunk', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  const summary = chunks.find(c => c.metadata.doc_type === 'skill_summary');
  expect(summary).toBeDefined();
  expect(summary!.text).toContain('A test skill with multiple sections');
});

test('chunkSkill — keeps code blocks intact within section', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  const arch = chunks.find(c => c.metadata.section_title === 'Architecture');
  expect(arch).toBeDefined();
  expect(arch!.text).toContain('```typescript');
  expect(arch!.text).toContain('return input.toUpperCase()');
  expect(arch!.metadata.has_code).toBe(true);
});

test('chunkSkill — metadata identifies skill', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  for (const chunk of chunks) {
    expect(chunk.metadata.skill_id).toBe('example-skill');
    expect(chunk.metadata.source_path).toBe('/abs/path/example-skill.md');
  }
});

test('chunkSkill — preserves position ordering', () => {
  const chunks = chunkSkill(fixture, '/abs/path/example-skill.md');
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i]!.position).toBeGreaterThan(chunks[i - 1]!.position);
  }
});
```

- [ ] **Step 3: Run — verify fail**

Run: `bun test tests/unit/chunkers/skill.test.ts`
Expected: module not found.

- [ ] **Step 4: Implement**

```typescript
// src/worker/chunkers/skill.ts
import { basename } from 'path';
import type { ChunkInput } from '../../shared/types.ts';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const CODE_FENCE_RE = /^```/;

interface SkillFrontmatter {
  body: string;
  fields: Record<string, string>;
}

function parseFrontmatter(content: string): SkillFrontmatter {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return { body: content, fields: {} };
  const raw = match[1] ?? '';
  const fields: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fields[key] = value;
  }
  return { body: content.slice(match[0].length), fields };
}

interface Section {
  title: string;
  text: string;
  hasCode: boolean;
}

function splitSections(body: string): { intro: string; sections: Section[] } {
  const lines = body.split('\n');
  let intro = '';
  const sections: Section[] = [];
  let current: Section | null = null;
  let inFence = false;

  for (const line of lines) {
    if (CODE_FENCE_RE.test(line)) inFence = !inFence;

    // Only split on ## when NOT inside a code fence
    if (!inFence && line.startsWith('## ') && !line.startsWith('### ')) {
      if (current) sections.push(current);
      current = {
        title: line.slice(3).trim(),
        text: line + '\n',
        hasCode: false,
      };
      continue;
    }

    if (current) {
      current.text += line + '\n';
      if (CODE_FENCE_RE.test(line)) current.hasCode = true;
    } else {
      intro += line + '\n';
    }
  }
  if (current) sections.push(current);
  return { intro: intro.trim(), sections };
}

export function chunkSkill(content: string, sourcePath: string): ChunkInput[] {
  const { body, fields } = parseFrontmatter(content);
  const skillId = basename(sourcePath, '.md').replace(/^SKILL$/, basename(sourcePath.replace(/\/SKILL\.md$/, '')));
  const description = fields.description ?? '';

  const { intro, sections } = splitSections(body);

  const chunks: ChunkInput[] = [];
  let position = 0;

  // Skill summary chunk: description + intro paragraph
  const introFirstPara = intro.split(/\n\n/)[0] ?? '';
  if (description || introFirstPara) {
    chunks.push({
      text: [description, introFirstPara].filter(Boolean).join('\n\n'),
      position: position++,
      metadata: {
        doc_type: 'skill_summary',
        skill_id: skillId,
        source_path: sourcePath,
        description,
      },
    });
  }

  // Each ## section as its own chunk
  for (const section of sections) {
    chunks.push({
      text: section.text.trim(),
      position: position++,
      metadata: {
        doc_type: 'skill_section',
        skill_id: skillId,
        source_path: sourcePath,
        section_title: section.title,
        has_code: section.hasCode,
      },
    });
  }

  return chunks;
}
```

- [ ] **Step 5: Run — verify pass**

Run: `bun test tests/unit/chunkers/skill.test.ts`
Expected: `5 pass, 0 fail`

- [ ] **Step 6: Commit**

```bash
git add src/worker/chunkers/skill.ts tests/unit/chunkers/skill.test.ts tests/fixtures/skills/example-skill.md
git commit -m "feat(chunker): skill chunker — section-aware (## headers), code-block protected"
```

---

### Task 9: Observation chunker

**Files:**
- Create: `src/worker/chunkers/observation.ts`
- Create: `tests/unit/chunkers/observation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/chunkers/observation.test.ts
import { test, expect } from 'bun:test';
import { chunkObservation, chunkSummary } from '../../../src/worker/chunkers/observation.ts';

const observation = {
  id: 1234,
  session_id: 'sess-abc',
  project_id: 'erp-platform',
  type: 'bugfix' as const,
  title: 'Fixed locked form-field display bug',
  narrative: 'The bug was caused by hardcoded fallback. Smart default fixed it.',
  facts: [
    'Root cause was hardcoded fallback in form renderer',
    'Smart default approach validated in GLAB#366',
  ],
  concepts: ['gotcha', 'pattern'],
  files_read: ['core/inc/forms.php'],
  files_modified: ['core/modules/admin/forms/render.php'],
  created_at_epoch: 1714838400,
  prompt_number: 12,
};

test('chunkObservation — produces 1 narrative chunk + 1 chunk per fact', () => {
  const chunks = chunkObservation(observation);
  expect(chunks).toHaveLength(3); // 1 narrative + 2 facts
});

test('chunkObservation — narrative chunk has narrative text + correct field_type', () => {
  const chunks = chunkObservation(observation);
  const narrative = chunks.find(c => c.metadata.field_type === 'narrative');
  expect(narrative).toBeDefined();
  expect(narrative!.text).toBe(observation.narrative);
});

test('chunkObservation — fact chunks each have one fact + index', () => {
  const chunks = chunkObservation(observation);
  const facts = chunks.filter(c => c.metadata.field_type === 'fact');
  expect(facts).toHaveLength(2);
  expect(facts[0]!.text).toBe(observation.facts[0]);
  expect(facts[0]!.metadata.fact_index).toBe(0);
  expect(facts[1]!.metadata.fact_index).toBe(1);
});

test('chunkObservation — metadata propagates type, files, project', () => {
  const chunks = chunkObservation(observation);
  for (const chunk of chunks) {
    expect(chunk.metadata.observation_id).toBe(1234);
    expect(chunk.metadata.session_id).toBe('sess-abc');
    expect(chunk.metadata.type).toBe('bugfix');
    expect(chunk.metadata.files_modified).toEqual(['core/modules/admin/forms/render.php']);
  }
});

test('chunkSummary — 1 chunk per non-empty field', () => {
  const summary = {
    id: 99,
    session_id: 'sess-abc',
    project_id: 'erp-platform',
    request: 'Fix locked form fields',
    investigated: 'Traced the rendering path',
    learned: 'Hardcoded fallback is dangerous',
    completed: 'Patched the renderer',
    next_steps: '',
    notes: '',
    created_at_epoch: 1714838400,
    prompt_number: 12,
  };
  const chunks = chunkSummary(summary);
  expect(chunks).toHaveLength(4); // 4 non-empty fields
  const fieldTypes = chunks.map(c => c.metadata.field_type);
  expect(fieldTypes).toEqual(['request', 'investigated', 'learned', 'completed']);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/chunkers/observation.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement**

```typescript
// src/worker/chunkers/observation.ts
import type { ChunkInput, ObservationType } from '../../shared/types.ts';

export interface Observation {
  id: number;
  session_id: string;
  project_id: string;
  type: ObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  created_at_epoch: number;
  prompt_number: number;
}

export interface SessionSummary {
  id: number;
  session_id: string;
  project_id: string;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
  notes: string;
  created_at_epoch: number;
  prompt_number: number;
}

export function chunkObservation(obs: Observation): ChunkInput[] {
  const baseMetadata: Record<string, unknown> = {
    doc_type: 'observation',
    observation_id: obs.id,
    session_id: obs.session_id,
    project_id: obs.project_id,
    type: obs.type,
    title: obs.title,
    concepts: obs.concepts,
    files_read: obs.files_read,
    files_modified: obs.files_modified,
    created_at_epoch: obs.created_at_epoch,
    prompt_number: obs.prompt_number,
  };

  const chunks: ChunkInput[] = [];
  let position = 0;

  if (obs.narrative.trim()) {
    chunks.push({
      text: obs.narrative,
      position: position++,
      metadata: { ...baseMetadata, field_type: 'narrative' },
    });
  }

  for (let i = 0; i < obs.facts.length; i++) {
    const fact = obs.facts[i]!;
    if (!fact.trim()) continue;
    chunks.push({
      text: fact,
      position: position++,
      metadata: { ...baseMetadata, field_type: 'fact', fact_index: i },
    });
  }

  return chunks;
}

const SUMMARY_FIELDS = ['request', 'investigated', 'learned', 'completed', 'next_steps', 'notes'] as const;

export function chunkSummary(summary: SessionSummary): ChunkInput[] {
  const baseMetadata: Record<string, unknown> = {
    doc_type: 'session_summary',
    summary_id: summary.id,
    session_id: summary.session_id,
    project_id: summary.project_id,
    created_at_epoch: summary.created_at_epoch,
    prompt_number: summary.prompt_number,
  };

  const chunks: ChunkInput[] = [];
  let position = 0;

  for (const field of SUMMARY_FIELDS) {
    const text = summary[field];
    if (!text || !text.trim()) continue;
    chunks.push({
      text,
      position: position++,
      metadata: { ...baseMetadata, field_type: field },
    });
  }

  return chunks;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/chunkers/observation.test.ts`
Expected: `5 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/chunkers/observation.ts tests/unit/chunkers/observation.test.ts
git commit -m "feat(chunker): observation/summary chunker — per-semantic-field granularity"
```

---

### Task 10: Meta SQLite store — schema + documents CRUD

**Files:**
- Create: `src/worker/meta.ts`
- Create: `tests/unit/meta.test.ts`

- [ ] **Step 1: Write the failing test (documents only for this task)**

```typescript
// tests/unit/meta.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { MetaStore } from '../../src/worker/meta.ts';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/captain-memo-test-meta.sqlite3';
let store: MetaStore;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  store = new MetaStore(TEST_DB);
});

afterEach(() => {
  store.close();
});

test('MetaStore — initializes schema on first open', () => {
  expect(store.getDocument('/nonexistent')).toBeNull();
});

test('MetaStore — upsertDocument creates new document', () => {
  const id = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc123',
    mtime_epoch: 1000,
    metadata: { description: 'test' },
  });
  expect(typeof id).toBe('number');
  const doc = store.getDocument('/abs/path/foo.md');
  expect(doc).not.toBeNull();
  expect(doc!.id).toBe(id);
  expect(doc!.sha).toBe('abc123');
  expect(doc!.metadata.description).toBe('test');
});

test('MetaStore — upsertDocument updates existing document', () => {
  const id1 = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc123',
    mtime_epoch: 1000,
    metadata: {},
  });
  const id2 = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'def456',
    mtime_epoch: 2000,
    metadata: {},
  });
  expect(id2).toBe(id1);
  const doc = store.getDocument('/abs/path/foo.md');
  expect(doc!.sha).toBe('def456');
  expect(doc!.mtime_epoch).toBe(2000);
});

test('MetaStore — deleteDocument removes by source_path', () => {
  store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.deleteDocument('/abs/path/foo.md');
  expect(store.getDocument('/abs/path/foo.md')).toBeNull();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/meta.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement (documents-only for this task)**

```typescript
// src/worker/meta.ts
import { Database } from 'bun:sqlite';
import type { ChannelType, Document } from '../shared/types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  mtime_epoch INTEGER NOT NULL,
  last_indexed_epoch INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_documents_project_channel ON documents(project_id, channel);
`;

export interface UpsertDocumentInput {
  source_path: string;
  channel: ChannelType;
  project_id: string;
  sha: string;
  mtime_epoch: number;
  metadata: Record<string, unknown>;
}

export class MetaStore {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  upsertDocument(input: UpsertDocumentInput): number {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.db
      .query('SELECT id FROM documents WHERE source_path = ?')
      .get(input.source_path) as { id: number } | undefined;

    if (existing) {
      this.db
        .query(
          `UPDATE documents
           SET channel = ?, project_id = ?, sha = ?, mtime_epoch = ?,
               last_indexed_epoch = ?, metadata = ?
           WHERE id = ?`
        )
        .run(
          input.channel,
          input.project_id,
          input.sha,
          input.mtime_epoch,
          now,
          JSON.stringify(input.metadata),
          existing.id
        );
      return existing.id;
    }

    const result = this.db
      .query(
        `INSERT INTO documents (source_path, channel, project_id, sha, mtime_epoch, last_indexed_epoch, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.source_path,
        input.channel,
        input.project_id,
        input.sha,
        input.mtime_epoch,
        now,
        JSON.stringify(input.metadata)
      );
    return Number(result.lastInsertRowid);
  }

  getDocument(source_path: string): Document | null {
    const row = this.db
      .query('SELECT * FROM documents WHERE source_path = ?')
      .get(source_path) as
      | (Omit<Document, 'metadata'> & { metadata: string })
      | undefined;
    if (!row) return null;
    return { ...row, metadata: JSON.parse(row.metadata) };
  }

  deleteDocument(source_path: string): void {
    this.db.query('DELETE FROM documents WHERE source_path = ?').run(source_path);
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/meta.test.ts`
Expected: `4 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/meta.ts tests/unit/meta.test.ts
git commit -m "feat(worker): MetaStore — documents table CRUD with WAL mode"
```

---

### Task 11: Meta store — chunks table + FTS5

**Files:**
- Modify: `src/worker/meta.ts` (add chunks table + chunks methods)
- Modify: `tests/unit/meta.test.ts` (add chunks tests)

- [ ] **Step 1: Add failing tests for chunks**

Append to `tests/unit/meta.test.ts`:

```typescript
test('MetaStore — replaceChunksForDocument inserts chunks', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'memory:foo:aaaa1111', text: 'first chunk', sha: 'sha1', position: 0, metadata: { type: 'a' } },
    { chunk_id: 'memory:foo:bbbb2222', text: 'second chunk', sha: 'sha2', position: 1, metadata: { type: 'b' } },
  ]);
  const chunks = store.getChunksForDocument(docId);
  expect(chunks).toHaveLength(2);
  expect(chunks[0]!.text).toBe('first chunk');
  expect(chunks[1]!.metadata.type).toBe('b');
});

test('MetaStore — replaceChunksForDocument replaces all existing on rerun', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'memory:foo:aaaa1111', text: 'old', sha: 'old', position: 0, metadata: {} },
  ]);
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'memory:foo:bbbb2222', text: 'new', sha: 'new', position: 0, metadata: {} },
  ]);
  const chunks = store.getChunksForDocument(docId);
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.text).toBe('new');
});

test('MetaStore — searchKeyword via FTS5 returns ranked chunks', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: {},
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'a', text: 'GLAB#367 fixed locked form fields', sha: 's1', position: 0, metadata: {} },
    { chunk_id: 'b', text: 'rebuilt the cashbox UI', sha: 's2', position: 1, metadata: {} },
    { chunk_id: 'c', text: 'GLAB#366 was about smart defaults', sha: 's3', position: 2, metadata: {} },
  ]);
  const hits = store.searchKeyword('GLAB#367', 5);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.chunk_id).toBe('a');
});

test('MetaStore — getChunkById returns chunk + parent document', () => {
  const docId = store.upsertDocument({
    source_path: '/abs/path/foo.md',
    channel: 'memory',
    project_id: 'erp-platform',
    sha: 'abc',
    mtime_epoch: 1,
    metadata: { description: 'doc-meta' },
  });
  store.replaceChunksForDocument(docId, [
    { chunk_id: 'foo:aaaa1111', text: 'hello', sha: 's', position: 0, metadata: { type: 'a' } },
  ]);
  const result = store.getChunkById('foo:aaaa1111');
  expect(result).not.toBeNull();
  expect(result!.chunk.text).toBe('hello');
  expect(result!.document.metadata.description).toBe('doc-meta');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/meta.test.ts`
Expected: 4 new tests fail (existing 4 still pass).

- [ ] **Step 3: Extend `src/worker/meta.ts` with chunks support**

Add to the SCHEMA constant:

```typescript
const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_path TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL,
  project_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  mtime_epoch INTEGER NOT NULL,
  last_indexed_epoch INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_documents_project_channel ON documents(project_id, channel);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  sha TEXT NOT NULL,
  position INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
`;
```

Add interfaces and methods to the `MetaStore` class:

```typescript
export interface ChunkRow {
  id: number;
  document_id: number;
  chunk_id: string;
  text: string;
  sha: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface ChunkUpsertInput {
  chunk_id: string;
  text: string;
  sha: string;
  position: number;
  metadata: Record<string, unknown>;
}

export interface KeywordHit {
  chunk_id: string;
  rank: number;        // FTS5 BM25 score (lower = more relevant; we'll invert)
}

// Inside class MetaStore, add:

  replaceChunksForDocument(documentId: number, chunks: ChunkUpsertInput[]): void {
    const tx = this.db.transaction((docId: number, items: ChunkUpsertInput[]) => {
      this.db.query('DELETE FROM chunks WHERE document_id = ?').run(docId);
      const insert = this.db.query(
        `INSERT INTO chunks (document_id, chunk_id, text, sha, position, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const c of items) {
        insert.run(docId, c.chunk_id, c.text, c.sha, c.position, JSON.stringify(c.metadata));
      }
    });
    tx(documentId, chunks);
  }

  getChunksForDocument(documentId: number): ChunkRow[] {
    const rows = this.db
      .query('SELECT * FROM chunks WHERE document_id = ? ORDER BY position ASC')
      .all(documentId) as Array<Omit<ChunkRow, 'metadata'> & { metadata: string }>;
    return rows.map(r => ({ ...r, metadata: JSON.parse(r.metadata) }));
  }

  searchKeyword(query: string, topK: number): KeywordHit[] {
    // FTS5 MATCH expects a term — we sanitize by escaping double quotes and wrapping
    const safeQuery = `"${query.replace(/"/g, '""')}"`;
    const rows = this.db
      .query(
        `SELECT chunks.chunk_id AS chunk_id, chunks_fts.rank AS rank
         FROM chunks_fts
         JOIN chunks ON chunks.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY chunks_fts.rank
         LIMIT ?`
      )
      .all(safeQuery, topK) as KeywordHit[];
    return rows;
  }

  getChunkById(chunk_id: string): { chunk: ChunkRow; document: Document } | null {
    const chunkRow = this.db
      .query('SELECT * FROM chunks WHERE chunk_id = ?')
      .get(chunk_id) as (Omit<ChunkRow, 'metadata'> & { metadata: string }) | undefined;
    if (!chunkRow) return null;
    const docRow = this.db
      .query('SELECT * FROM documents WHERE id = ?')
      .get(chunkRow.document_id) as
      | (Omit<Document, 'metadata'> & { metadata: string })
      | undefined;
    if (!docRow) return null;
    return {
      chunk: { ...chunkRow, metadata: JSON.parse(chunkRow.metadata) },
      document: { ...docRow, metadata: JSON.parse(docRow.metadata) },
    };
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/meta.test.ts`
Expected: `8 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/meta.ts tests/unit/meta.test.ts
git commit -m "feat(worker): MetaStore — chunks table, FTS5 keyword search, getChunkById"
```

---

### Task 12: Voyage embedder — basic HTTP client

**Files:**
- Create: `src/worker/embedder.ts`
- Create: `tests/unit/embedder.test.ts`

- [ ] **Step 1: Write the failing test (with mocked HTTP)**

```typescript
// tests/unit/embedder.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { VoyageEmbedder } from '../../src/worker/embedder.ts';
import type { Server } from 'bun';

let mockServer: Server;
let mockPort: number;
let lastRequestBody: any = null;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      lastRequestBody = await req.json();
      const inputs = lastRequestBody.input as string[];
      const data = inputs.map((_, idx) => ({
        embedding: Array.from({ length: 8 }, (_, i) => idx * 8 + i),
        index: idx,
      }));
      return new Response(JSON.stringify({ data, model: 'voyage-4-nano' }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  mockPort = mockServer.port;
});

afterAll(() => {
  mockServer.stop();
});

test('VoyageEmbedder — embeds a single text', async () => {
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${mockPort}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'test-key',
  });
  const result = await embedder.embed(['hello world']);
  expect(result).toHaveLength(1);
  expect(result[0]).toHaveLength(8);
  expect(lastRequestBody.input).toEqual(['hello world']);
  expect(lastRequestBody.model).toBe('voyage-4-nano');
});

test('VoyageEmbedder — embeds multiple texts', async () => {
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${mockPort}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'test-key',
  });
  const result = await embedder.embed(['a', 'b', 'c']);
  expect(result).toHaveLength(3);
});

test('VoyageEmbedder — sends auth header when apiKey provided', async () => {
  let capturedAuth: string | null = null;
  const authServer = Bun.serve({
    port: 0,
    async fetch(req) {
      capturedAuth = req.headers.get('authorization');
      return new Response(JSON.stringify({ data: [{ embedding: [0], index: 0 }], model: 'x' }));
    },
  });
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${authServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    apiKey: 'secret-key',
  });
  await embedder.embed(['x']);
  expect(capturedAuth).toBe('Bearer secret-key');
  authServer.stop();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/embedder.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement basic embedder**

```typescript
// src/worker/embedder.ts
export interface VoyageEmbedderOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  maxBatchSize?: number;
  maxRetries?: number;
}

interface VoyageResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

export class VoyageEmbedder {
  private endpoint: string;
  private model: string;
  private apiKey: string | undefined;
  private timeoutMs: number;
  private maxBatchSize: number;

  constructor(opts: VoyageEmbedderOptions) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.maxBatchSize = opts.maxBatchSize ?? 128;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const embeddings = await this.embedBatch(batch);
      all.push(...embeddings);
    }
    return all;
  }

  private async embedBatch(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: texts, model: this.model }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Voyage HTTP ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as VoyageResponse;
      return json.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/embedder.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/embedder.ts tests/unit/embedder.test.ts
git commit -m "feat(worker): VoyageEmbedder — basic HTTP client with batching + auth"
```

---

### Task 13: Voyage embedder — retry + timeout

**Files:**
- Modify: `src/worker/embedder.ts`
- Modify: `tests/unit/embedder.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/embedder.test.ts`:

```typescript
test('VoyageEmbedder — retries on 5xx with exponential backoff', async () => {
  let callCount = 0;
  const flakyServer = Bun.serve({
    port: 0,
    async fetch() {
      callCount++;
      if (callCount < 3) {
        return new Response('server error', { status: 503 });
      }
      return new Response(JSON.stringify({
        data: [{ embedding: [1, 2, 3], index: 0 }],
        model: 'voyage-4-nano',
      }));
    },
  });
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${flakyServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    maxRetries: 3,
  });
  const result = await embedder.embed(['x']);
  expect(callCount).toBe(3);
  expect(result[0]).toEqual([1, 2, 3]);
  flakyServer.stop();
});

test('VoyageEmbedder — gives up after maxRetries', async () => {
  const brokenServer = Bun.serve({
    port: 0,
    fetch: () => new Response('server error', { status: 503 }),
  });
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${brokenServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    maxRetries: 2,
  });
  await expect(embedder.embed(['x'])).rejects.toThrow(/HTTP 503/);
  brokenServer.stop();
});

test('VoyageEmbedder — does NOT retry on 4xx', async () => {
  let callCount = 0;
  const fourFourServer = Bun.serve({
    port: 0,
    fetch() {
      callCount++;
      return new Response('bad request', { status: 400 });
    },
  });
  const embedder = new VoyageEmbedder({
    endpoint: `http://localhost:${fourFourServer.port}/v1/embeddings`,
    model: 'voyage-4-nano',
    maxRetries: 5,
  });
  await expect(embedder.embed(['x'])).rejects.toThrow(/HTTP 400/);
  expect(callCount).toBe(1);
  fourFourServer.stop();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/embedder.test.ts`
Expected: 3 new tests fail (no retry logic).

- [ ] **Step 3: Add retry logic to `src/worker/embedder.ts`**

Replace the `embedBatch` method:

```typescript
  private async embedBatch(texts: string[]): Promise<number[][]> {
    const maxRetries = (this as any).maxRetries ?? 3;
    let attempt = 0;
    let lastErr: Error | null = null;

    while (attempt < maxRetries) {
      try {
        return await this.embedBatchOnce(texts);
      } catch (err) {
        const e = err as Error;
        lastErr = e;
        // Retry only on 5xx-style transient failures
        const is5xx = /HTTP 5\d\d/.test(e.message);
        const isTimeout = e.name === 'AbortError' || /aborted/i.test(e.message);
        if (!(is5xx || isTimeout)) throw e;
        attempt++;
        if (attempt >= maxRetries) throw e;
        const backoffMs = 100 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
    throw lastErr ?? new Error('embedBatch: unreachable');
  }

  private async embedBatchOnce(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ input: texts, model: this.model }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Voyage HTTP ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as VoyageResponse;
      return json.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
    } finally {
      clearTimeout(timeout);
    }
  }
```

Also store `maxRetries` in the constructor:
```typescript
  private maxRetries: number;
  constructor(opts: VoyageEmbedderOptions) {
    // ... existing assignments ...
    this.maxRetries = opts.maxRetries ?? 3;
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/embedder.test.ts`
Expected: `6 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/embedder.ts tests/unit/embedder.test.ts
git commit -m "feat(worker): VoyageEmbedder — retry on 5xx with exponential backoff, no retry on 4xx"
```

---

### Task 14: Chroma client — subprocess wrapper

**Files:**
- Create: `src/worker/chroma.ts`
- Create: `tests/integration/chroma.test.ts`

This task requires the Chroma MCP subprocess (which is part of the install precondition; tests will skip gracefully if Chroma isn't reachable).

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/chroma.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { ChromaClient } from '../../src/worker/chroma.ts';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dataDir: string;
let client: ChromaClient;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'captain-memo-chroma-test-'));
  client = new ChromaClient({ dataDir });
  await client.connect();
});

afterAll(async () => {
  await client.close();
  if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true });
});

test('ChromaClient — connects and creates a collection', async () => {
  await client.ensureCollection('captain_memo_test');
  // Idempotent — second call should not throw
  await client.ensureCollection('captain_memo_test');
});

test('ChromaClient — adds and queries vectors', async () => {
  await client.ensureCollection('captain_memo_test_query');
  await client.add('captain_memo_test_query', [
    { id: 'chunk-a', embedding: [1, 0, 0, 0], document: 'apple', metadata: { kind: 'fruit' } },
    { id: 'chunk-b', embedding: [0, 1, 0, 0], document: 'car', metadata: { kind: 'vehicle' } },
  ]);
  const results = await client.query('captain_memo_test_query', [0.99, 0.01, 0, 0], 2);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]!.id).toBe('chunk-a'); // Closest to [1,0,0,0]
});

test('ChromaClient — deletes by id', async () => {
  await client.ensureCollection('captain_memo_test_delete');
  await client.add('captain_memo_test_delete', [
    { id: 'd1', embedding: [1, 0], document: 'first', metadata: {} },
    { id: 'd2', embedding: [0, 1], document: 'second', metadata: {} },
  ]);
  await client.delete('captain_memo_test_delete', ['d1']);
  const results = await client.query('captain_memo_test_delete', [1, 0], 5);
  expect(results.find(r => r.id === 'd1')).toBeUndefined();
  expect(results.find(r => r.id === 'd2')).toBeDefined();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/chroma.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement ChromaClient**

```typescript
// src/worker/chroma.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface ChromaClientOptions {
  dataDir: string;
  embeddingFunction?: string; // default: 'default' (we override with our own embeddings via add())
}

export interface AddVectorInput {
  id: string;
  embedding: number[];
  document: string;
  metadata: Record<string, unknown>;
}

export interface QueryResult {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
}

export class ChromaClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private dataDir: string;
  private connected = false;

  constructor(opts: ChromaClientOptions) {
    this.dataDir = opts.dataDir;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.transport = new StdioClientTransport({
      command: 'uvx',
      args: ['chroma-mcp', '--data-dir', this.dataDir],
    });
    this.client = new Client({ name: 'captain-memo-chroma', version: '0.1.0' }, { capabilities: {} });
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async ensureCollection(name: string): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    try {
      await this.client.callTool({
        name: 'chroma_get_collection_info',
        arguments: { collection_name: name },
      });
    } catch {
      await this.client.callTool({
        name: 'chroma_create_collection',
        arguments: { collection_name: name, embedding_function_name: 'default' },
      });
    }
  }

  async add(collection: string, items: AddVectorInput[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    if (items.length === 0) return;
    await this.client.callTool({
      name: 'chroma_add_documents',
      arguments: {
        collection_name: collection,
        ids: items.map(i => i.id),
        embeddings: items.map(i => i.embedding),
        documents: items.map(i => i.document),
        metadatas: items.map(i => i.metadata),
      },
    });
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    if (!this.client) throw new Error('Not connected');
    if (ids.length === 0) return;
    await this.client.callTool({
      name: 'chroma_delete_documents',
      arguments: { collection_name: collection, ids },
    });
  }

  async query(collection: string, embedding: number[], topK: number): Promise<QueryResult[]> {
    if (!this.client) throw new Error('Not connected');
    const result = await this.client.callTool({
      name: 'chroma_query_documents',
      arguments: {
        collection_name: collection,
        query_embeddings: [embedding],
        n_results: topK,
      },
    }) as any;
    // Chroma returns parallel arrays; flatten to objects for the first query
    const ids = result?.ids?.[0] ?? [];
    const docs = result?.documents?.[0] ?? [];
    const metas = result?.metadatas?.[0] ?? [];
    const distances = result?.distances?.[0] ?? [];
    return ids.map((id: string, idx: number) => ({
      id,
      document: docs[idx] ?? '',
      metadata: metas[idx] ?? {},
      distance: distances[idx] ?? 0,
    }));
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.client = null;
    this.connected = false;
  }
}
```

- [ ] **Step 4: Run — verify pass (requires Chroma installed via `uvx`)**

```bash
# Prereq: ensure chroma-mcp is installed
uvx --help && uvx chroma-mcp --help || pip install chroma-mcp
bun test tests/integration/chroma.test.ts
```
Expected: `3 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/chroma.ts tests/integration/chroma.test.ts
git commit -m "feat(worker): ChromaClient — MCP-subprocess wrapper for collection + vector ops"
```

---

### Task 15: RRF fusion (pure logic)

**Files:**
- Create: `src/worker/search.ts` (RRF function only — full searcher in Task 17)
- Create: `tests/unit/search.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/search.test.ts
import { test, expect } from 'bun:test';
import { reciprocalRankFusion } from '../../src/worker/search.ts';

test('reciprocalRankFusion — single ranked list returns same order', () => {
  const fused = reciprocalRankFusion([['a', 'b', 'c']], 60);
  const ids = fused.map(f => f.id);
  expect(ids).toEqual(['a', 'b', 'c']);
});

test('reciprocalRankFusion — items appearing in multiple lists rank higher', () => {
  const fused = reciprocalRankFusion([
    ['a', 'b', 'c'],   // a is rank 1 here
    ['c', 'a', 'd'],   // a is rank 2 here
  ], 60);
  // a appears in both lists → highest aggregate score
  expect(fused[0]!.id).toBe('a');
});

test('reciprocalRankFusion — score formula 1/(k + rank)', () => {
  const fused = reciprocalRankFusion([['x']], 60);
  expect(fused[0]!.score).toBeCloseTo(1 / 61, 5); // rank=1 (1-indexed)
});

test('reciprocalRankFusion — empty input returns empty', () => {
  expect(reciprocalRankFusion([], 60)).toEqual([]);
  expect(reciprocalRankFusion([[]], 60)).toEqual([]);
});

test('reciprocalRankFusion — fused scores normalized to 0-1 range', () => {
  const fused = reciprocalRankFusion([['a', 'b', 'c'], ['a', 'c', 'b']], 60);
  for (const item of fused) {
    expect(item.score).toBeGreaterThanOrEqual(0);
    expect(item.score).toBeLessThanOrEqual(1);
  }
  // Top item should have highest score
  expect(fused[0]!.score).toBeGreaterThanOrEqual(fused[1]!.score);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/search.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement RRF**

```typescript
// src/worker/search.ts
export interface FusedItem {
  id: string;
  score: number;          // Normalized 0-1
}

/**
 * Reciprocal Rank Fusion.
 *
 * For each ranked list, each item gets a score of 1 / (k + rank), where rank is
 * 1-indexed. Items appearing in multiple lists have their per-list scores summed.
 * Final scores are normalized to 0-1 by dividing by the maximum possible score.
 */
export function reciprocalRankFusion(rankedLists: string[][], k: number): FusedItem[] {
  if (rankedLists.length === 0) return [];

  const aggregate = new Map<string, number>();
  for (const list of rankedLists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      aggregate.set(id, (aggregate.get(id) ?? 0) + contribution);
    }
  }
  if (aggregate.size === 0) return [];

  // Normalize: max possible score = sum of (1/(k+1)) across all lists
  const maxPossible = rankedLists.length * (1 / (k + 1));

  const items: FusedItem[] = Array.from(aggregate, ([id, raw]) => ({
    id,
    score: maxPossible > 0 ? raw / maxPossible : 0,
  }));
  items.sort((a, b) => b.score - a.score);
  return items;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/search.test.ts`
Expected: `5 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/search.ts tests/unit/search.test.ts
git commit -m "feat(search): reciprocalRankFusion — pure RRF math, normalized 0-1 scores"
```

---

### Task 16: Hybrid searcher composition

**Files:**
- Modify: `src/worker/search.ts` (add HybridSearcher class)
- Modify: `tests/unit/search.test.ts`

- [ ] **Step 1: Add failing tests for HybridSearcher**

Append to `tests/unit/search.test.ts`:

```typescript
import { HybridSearcher } from '../../src/worker/search.ts';

test('HybridSearcher — fuses vector + keyword results', async () => {
  const searcher = new HybridSearcher({
    vectorSearch: async () => [
      { id: 'a', distance: 0.1 },
      { id: 'b', distance: 0.2 },
      { id: 'c', distance: 0.3 },
    ],
    keywordSearch: async () => [
      { chunk_id: 'b' },
      { chunk_id: 'a' },
    ],
    rrfK: 60,
  });
  const fused = await searcher.search([0, 0], 'query', 5);
  expect(fused.length).toBeGreaterThan(0);
  // Items in both lists should rank above items in only one
  const ids = fused.map(f => f.id);
  expect(ids.indexOf('a')).toBeLessThan(ids.indexOf('c'));
  expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('c'));
});

test('HybridSearcher — limits results to topK', async () => {
  const searcher = new HybridSearcher({
    vectorSearch: async () => [
      { id: 'a', distance: 0.1 },
      { id: 'b', distance: 0.2 },
      { id: 'c', distance: 0.3 },
      { id: 'd', distance: 0.4 },
      { id: 'e', distance: 0.5 },
    ],
    keywordSearch: async () => [],
    rrfK: 60,
  });
  const fused = await searcher.search([0, 0], 'q', 3);
  expect(fused).toHaveLength(3);
});

test('HybridSearcher — falls back gracefully when keyword search fails', async () => {
  const searcher = new HybridSearcher({
    vectorSearch: async () => [{ id: 'a', distance: 0.1 }],
    keywordSearch: async () => { throw new Error('FTS5 broke'); },
    rrfK: 60,
  });
  const fused = await searcher.search([0, 0], 'q', 5);
  expect(fused).toHaveLength(1);
  expect(fused[0]!.id).toBe('a');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/unit/search.test.ts`
Expected: 3 new tests fail.

- [ ] **Step 3: Add `HybridSearcher` to `src/worker/search.ts`**

Append to `src/worker/search.ts`:

```typescript
export interface VectorHit {
  id: string;
  distance: number;
}

export interface KeywordHit {
  chunk_id: string;
}

export interface HybridSearcherOptions {
  vectorSearch: (embedding: number[], topK: number) => Promise<VectorHit[]>;
  keywordSearch: (query: string, topK: number) => Promise<KeywordHit[]>;
  rrfK?: number;
  perStrategyTopK?: number;
}

export class HybridSearcher {
  private vectorSearch: HybridSearcherOptions['vectorSearch'];
  private keywordSearch: HybridSearcherOptions['keywordSearch'];
  private rrfK: number;
  private perStrategyTopK: number;

  constructor(opts: HybridSearcherOptions) {
    this.vectorSearch = opts.vectorSearch;
    this.keywordSearch = opts.keywordSearch;
    this.rrfK = opts.rrfK ?? 60;
    this.perStrategyTopK = opts.perStrategyTopK ?? 25;
  }

  async search(embedding: number[], query: string, topK: number): Promise<FusedItem[]> {
    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(embedding, this.perStrategyTopK).catch(() => []),
      this.keywordSearch(query, this.perStrategyTopK).catch(() => []),
    ]);

    const vectorIds = vectorResults.map(r => r.id);
    const keywordIds = keywordResults.map(r => r.chunk_id);

    const fused = reciprocalRankFusion([vectorIds, keywordIds], this.rrfK);
    return fused.slice(0, topK);
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/unit/search.test.ts`
Expected: `8 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/search.ts tests/unit/search.test.ts
git commit -m "feat(search): HybridSearcher — vector + keyword + RRF, graceful fallback"
```

---

### Task 17: Ingest pipeline — chunker dispatch

**Files:**
- Create: `src/worker/ingest.ts`
- Create: `tests/integration/ingest.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/ingest.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { IngestPipeline } from '../../src/worker/ingest.ts';
import { MetaStore } from '../../src/worker/meta.ts';
import { writeFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sha256Hex } from '../../src/shared/sha.ts';

let workDir: string;
let dbPath: string;
let store: MetaStore;
let pipeline: IngestPipeline;

const fakeEmbedder = {
  embed: async (texts: string[]) => texts.map(() => Array.from({ length: 8 }, () => Math.random())),
};

const fakeChroma = {
  ensureCollection: async () => {},
  add: async () => {},
  delete: async () => {},
  query: async () => [],
};

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-ingest-'));
  dbPath = join(workDir, 'meta.sqlite3');
  store = new MetaStore(dbPath);
  pipeline = new IngestPipeline({
    meta: store,
    embedder: fakeEmbedder,
    chroma: fakeChroma as any,
    collectionName: 'test_col',
    projectId: 'erp-platform',
  });
});

afterEach(() => {
  store.close();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('IngestPipeline — indexes a memory file', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, '---\ntype: feedback\ndescription: test\n---\nDo not use vocative.');
  await pipeline.indexFile(filePath, 'memory');
  const doc = store.getDocument(filePath);
  expect(doc).not.toBeNull();
  expect(doc!.channel).toBe('memory');
  const chunks = store.getChunksForDocument(doc!.id);
  expect(chunks.length).toBe(1);
});

test('IngestPipeline — skips re-indexing when sha unchanged', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, 'unchanged content');
  await pipeline.indexFile(filePath, 'memory');
  const before = store.getDocument(filePath);
  const beforeIndexed = before!.last_indexed_epoch;

  // Wait a sec to ensure mtime would change if rewritten
  await new Promise(r => setTimeout(r, 1100));

  await pipeline.indexFile(filePath, 'memory');
  const after = store.getDocument(filePath);
  expect(after!.last_indexed_epoch).toBe(beforeIndexed);
});

test('IngestPipeline — re-indexes when content changes', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, 'first version');
  await pipeline.indexFile(filePath, 'memory');
  const before = store.getDocument(filePath);

  writeFileSync(filePath, 'second version');
  await pipeline.indexFile(filePath, 'memory');
  const after = store.getDocument(filePath);

  expect(after!.sha).not.toBe(before!.sha);
});

test('IngestPipeline — deleteFile drops document and chunks', async () => {
  const filePath = join(workDir, 'feedback_test.md');
  writeFileSync(filePath, 'content');
  await pipeline.indexFile(filePath, 'memory');
  expect(store.getDocument(filePath)).not.toBeNull();

  await pipeline.deleteFile(filePath);
  expect(store.getDocument(filePath)).toBeNull();
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/ingest.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement IngestPipeline**

```typescript
// src/worker/ingest.ts
import { readFileSync, statSync } from 'fs';
import { sha256Hex } from '../shared/sha.ts';
import { newChunkId } from '../shared/id.ts';
import { chunkMemoryFile } from './chunkers/memory-file.ts';
import { chunkSkill } from './chunkers/skill.ts';
import type { ChannelType, ChunkInput } from '../shared/types.ts';
import type { MetaStore } from './meta.ts';
import type { ChromaClient } from './chroma.ts';
import type { VoyageEmbedder } from './embedder.ts';

export interface IngestPipelineOptions {
  meta: MetaStore;
  embedder: { embed: (texts: string[]) => Promise<number[][]> };
  chroma: ChromaClient;
  collectionName: string;
  projectId: string;
}

export class IngestPipeline {
  private meta: MetaStore;
  private embedder: { embed: (texts: string[]) => Promise<number[][]> };
  private chroma: ChromaClient;
  private collection: string;
  private projectId: string;

  constructor(opts: IngestPipelineOptions) {
    this.meta = opts.meta;
    this.embedder = opts.embedder;
    this.chroma = opts.chroma;
    this.collection = opts.collectionName;
    this.projectId = opts.projectId;
  }

  private chunkerFor(channel: ChannelType, content: string, sourcePath: string): ChunkInput[] {
    if (channel === 'memory') return chunkMemoryFile(content, sourcePath);
    if (channel === 'skill') return chunkSkill(content, sourcePath);
    throw new Error(`No file-based chunker for channel: ${channel}`);
  }

  async indexFile(filePath: string, channel: ChannelType): Promise<void> {
    const content = readFileSync(filePath, 'utf-8');
    const sha = sha256Hex(content);
    const stat = statSync(filePath);
    const mtime_epoch = Math.floor(stat.mtimeMs / 1000);

    const existing = this.meta.getDocument(filePath);
    if (existing && existing.sha === sha) return;

    const chunks = this.chunkerFor(channel, content, filePath);

    // Drop old chunks from Chroma
    if (existing) {
      const oldChunks = this.meta.getChunksForDocument(existing.id);
      if (oldChunks.length > 0) {
        await this.chroma.delete(this.collection, oldChunks.map(c => c.chunk_id));
      }
    }

    // Embed and add new chunks
    if (chunks.length > 0) {
      const embeddings = await this.embedder.embed(chunks.map(c => c.text));
      const sourceKey = filePath.split('/').pop()!.replace(/\.md$/, '');
      const chunksWithIds = chunks.map((c, i) => ({
        chunk_id: newChunkId(channel, sourceKey),
        text: c.text,
        sha: sha256Hex(c.text),
        position: c.position,
        metadata: c.metadata,
        embedding: embeddings[i]!,
      }));

      const documentId = this.meta.upsertDocument({
        source_path: filePath,
        channel,
        project_id: this.projectId,
        sha,
        mtime_epoch,
        metadata: {},
      });

      this.meta.replaceChunksForDocument(documentId, chunksWithIds.map(c => ({
        chunk_id: c.chunk_id,
        text: c.text,
        sha: c.sha,
        position: c.position,
        metadata: c.metadata,
      })));

      await this.chroma.add(this.collection, chunksWithIds.map(c => ({
        id: c.chunk_id,
        embedding: c.embedding,
        document: c.text,
        metadata: { ...c.metadata, source_path: filePath, project_id: this.projectId },
      })));
    }
  }

  async deleteFile(filePath: string): Promise<void> {
    const existing = this.meta.getDocument(filePath);
    if (!existing) return;
    const oldChunks = this.meta.getChunksForDocument(existing.id);
    if (oldChunks.length > 0) {
      await this.chroma.delete(this.collection, oldChunks.map(c => c.chunk_id));
    }
    this.meta.deleteDocument(filePath);
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/integration/ingest.test.ts`
Expected: `4 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/ingest.ts tests/integration/ingest.test.ts
git commit -m "feat(worker): IngestPipeline — chunker dispatch + sha diff + Chroma upsert"
```

---

### Task 18: File watcher

**Files:**
- Create: `src/worker/watcher.ts`
- Create: `tests/integration/watcher.test.ts`

- [ ] **Step 1: Write the integration test**

```typescript
// tests/integration/watcher.test.ts
import { test, expect, beforeEach, afterEach } from 'bun:test';
import { FileWatcher } from '../../src/worker/watcher.ts';
import { writeFileSync, mkdtempSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let workDir: string;
let watcher: FileWatcher;
let events: Array<{ type: string; path: string }>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-watch-'));
  events = [];
});

afterEach(async () => {
  if (watcher) await watcher.close();
  rmSync(workDir, { recursive: true, force: true });
});

test('FileWatcher — fires on file create', async () => {
  watcher = new FileWatcher({
    paths: [join(workDir, '*.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  // Wait briefly for watcher to be ready
  await new Promise(r => setTimeout(r, 100));

  writeFileSync(join(workDir, 'new.md'), 'content');
  await new Promise(r => setTimeout(r, 200));

  expect(events.some(e => e.type === 'add' && e.path.endsWith('new.md'))).toBe(true);
});

test('FileWatcher — fires on file change', async () => {
  const filePath = join(workDir, 'existing.md');
  writeFileSync(filePath, 'v1');
  watcher = new FileWatcher({
    paths: [join(workDir, '*.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  await new Promise(r => setTimeout(r, 100));
  events.length = 0; // ignore initial add

  writeFileSync(filePath, 'v2');
  await new Promise(r => setTimeout(r, 200));

  expect(events.some(e => e.type === 'change' && e.path.endsWith('existing.md'))).toBe(true);
});

test('FileWatcher — fires on file delete', async () => {
  const filePath = join(workDir, 'deletable.md');
  writeFileSync(filePath, 'will be deleted');
  watcher = new FileWatcher({
    paths: [join(workDir, '*.md')],
    debounceMs: 50,
    onEvent: (type, path) => events.push({ type, path }),
  });
  await watcher.start();
  await new Promise(r => setTimeout(r, 100));
  events.length = 0;

  unlinkSync(filePath);
  await new Promise(r => setTimeout(r, 200));

  expect(events.some(e => e.type === 'unlink' && e.path.endsWith('deletable.md'))).toBe(true);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/watcher.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement FileWatcher**

```typescript
// src/worker/watcher.ts
import chokidar, { type FSWatcher } from 'chokidar';

export type WatcherEvent = 'add' | 'change' | 'unlink';

export interface FileWatcherOptions {
  paths: string[];
  debounceMs?: number;
  onEvent: (type: WatcherEvent, path: string) => void | Promise<void>;
}

export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private opts: FileWatcherOptions;

  constructor(opts: FileWatcherOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const debounceMs = this.opts.debounceMs ?? 500;
    this.watcher = chokidar.watch(this.opts.paths, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: debounceMs,
        pollInterval: 50,
      },
      persistent: true,
    });

    this.watcher.on('add', path => this.dispatch('add', path));
    this.watcher.on('change', path => this.dispatch('change', path));
    this.watcher.on('unlink', path => this.dispatch('unlink', path));

    // Wait for ready
    await new Promise<void>(resolve => {
      this.watcher!.once('ready', () => resolve());
    });
  }

  private async dispatch(type: WatcherEvent, path: string): Promise<void> {
    try {
      await this.opts.onEvent(type, path);
    } catch (err) {
      console.error(`[FileWatcher] handler error for ${type} ${path}:`, err);
    }
  }

  async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/integration/watcher.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/watcher.ts tests/integration/watcher.test.ts
git commit -m "feat(worker): FileWatcher — chokidar wrapper with debounce + event dispatch"
```

---

### Task 19: Worker bootstrap (HTTP server)

**Files:**
- Create: `src/worker/index.ts`
- Create: `tests/integration/worker-http.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/integration/worker-http.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';

let worker: WorkerHandle;
const PORT = 39891; // Test port distinct from default

beforeAll(async () => {
  worker = await startWorker({
    port: PORT,
    projectId: 'test-project',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    chromaDataDir: '/tmp/captain-memo-worker-test-chroma',
    skipChromaConnect: true,
  });
});

afterAll(async () => {
  await worker.stop();
});

test('worker — responds to /health with 200', async () => {
  const res = await fetch(`http://localhost:${PORT}/health`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.healthy).toBe(true);
});

test('worker — responds to /stats with corpus info', async () => {
  const res = await fetch(`http://localhost:${PORT}/stats`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('total_chunks');
  expect(body).toHaveProperty('by_channel');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: module not found.

- [ ] **Step 3: Implement worker bootstrap**

```typescript
// src/worker/index.ts
import { MetaStore } from './meta.ts';
import { VoyageEmbedder } from './embedder.ts';
import { ChromaClient } from './chroma.ts';

export interface WorkerOptions {
  port: number;
  projectId: string;
  metaDbPath: string;
  embedderEndpoint: string;
  embedderModel: string;
  embedderApiKey?: string;
  chromaDataDir: string;
  skipChromaConnect?: boolean;
}

export interface WorkerHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startWorker(opts: WorkerOptions): Promise<WorkerHandle> {
  const meta = new MetaStore(opts.metaDbPath);
  const embedder = new VoyageEmbedder({
    endpoint: opts.embedderEndpoint,
    model: opts.embedderModel,
    apiKey: opts.embedderApiKey,
  });
  const chroma = new ChromaClient({ dataDir: opts.chromaDataDir });
  if (!opts.skipChromaConnect) {
    await chroma.connect();
  }

  const server = Bun.serve({
    port: opts.port,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname === '/health') {
          return Response.json({ healthy: true });
        }
        if (url.pathname === '/stats') {
          // Stub for now — real stats in Task 26
          return Response.json({
            total_chunks: 0,
            by_channel: {},
            project_id: opts.projectId,
          });
        }
        return new Response('Not found', { status: 404 });
      } catch (err) {
        const e = err as Error;
        return Response.json({ error: e.message }, { status: 500 });
      }
    },
  });

  return {
    port: server.port,
    async stop() {
      server.stop();
      await chroma.close();
      meta.close();
    },
  };
}

// Run as standalone if invoked directly
if (import.meta.main) {
  const { DEFAULT_WORKER_PORT, META_DB_PATH, VECTOR_DB_DIR, DEFAULT_VOYAGE_ENDPOINT } = await import('../shared/paths.ts');
  await startWorker({
    port: parseInt(process.env.CAPTAIN_MEMO_WORKER_PORT ?? `${DEFAULT_WORKER_PORT}`),
    projectId: process.env.CAPTAIN_MEMO_PROJECT_ID ?? 'default',
    metaDbPath: META_DB_PATH,
    embedderEndpoint: process.env.CAPTAIN_MEMO_VOYAGE_ENDPOINT ?? DEFAULT_VOYAGE_ENDPOINT,
    embedderModel: process.env.CAPTAIN_MEMO_VOYAGE_MODEL ?? 'voyage-4-nano',
    embedderApiKey: process.env.CAPTAIN_MEMO_VOYAGE_API_KEY,
    chromaDataDir: VECTOR_DB_DIR,
  });
  console.log(`captain-memo worker listening on :${DEFAULT_WORKER_PORT}`);
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: `2 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-http.test.ts
git commit -m "feat(worker): startWorker — HTTP server with /health, /stats; standalone entrypoint"
```

---

### Task 20: Worker — search HTTP endpoint

**Files:**
- Modify: `src/worker/index.ts` (add `/search/all` endpoint + wire searcher)
- Modify: `tests/integration/worker-http.test.ts`

- [ ] **Step 1: Add failing test**

Append to `tests/integration/worker-http.test.ts`:

```typescript
test('worker — /search/all returns hybrid results structure', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test', top_k: 5 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('results');
  expect(body).toHaveProperty('by_channel');
  expect(Array.isArray(body.results)).toBe(true);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: 404 from /search/all.

- [ ] **Step 3: Add search endpoint to worker**

In `src/worker/index.ts`, add HybridSearcher initialization and the endpoint:

```typescript
// Add import
import { HybridSearcher } from './search.ts';
import { z } from 'zod';

// Inside startWorker, after creating embedder/chroma/meta:
const searcher = new HybridSearcher({
  vectorSearch: async (embedding, topK) => {
    if (opts.skipChromaConnect) return [];
    const results = await chroma.query(`am_${opts.projectId}`, embedding, topK);
    return results.map(r => ({ id: r.id, distance: r.distance }));
  },
  keywordSearch: async (query, topK) => meta.searchKeyword(query, topK),
});

const SearchRequestSchema = z.object({
  query: z.string(),
  top_k: z.number().int().positive().max(50).default(5),
  channels: z.array(z.enum(['memory', 'skill', 'observation', 'remote'])).optional(),
});
```

Replace the `fetch` handler to add the new endpoint:

```typescript
async fetch(req) {
  const url = new URL(req.url);
  try {
    if (url.pathname === '/health') {
      return Response.json({ healthy: true });
    }
    if (url.pathname === '/stats') {
      return Response.json({
        total_chunks: 0,
        by_channel: {},
        project_id: opts.projectId,
      });
    }
    if (url.pathname === '/search/all' && req.method === 'POST') {
      const parsed = SearchRequestSchema.safeParse(await req.json());
      if (!parsed.success) {
        return Response.json({ error: 'invalid_request', details: parsed.error.format() }, { status: 400 });
      }
      const { query, top_k } = parsed.data;
      // Embed the query (skip if Chroma disabled — return keyword-only)
      let embedding: number[] = [];
      if (!opts.skipChromaConnect) {
        try {
          const [emb] = await embedder.embed([query]);
          embedding = emb ?? [];
        } catch {
          // fall back to keyword-only on embed failure
        }
      }
      const fused = await searcher.search(embedding, query, top_k);
      const results = fused.map(f => {
        const lookup = meta.getChunkById(f.id);
        if (!lookup) return null;
        const { chunk, document } = lookup;
        const titleMeta = chunk.metadata as Record<string, unknown>;
        return {
          doc_id: chunk.chunk_id,
          source_path: document.source_path,
          title: (titleMeta.section_title ?? titleMeta.filename_id ?? titleMeta.title ?? 'Untitled') as string,
          snippet: chunk.text.slice(0, 600),
          score: f.score,
          channel: document.channel,
          metadata: chunk.metadata,
        };
      }).filter((r): r is NonNullable<typeof r> => r !== null);

      const by_channel: Record<string, number> = {};
      for (const r of results) by_channel[r.channel] = (by_channel[r.channel] ?? 0) + 1;
      return Response.json({ results, by_channel });
    }
    return new Response('Not found', { status: 404 });
  } catch (err) {
    const e = err as Error;
    return Response.json({ error: e.message }, { status: 500 });
  }
},
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: `3 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-http.test.ts
git commit -m "feat(worker): /search/all endpoint — hybrid search with zod-validated request"
```

---

### Task 21: Worker — channel-specific search endpoints

**Files:**
- Modify: `src/worker/index.ts` (add `/search/memory`, `/search/skill`, `/search/observations`)
- Modify: `tests/integration/worker-http.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/integration/worker-http.test.ts`:

```typescript
test('worker — /search/memory accepts type filter', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test', type: 'feedback', top_k: 5 }),
  });
  expect(res.status).toBe(200);
});

test('worker — /search/skill accepts skill_id filter', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/skill`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'test', skill_id: 'erp-coding-standards', top_k: 3 }),
  });
  expect(res.status).toBe(200);
});

test('worker — /search/observations accepts type and files filters', async () => {
  const res = await fetch(`http://localhost:${PORT}/search/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: 'bug',
      type: 'bugfix',
      files: ['core/inc/forms.php'],
      top_k: 5,
    }),
  });
  expect(res.status).toBe(200);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: 3 new tests get 404.

- [ ] **Step 3: Add channel-specific endpoints**

Add schemas and endpoints in `src/worker/index.ts`:

```typescript
// Add schemas near existing SearchRequestSchema:
const MemorySearchSchema = z.object({
  query: z.string(),
  type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
  project: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(5),
});

const SkillSearchSchema = z.object({
  query: z.string(),
  skill_id: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(3),
});

const ObservationSearchSchema = z.object({
  query: z.string(),
  type: z.enum(['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change']).optional(),
  files: z.array(z.string()).optional(),
  since: z.string().optional(),
  project: z.string().optional(),
  top_k: z.number().int().positive().max(50).default(5),
});
```

Add the endpoint handlers (in the fetch handler, before the 404 fallback):

```typescript
if (url.pathname === '/search/memory' && req.method === 'POST') {
  const parsed = MemorySearchSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const results = await searchByChannel(parsed.data.query, 'memory', parsed.data.top_k, {
    memory_type: parsed.data.type,
  });
  return Response.json({ results });
}

if (url.pathname === '/search/skill' && req.method === 'POST') {
  const parsed = SkillSearchSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const results = await searchByChannel(parsed.data.query, 'skill', parsed.data.top_k, {
    skill_id: parsed.data.skill_id,
  });
  return Response.json({ results });
}

if (url.pathname === '/search/observations' && req.method === 'POST') {
  const parsed = ObservationSearchSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const results = await searchByChannel(parsed.data.query, 'observation', parsed.data.top_k, {
    obs_type: parsed.data.type,
    files: parsed.data.files,
  });
  return Response.json({ results });
}
```

Add the helper function (above the `Bun.serve` call inside `startWorker`):

```typescript
const searchByChannel = async (
  query: string,
  channel: 'memory' | 'skill' | 'observation',
  topK: number,
  filters: Record<string, unknown>,
): Promise<unknown[]> => {
  let embedding: number[] = [];
  if (!opts.skipChromaConnect) {
    try {
      const [emb] = await embedder.embed([query]);
      embedding = emb ?? [];
    } catch { /* fall back to keyword-only */ }
  }
  const fused = await searcher.search(embedding, query, topK * 3);
  const results: any[] = [];
  for (const f of fused) {
    const lookup = meta.getChunkById(f.id);
    if (!lookup) continue;
    if (lookup.document.channel !== channel) continue;

    // Apply per-channel filters
    const m = lookup.chunk.metadata as Record<string, unknown>;
    if (filters.memory_type && m.memory_type !== filters.memory_type) continue;
    if (filters.skill_id && m.skill_id !== filters.skill_id) continue;
    if (filters.obs_type && m.type !== filters.obs_type) continue;
    if (filters.files && Array.isArray(filters.files)) {
      const filesList = (m.files_modified ?? m.files_read ?? []) as string[];
      const hasMatch = (filters.files as string[]).some(f => filesList.includes(f));
      if (!hasMatch) continue;
    }

    results.push({
      doc_id: lookup.chunk.chunk_id,
      source_path: lookup.document.source_path,
      title: (m.section_title ?? m.filename_id ?? m.title ?? 'Untitled') as string,
      snippet: lookup.chunk.text.slice(0, 600),
      score: f.score,
      channel: lookup.document.channel,
      metadata: m,
    });
    if (results.length >= topK) break;
  }
  return results;
};
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: `6 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-http.test.ts
git commit -m "feat(worker): channel-specific /search/{memory,skill,observations} with filters"
```

---

### Task 22: Worker — get_full + reindex endpoints

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `tests/integration/worker-http.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/integration/worker-http.test.ts`:

```typescript
test('worker — /get_full returns 404 for unknown doc_id', async () => {
  const res = await fetch(`http://localhost:${PORT}/get_full`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc_id: 'nonexistent:foo:abcd1234' }),
  });
  expect(res.status).toBe(404);
});

test('worker — /reindex accepts channel parameter', async () => {
  const res = await fetch(`http://localhost:${PORT}/reindex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'memory' }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('indexed');
  expect(body).toHaveProperty('skipped');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: 2 new tests get 404.

- [ ] **Step 3: Add endpoints**

In `src/worker/index.ts`:

```typescript
// Add schemas:
const GetFullSchema = z.object({ doc_id: z.string() });
const ReindexSchema = z.object({
  channel: z.enum(['memory', 'skill', 'observation', 'all']).default('all'),
  force: z.boolean().default(false),
});
```

Add endpoint handlers:

```typescript
if (url.pathname === '/get_full' && req.method === 'POST') {
  const parsed = GetFullSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const result = meta.getChunkById(parsed.data.doc_id);
  if (!result) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json({
    content: result.chunk.text,
    metadata: { ...result.chunk.metadata, ...result.document.metadata, source_path: result.document.source_path },
  });
}

if (url.pathname === '/reindex' && req.method === 'POST') {
  const parsed = ReindexSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  // Stub for v0 — real reindex implementation in Task 25 once watcher is wired
  return Response.json({ indexed: 0, skipped: 0, errors: 0 });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/integration/worker-http.test.ts`
Expected: `8 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-http.test.ts
git commit -m "feat(worker): /get_full + /reindex endpoint stubs (reindex impl follows in Task 25)"
```

---

### Task 23: MCP server (stdio) — scaffold + 3 tools

**Files:**
- Create: `src/mcp-server.ts`

- [ ] **Step 1: Implement stdio MCP server with 3 tools (search_memory, search_skill, search_observations)**

```typescript
// src/mcp-server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_WORKER_PORT } from './shared/paths.ts';

const WORKER_BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

async function workerPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${WORKER_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`worker ${path} returned ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search across local memory files (curated user memory). Returns top-K results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference'] },
        project: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_skill',
    description: 'Search across skill bodies (section-level). Returns top-K matching sections.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        skill_id: { type: 'string' },
        top_k: { type: 'number', default: 3 },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_observations',
    description: 'Search across captured session observations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'] },
        files: { type: 'array', items: { type: 'string' } },
        since: { type: 'string' },
        top_k: { type: 'number', default: 5 },
      },
      required: ['query'],
    },
  },
];

const server = new Server(
  { name: 'captain-memo', version: '0.1.0-alpha' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let result: unknown;
  try {
    if (name === 'search_memory') result = await workerPost('/search/memory', args);
    else if (name === 'search_skill') result = await workerPost('/search/skill', args);
    else if (name === 'search_observations') result = await workerPost('/search/observations', args);
    else throw new Error(`unknown tool: ${name}`);
  } catch (err) {
    const e = err as Error;
    return {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('captain-memo stdio MCP server connected');
```

- [ ] **Step 2: Smoke test — start the worker, then connect MCP server in stdio mode**

```bash
# Terminal 1
bun run worker:start

# Terminal 2 — manual stdio handshake
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | bun run mcp:start
```

Expected: stdout returns JSON listing the 3 tools (search_memory, search_skill, search_observations).

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat(mcp): stdio server with 3 search tools (memory/skill/observations)"
```

---

### Task 24: MCP server — remaining 5 tools (search_all, get_full, reindex, stats, status)

**Files:**
- Modify: `src/mcp-server.ts`

- [ ] **Step 1: Add the remaining 5 tool definitions to TOOLS array**

```typescript
// Append to TOOLS array in src/mcp-server.ts:
  {
    name: 'search_all',
    description: 'Unified search across all configured channels (memory + skill + observation + remote). Returns merged top-K.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        channels: { type: 'array', items: { type: 'string', enum: ['memory', 'skill', 'observation', 'remote'] } },
        top_k: { type: 'number', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_full',
    description: 'Retrieve full content of a hit by its doc_id (returned in search results).',
    inputSchema: {
      type: 'object',
      properties: { doc_id: { type: 'string' } },
      required: ['doc_id'],
    },
  },
  {
    name: 'reindex',
    description: 'Trigger a reindex (admin). Optionally restrict to a channel or force re-embedding.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['memory', 'skill', 'observation', 'all'], default: 'all' },
        force: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'stats',
    description: 'Return corpus stats: total chunks, by channel, last index time, embedder info.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Health check: are voyage and chroma reachable?',
    inputSchema: { type: 'object', properties: {} },
  },
```

- [ ] **Step 2: Add corresponding worker calls in CallToolRequestSchema handler**

Replace the existing tool dispatch with:

```typescript
  try {
    switch (name) {
      case 'search_memory':       result = await workerPost('/search/memory', args); break;
      case 'search_skill':        result = await workerPost('/search/skill', args); break;
      case 'search_observations': result = await workerPost('/search/observations', args); break;
      case 'search_all':          result = await workerPost('/search/all', args); break;
      case 'get_full':            result = await workerPost('/get_full', args); break;
      case 'reindex':             result = await workerPost('/reindex', args); break;
      case 'stats': {
        const res = await fetch(`${WORKER_BASE}/stats`);
        if (!res.ok) throw new Error(`worker /stats returned ${res.status}`);
        result = await res.json();
        break;
      }
      case 'status': {
        const res = await fetch(`${WORKER_BASE}/health`);
        result = res.ok ? await res.json() : { healthy: false };
        break;
      }
      default: throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    const e = err as Error;
    return {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    };
  }
```

- [ ] **Step 3: Smoke test all 8 tools**

```bash
# Worker still running from Task 23
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | bun run mcp:start | jq '.result.tools | length'
```

Expected: `8`

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat(mcp): complete 8-tool surface (search_all, get_full, reindex, stats, status)"
```

---

### Task 25: Worker — initial indexing + watcher wiring + reindex impl

**Files:**
- Modify: `src/worker/index.ts`
- Create: `tests/integration/worker-ingest.test.ts`

- [ ] **Step 1: Write the failing integration test**

```typescript
// tests/integration/worker-ingest.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let worker: WorkerHandle;
let workDir: string;
let memoryDir: string;
const PORT = 39892;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-worker-ingest-'));
  memoryDir = join(workDir, 'memory');
  require('fs').mkdirSync(memoryDir, { recursive: true });

  // Seed a memory file before starting the worker
  writeFileSync(join(memoryDir, 'feedback_seed.md'), `---
type: feedback
description: Seeded memory
---

Test seed memory.
`);

  worker = await startWorker({
    port: PORT,
    projectId: 'ingest-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    chromaDataDir: join(workDir, 'chroma'),
    skipChromaConnect: true,
    watchPaths: [join(memoryDir, '*.md')],
    watchChannel: 'memory',
  } as any);

  // Wait for initial indexing to complete
  await new Promise(r => setTimeout(r, 500));
});

afterAll(async () => {
  await worker.stop();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('worker — initial indexing picks up existing files', async () => {
  const res = await fetch(`http://localhost:${PORT}/stats`);
  const body = await res.json();
  expect(body.total_chunks).toBeGreaterThan(0);
});

test('worker — /reindex --force re-embeds all', async () => {
  const res = await fetch(`http://localhost:${PORT}/reindex`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel: 'memory', force: true }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.indexed).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `bun test tests/integration/worker-ingest.test.ts`
Expected: tests fail because watch paths aren't wired.

- [ ] **Step 3: Wire watcher and ingest into worker**

Add to `src/worker/index.ts` `WorkerOptions`:

```typescript
  watchPaths?: string[];
  watchChannel?: 'memory' | 'skill';
```

In `startWorker`, after creating the searcher:

```typescript
import { IngestPipeline } from './ingest.ts';
import { FileWatcher } from './watcher.ts';
import { glob } from 'glob';

const ingest = new IngestPipeline({
  meta,
  embedder: {
    embed: async (texts) => {
      try { return await embedder.embed(texts); }
      catch { return texts.map(() => []); } // empty embeddings on failure
    },
  },
  chroma,
  collectionName: `am_${opts.projectId}`,
  projectId: opts.projectId,
});

let watcher: FileWatcher | null = null;
if (opts.watchPaths && opts.watchPaths.length > 0 && opts.watchChannel) {
  // Initial indexing pass
  const channel = opts.watchChannel;
  for (const pattern of opts.watchPaths) {
    const files = await glob(pattern);
    for (const file of files) {
      try { await ingest.indexFile(file, channel); }
      catch (err) { console.error(`[ingest] ${file}:`, (err as Error).message); }
    }
  }

  // Live watcher
  watcher = new FileWatcher({
    paths: opts.watchPaths,
    debounceMs: 500,
    onEvent: async (type, path) => {
      try {
        if (type === 'unlink') await ingest.deleteFile(path);
        else await ingest.indexFile(path, channel);
      } catch (err) {
        console.error(`[watcher] ${type} ${path}:`, (err as Error).message);
      }
    },
  });
  await watcher.start();
}
```

Add `watcher.close()` to the `stop` function:

```typescript
async stop() {
  if (watcher) await watcher.close();
  server.stop();
  await chroma.close();
  meta.close();
},
```

Replace the `/reindex` stub with real implementation:

```typescript
if (url.pathname === '/reindex' && req.method === 'POST') {
  const parsed = ReindexSchema.safeParse(await req.json());
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  let indexed = 0, skipped = 0, errors = 0;

  if (opts.watchPaths && opts.watchChannel) {
    for (const pattern of opts.watchPaths) {
      if (parsed.data.channel !== 'all' && parsed.data.channel !== opts.watchChannel) continue;
      const files = await glob(pattern);
      for (const file of files) {
        try {
          if (parsed.data.force) {
            // Drop the document so sha-diff misses
            const existing = meta.getDocument(file);
            if (existing) meta.deleteDocument(file);
          }
          const before = meta.getDocument(file);
          await ingest.indexFile(file, opts.watchChannel);
          const after = meta.getDocument(file);
          if (after && (!before || before.sha !== after.sha)) indexed++;
          else skipped++;
        } catch { errors++; }
      }
    }
  }
  return Response.json({ indexed, skipped, errors });
}
```

Update `/stats` to return real data:

```typescript
if (url.pathname === '/stats') {
  const totalChunks = (meta as any).db.query('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
  const byChannel = (meta as any).db
    .query('SELECT documents.channel AS channel, COUNT(chunks.id) AS n FROM chunks JOIN documents ON documents.id = chunks.document_id GROUP BY documents.channel')
    .all() as Array<{ channel: string; n: number }>;
  const byChannelMap: Record<string, number> = {};
  for (const row of byChannel) byChannelMap[row.channel] = row.n;
  return Response.json({
    total_chunks: totalChunks.n,
    by_channel: byChannelMap,
    project_id: opts.projectId,
    embedder: { model: opts.embedderModel, endpoint: opts.embedderEndpoint },
  });
}
```

- [ ] **Step 4: Run — verify pass**

Run: `bun test tests/integration/worker-ingest.test.ts`
Expected: `2 pass, 0 fail`

- [ ] **Step 5: Commit**

```bash
git add src/worker/index.ts tests/integration/worker-ingest.test.ts
git commit -m "feat(worker): initial indexing + live watcher + real /reindex + /stats"
```

---

### Task 26: CLI — scaffold + status + stats

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/client.ts`
- Create: `src/cli/commands/status.ts`
- Create: `src/cli/commands/stats.ts`

- [ ] **Step 1: Implement HTTP client**

```typescript
// src/cli/client.ts
import { DEFAULT_WORKER_PORT } from '../shared/paths.ts';

const BASE = `http://localhost:${process.env.CAPTAIN_MEMO_WORKER_PORT ?? DEFAULT_WORKER_PORT}`;

export async function workerGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function workerPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function workerHealthy(): Promise<boolean> {
  try {
    const result = await workerGet('/health') as { healthy: boolean };
    return result.healthy === true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Implement status command**

```typescript
// src/cli/commands/status.ts
import { workerGet, workerHealthy } from '../client.ts';

export async function statusCommand(): Promise<number> {
  const healthy = await workerHealthy();
  if (!healthy) {
    console.error('captain-memo worker: NOT RUNNING');
    console.error('  Start with: captain-memo worker start');
    return 1;
  }
  const stats = await workerGet('/stats') as Record<string, unknown>;
  console.log('captain-memo worker: HEALTHY');
  console.log(`  total_chunks: ${stats.total_chunks}`);
  console.log(`  project_id:   ${stats.project_id}`);
  return 0;
}
```

- [ ] **Step 3: Implement stats command**

```typescript
// src/cli/commands/stats.ts
import { workerGet } from '../client.ts';

export async function statsCommand(): Promise<number> {
  const stats = await workerGet('/stats') as {
    total_chunks: number;
    by_channel: Record<string, number>;
    project_id: string;
    embedder: { model: string; endpoint: string };
  };
  console.log('captain-memo corpus statistics');
  console.log('---');
  console.log(`Project:     ${stats.project_id}`);
  console.log(`Total chunks: ${stats.total_chunks}`);
  console.log('By channel:');
  for (const [channel, count] of Object.entries(stats.by_channel)) {
    console.log(`  ${channel.padEnd(15)} ${count}`);
  }
  console.log(`Embedder:    ${stats.embedder.model} @ ${stats.embedder.endpoint}`);
  return 0;
}
```

- [ ] **Step 4: Implement CLI entry**

```typescript
// src/cli/index.ts
import { statusCommand } from './commands/status.ts';
import { statsCommand } from './commands/stats.ts';

const HELP = `captain-memo — local memory layer for Claude Code

Usage:
  captain-memo <command> [args]

Commands:
  status       Check whether the worker is running and reachable
  stats        Print corpus statistics (chunk counts by channel)
  reindex      Trigger a reindex (use --force to re-embed all)
  help         Show this message

Examples:
  captain-memo status
  captain-memo stats
  captain-memo reindex --channel memory
  captain-memo reindex --force
`;

export async function main(args: string[]): Promise<void> {
  const cmd = args[0] ?? 'help';
  let exit = 0;
  switch (cmd) {
    case 'status': exit = await statusCommand(); break;
    case 'stats':  exit = await statsCommand(); break;
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP); break;
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(HELP);
      exit = 2;
  }
  process.exit(exit);
}
```

- [ ] **Step 5: Smoke test**

```bash
# In one terminal: start worker (requires Voyage running for full functionality, but stats works without)
bun run worker:start

# In another terminal:
./bin/captain-memo status
./bin/captain-memo stats
```

Expected: status shows HEALTHY, stats prints corpus info.

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts src/cli/client.ts src/cli/commands/status.ts src/cli/commands/stats.ts
git commit -m "feat(cli): captain-memo status + stats commands"
```

---

### Task 27: CLI — reindex command

**Files:**
- Create: `src/cli/commands/reindex.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1: Implement reindex command**

```typescript
// src/cli/commands/reindex.ts
import { workerPost } from '../client.ts';

export async function reindexCommand(args: string[]): Promise<number> {
  let channel: 'memory' | 'skill' | 'observation' | 'all' = 'all';
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--channel') {
      const next = args[++i];
      if (!next || !['memory', 'skill', 'observation', 'all'].includes(next)) {
        console.error(`Invalid --channel value: ${next}`);
        return 2;
      }
      channel = next as typeof channel;
    } else if (arg === '--force') {
      force = true;
    }
  }

  const result = await workerPost('/reindex', { channel, force }) as {
    indexed: number;
    skipped: number;
    errors: number;
  };
  console.log(`Reindex complete:`);
  console.log(`  indexed: ${result.indexed}`);
  console.log(`  skipped: ${result.skipped}`);
  console.log(`  errors:  ${result.errors}`);
  return result.errors > 0 ? 1 : 0;
}
```

- [ ] **Step 2: Wire into CLI**

Modify `src/cli/index.ts`:

```typescript
import { reindexCommand } from './commands/reindex.ts';

// In the switch:
    case 'reindex': exit = await reindexCommand(args.slice(1)); break;
```

- [ ] **Step 3: Smoke test**

```bash
./bin/captain-memo reindex --channel memory
./bin/captain-memo reindex --force
```

Expected: prints "Reindex complete" with counts.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/reindex.ts src/cli/index.ts
git commit -m "feat(cli): reindex command with --channel and --force flags"
```

---

### Task 28: End-to-end smoke test (full stack)

**Files:**
- Create: `tests/integration/e2e.test.ts`

- [ ] **Step 1: Write the end-to-end test**

```typescript
// tests/integration/e2e.test.ts
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let worker: WorkerHandle;
let workDir: string;
let memoryDir: string;
const PORT = 39893;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-e2e-'));
  memoryDir = join(workDir, 'memory');
  mkdirSync(memoryDir, { recursive: true });

  // Mock Voyage server returns deterministic embeddings
  const voyageServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { input: string[] };
      // Embedding = [hashOfText, 0, 0, ...]
      const data = body.input.map((text, idx) => ({
        embedding: Array.from({ length: 8 }, (_, i) => i === 0 ? text.length / 100 : Math.random() * 0.01),
        index: idx,
      }));
      return Response.json({ data, model: 'voyage-4-nano' });
    },
  });

  worker = await startWorker({
    port: PORT,
    projectId: 'e2e-test',
    metaDbPath: ':memory:',
    embedderEndpoint: `http://localhost:${voyageServer.port}/v1/embeddings`,
    embedderModel: 'voyage-4-nano',
    chromaDataDir: join(workDir, 'chroma'),
    skipChromaConnect: true,
    watchPaths: [join(memoryDir, '*.md')],
    watchChannel: 'memory',
  } as any);
  (globalThis as any).__voyageServer = voyageServer;
});

afterAll(async () => {
  await worker.stop();
  ((globalThis as any).__voyageServer)?.stop();
  if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test('e2e — write file → indexed → searchable via /search/all', async () => {
  const filePath = join(memoryDir, 'feedback_test.md');
  writeFileSync(filePath, `---
type: feedback
description: Test feedback rule
---

Always use erp-components, no custom page styles.
`);

  // Wait for watcher to pick up + index
  await new Promise(r => setTimeout(r, 1500));

  const stats = await fetch(`http://localhost:${PORT}/stats`).then(r => r.json());
  expect(stats.total_chunks).toBeGreaterThan(0);

  const search = await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'erp-components', top_k: 5 }),
  }).then(r => r.json());

  expect(search.results.length).toBeGreaterThan(0);
  expect(search.results.find((r: any) => r.title === 'feedback_test')).toBeDefined();
});

test('e2e — edit file → only changed chunks re-embedded', async () => {
  const filePath = join(memoryDir, 'feedback_edit.md');
  writeFileSync(filePath, '---\ntype: feedback\n---\nFirst version.');
  await new Promise(r => setTimeout(r, 1500));

  const beforeStats = await fetch(`http://localhost:${PORT}/stats`).then(r => r.json());

  writeFileSync(filePath, '---\ntype: feedback\n---\nUpdated version.');
  await new Promise(r => setTimeout(r, 1500));

  const afterSearch = await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'Updated version', top_k: 5 }),
  }).then(r => r.json());

  expect(afterSearch.results.find((r: any) => r.title === 'feedback_edit')).toBeDefined();
});

test('e2e — delete file → chunks removed', async () => {
  const filePath = join(memoryDir, 'feedback_delete.md');
  writeFileSync(filePath, 'will be deleted');
  await new Promise(r => setTimeout(r, 1500));

  unlinkSync(filePath);
  await new Promise(r => setTimeout(r, 1500));

  const search = await fetch(`http://localhost:${PORT}/search/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'will be deleted', top_k: 5 }),
  }).then(r => r.json());

  // Should not find the deleted file
  expect(search.results.find((r: any) => r.title === 'feedback_delete')).toBeUndefined();
});
```

- [ ] **Step 2: Run end-to-end test**

Run: `bun test tests/integration/e2e.test.ts`
Expected: `3 pass, 0 fail` (allow ~10s for filesystem watching)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/e2e.test.ts
git commit -m "test: end-to-end — write/edit/delete file → indexed/updated/dropped via worker stack"
```

---

### Task 29: Final wiring — `worker:start` script + manual usage doc

**Files:**
- Modify: `package.json` (worker:start uses real-config defaults, add `worker:dev`)
- Create: `docs/USAGE.md` (brief)

- [ ] **Step 1: Update package.json scripts**

In `package.json`, replace the `scripts` section:

```json
"scripts": {
  "test": "bun test",
  "test:unit": "bun test tests/unit/",
  "test:integration": "bun test tests/integration/",
  "typecheck": "tsc --noEmit",
  "worker:start": "bun src/worker/index.ts",
  "worker:dev": "CAPTAIN_MEMO_DATA_DIR=./.captain-memo.dev bun --watch src/worker/index.ts",
  "mcp:start": "bun src/mcp-server.ts",
  "cli": "bun bin/captain-memo"
}
```

- [ ] **Step 2: Write USAGE.md**

```markdown
# captain-memo Plan-1 — Manual Usage (Foundation)

This is what's available after Plan 1 ships. Hooks (auto-injection) come in Plan 2; migration and federation in Plan 3.

## Prerequisites
- bun ≥1.1.14 installed
- `uvx chroma-mcp` available (Chroma's MCP subprocess)
- A local Voyage instance running (see project-level installation docs — out of scope for this plan)

## Start the worker
```bash
bun run worker:start
```
Default port: 39888. Configure via `CAPTAIN_MEMO_WORKER_PORT`, `CAPTAIN_MEMO_VOYAGE_ENDPOINT`, `CAPTAIN_MEMO_PROJECT_ID`.

## Use the CLI
```bash
captain-memo status                     # health check
captain-memo stats                      # corpus stats
captain-memo reindex                    # cheap sha-diff reindex
captain-memo reindex --channel memory   # specific channel
captain-memo reindex --force            # ignore sha cache
```

## Use the MCP server (manual)
The stdio MCP server connects to the worker over HTTP:
```bash
bun src/mcp-server.ts
```
Expose to Claude Code via `.mcp.json`:
```json
{
  "mcpServers": {
    "captain-memo": {
      "type": "stdio",
      "command": "bun",
      "args": ["/path/to/captain-memo/src/mcp-server.ts"]
    }
  }
}
```

## Watch paths
Set via env or pass to `startWorker`:
- `CAPTAIN_MEMO_WATCH_MEMORY` — glob for memory files
- `CAPTAIN_MEMO_WATCH_SKILLS` — glob for skill files

## What's NOT in Plan 1
- Auto-injection on user prompts (Plan 2)
- Session observation pipeline (Plan 2)
- Migration from claude-mem (Plan 3)
- Federation with remote MCPs (Plan 3)
- Optimization / duplicate detection (Plan 3)
```

- [ ] **Step 3: Commit**

```bash
git add package.json docs/USAGE.md
git commit -m "docs: USAGE.md for Plan-1 manual usage; add worker:dev script"
```

---

## Self-Review Checklist

Run through these manually before declaring Plan 1 complete:

- [ ] Every spec section in scope for Plan 1 has at least one task implementing it
- [ ] All tasks have working code in steps (no TBD/TODO/placeholder text)
- [ ] Type names + method signatures consistent across tasks
- [ ] All test commands include expected output (PASS/FAIL counts)
- [ ] All commit messages follow conventional prefix (feat/test/docs/chore)
- [ ] File paths are absolute or clearly project-relative
- [ ] Each task ends with a commit step
- [ ] Plan 1 produces working software (manually-usable MCP) at the end of Task 29

---

## Out of Scope (Plans 2 & 3)

The following are deliberately deferred:

| Feature | Plan |
|---|---|
| `UserPromptSubmit` hook (auto-injection) | Plan 2 |
| `SessionStart`/`PostToolUse`/`Stop` hooks | Plan 2 |
| Observation queue (SQLite WAL) | Plan 2 |
| Haiku summarizer client | Plan 2 |
| `<memory-context>` envelope formatting | Plan 2 |
| Hook contract tests | Plan 2 |
| `migrate-from-claude-mem` command | Plan 3 |
| Federation client + circuit breaker | Plan 3 |
| Duplicate cluster detection | Plan 3 |
| `optimize`/`purge`/`forget` commands | Plan 3 |
| Retrieval-quality eval runner | Plan 3 |
| Voyage install script | Plan 3 |
| MEMORY.md transformation script | Plan 3 |

---

## Execution Handoff

Plan 1 is complete and saved to `~/projects/captain-memo/docs/plans/2026-05-06-captain-memo-v1-plan-1-foundation.md`.

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review output between tasks, fast iteration. Best for plans of this size (29 tasks). Each task is self-contained enough that a subagent with no prior context can implement it from the plan alone.

**2. Inline Execution** — Execute tasks in this same Claude Code session. Heavier on context but lets you steer mid-task. Better for plans with high inter-task ambiguity.

**Which approach?**
