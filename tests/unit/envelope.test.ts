import { test, expect, spyOn } from 'bun:test';
import { formatEnvelope } from '../../src/worker/envelope.ts';
import * as redact from '../../src/shared/redact-secrets.ts';
import { countTokens } from '../../src/shared/tokens.ts';
import type { EnvelopeHit } from '../../src/shared/types.ts';

const memoryHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'memory:feedback_no_null:abc123',
  channel: 'memory',
  source_path: '/home/k/.claude/memory/feedback_no_null.md',
  title: 'feedback_no_null',
  snippet: 'No NULL — use 0 / "" sentinels.',
  score: 0.87,
  metadata: { memory_type: 'feedback' },
  ...over,
});

const skillHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'skill:erp-coding-standards#sql:def456',
  channel: 'skill',
  source_path: '/home/k/.claude/skills/erp-coding-standards/SKILL.md',
  title: 'erp-coding-standards / sql',
  snippet: 'Always use db_get_row() for single-row reads.',
  score: 0.81,
  metadata: { skill_id: 'erp-coding-standards', section_title: 'sql' },
  ...over,
});

const obsHit = (over: Partial<EnvelopeHit> = {}): EnvelopeHit => ({
  doc_id: 'observation:1700000000:ghi789',
  channel: 'observation',
  source_path: 'observation:1',
  title: 'fixed billing rounding',
  snippet: 'replaced round() with full-precision intermediate.',
  score: 0.74,
  metadata: { type: 'bugfix', created_at_epoch: 1_700_000_000 },
  ...over,
});

test('formatEnvelope — empty hits emits empty-state envelope with hit_count=0', () => {
  const out = formatEnvelope({
    project_id: 'erp-platform',
    budget_tokens: 4000,
    hits: [],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('<memory-context');
  expect(out.envelope).toContain('project="erp-platform"');
  expect(out.envelope).toContain('k="0"');
  expect(out.envelope).toContain('</memory-context>');
  expect(out.hit_count).toBe(0);
});

test('formatEnvelope — groups hits by channel in fixed order memory, skill, observation', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit(), memoryHit(), skillHit()],
    degradation_flags: [],
  });
  const idxMem = out.envelope.indexOf('Local memory');
  const idxSkill = out.envelope.indexOf('Skill: ');
  const idxObs = out.envelope.indexOf('Session memory');
  expect(idxMem).toBeGreaterThan(0);
  expect(idxSkill).toBeGreaterThan(idxMem);
  expect(idxObs).toBeGreaterThan(idxSkill);
});

test('formatEnvelope — emits get_full hint with the doc_id verbatim', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit()],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('[full: get_full("memory:feedback_no_null:abc123")]');
});

test('formatEnvelope — score is rendered to two decimals', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit({ score: 0.87543 })],
    degradation_flags: [],
  });
  expect(out.envelope).toContain('score 0.88');
});

test('formatEnvelope — degradation flags render in the opening tag', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [memoryHit()],
    degradation_flags: ['embedder=voyage-4-nano:keyword-fallback=true'],
  });
  expect(out.envelope).toContain('embedder=voyage-4-nano:keyword-fallback=true');
});

test('formatEnvelope — used_tokens never exceeds budget_tokens', () => {
  const bigSnippet = 'x'.repeat(20_000);
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 200,
    hits: [memoryHit({ snippet: bigSnippet })],
    degradation_flags: [],
  });
  expect(out.used_tokens).toBeLessThanOrEqual(200);
});

test('formatEnvelope — observation hit shows type and date prefix', () => {
  const out = formatEnvelope({
    project_id: 'p',
    budget_tokens: 4000,
    hits: [obsHit()],
    degradation_flags: [],
  });
  // "bugfix · 2023-11-14" (epoch 1_700_000_000 = 2023-11-14 UTC)
  expect(out.envelope).toMatch(/bugfix · 2023-11-14/);
});

// ---- 2026-09-17: auto-recall injected a full GitLab API token into an unrelated session by fuzzy match. The
// envelope redacts credential-shaped values in EVERY channel and points at get_full for the real document.
test('formatEnvelope — credential-shaped values are redacted in memory, skill, observation and remote snippets', () => {
  const out = formatEnvelope({
    project_id: 'p', budget_tokens: 4000, degradation_flags: [],
    hits: [
      memoryHit({ snippet: 'the runner token is glpat-AbCdEfGhIjKlMnOpQrSt12, stored in worker.env' }),
      skillHit({ snippet: 'export PASSWORD=hunter22 before running' }),
      obsHit({ snippet: 'cloned https://svc:s3cr3t@gitlab.example/x.git' }),
      { doc_id: 'remote:1', channel: 'remote', source_path: 'r', title: 'r', snippet: 'Authorization: Bearer eyJGQUtFZmFrZUZBS0Ui.eyJGQUtFZmFrZUZBS0Ui.FAKEfakeFAKEfake0000', score: 0.5, metadata: { origin_label: 'peer' } },
    ],
  });
  expect(out.envelope).not.toContain('glpat-AbCd');
  expect(out.envelope).not.toContain('hunter22');
  expect(out.envelope).not.toContain('s3cr3t');
  expect(out.envelope).not.toContain('eyJGQUtFZmFrZUZBS0Ui');
  expect(out.envelope).toContain('the runner token is [REDACTED:gitlab-token], stored in worker.env');
  expect(out.envelope).toContain('(1 credential-shaped value redacted — get_full("memory:feedback_no_null:abc123") for the document)');
  expect(out.hit_count).toBe(4);
});

// Redaction runs BEFORE the budget cut: cut first, a URL credential split by the cut has no '@', no longer matches,
// and the half of the password that fits is injected.
test('formatEnvelope — a secret the budget cut would split is redacted whole', () => {
  const pw = 'FAKEpw0'.repeat(600);   // ~1 800 tokens: the 700-token cut lands inside it
  const out = formatEnvelope({
    project_id: 'p', budget_tokens: 700, degradation_flags: [],
    hits: [memoryHit({ snippet: `deploy remote for the runner: https://svc:${pw}@git.example/x.git\n${'then restart the runner service. '.repeat(200)}` })],
  });
  expect(countTokens(out.envelope)).toBeLessThanOrEqual(700);
  expect(out.envelope).toContain('… [truncated]');
  expect(out.envelope).toContain('deploy remote for the runner: https://svc:[REDACTED]@git.example/x.git');
  expect(out.envelope).not.toContain('FAKEpw0');
  expect(out.envelope).toContain('(1 credential-shaped value redacted — get_full("memory:feedback_no_null:abc123") for the document)');
});

// A heading or an observation title can carry a token as well as a snippet.
test('formatEnvelope — titles, skill section titles and peer labels are redacted too', () => {
  const out = formatEnvelope({
    project_id: 'p', budget_tokens: 4000, degradation_flags: [],
    hits: [
      memoryHit({ title: 'runner token glpat-AbCdEfGhIjKlMnOpQrSt12' }),
      skillHit({ metadata: { skill_id: 's', section_title: 'password=FAKEfake0000' } }),
      obsHit({ title: 'cloned with https://svc:FAKEpw0000@git.example' }),
      { doc_id: 'remote:1', channel: 'remote', source_path: 'r', title: 'r', snippet: 'x', score: 0.5, metadata: { origin_label: 'peer token: Qz7FAKEfake9Lm2x' } },
    ],
  });
  for (const leak of ['glpat-AbCd', 'FAKEfake0000', 'FAKEpw0000', 'Qz7FAKEfake9Lm2x']) expect(out.envelope).not.toContain(leak);
  expect(out.envelope).toContain('### runner token [REDACTED:gitlab-token]');
  expect(out.envelope).toContain('section "password=[REDACTED]"');
  expect(out.envelope).toContain('"cloned with https://svc:[REDACTED]@git.example"');
  expect(out.envelope).toContain('### ⚓ peer token: [REDACTED] ·');
  expect(out.hit_count).toBe(4);
});

// ---- 2026-09-28: the budget cut was a cut from the END of the body, and Session memory renders last — so a rank-1
// observation next to four dense (Bulgarian, ~2 chars/token) memory hits vanished while k= and hit_count still
// counted it, and the worker audited and from_auto-bumped it. Now each hit that won a slot keeps a fair share.
const bg = 'Клиентът съобщава, че връзката прекъсва всяка вечер след осем часа; проверихме оптичния конвертор и сменихме пач корда. ';
// What /inject/context passes at top_k 5 and budget 4000: snippets cut to 2 880 chars.
const dense = (n: number) => memoryHit({ doc_id: `memory:bg${n}:x`, title: `bg-note-${n}`, snippet: bg.repeat(30).slice(0, 2880) });
test('formatEnvelope — over budget every hit that won a slot renders; a rank-1 observation is not cut off by four dense memory hits', () => {
  const obs = obsHit({ title: 'rank one observation' });
  const out = formatEnvelope({ project_id: 'p', budget_tokens: 4000, degradation_flags: [], hits: [obs, dense(1), dense(2), dense(3), dense(4)] });
  expect(countTokens(out.envelope)).toBeLessThanOrEqual(4000);
  expect(out.envelope).toContain('"rank one observation"');
  expect(out.envelope).toContain(`[full: get_full("${obs.doc_id}")]`);
  for (const n of [1, 2, 3, 4]) expect(out.envelope).toContain(`### bg-note-${n}`);
  expect(out.rendered_ids).toEqual([obs.doc_id, 'memory:bg1:x', 'memory:bg2:x', 'memory:bg3:x', 'memory:bg4:x']);
  expect(out.hit_count).toBe(5);
  expect(out.envelope).toContain('k="5"');
});

test('formatEnvelope — a hit whose header does not fit is dropped whole, lowest-ranked first; k=, hit_count and "(N results)" count what rendered', () => {
  const obs = obsHit({ title: 'rank one observation' });
  const hits = [obs, dense(1), dense(2), dense(3), dense(4)];
  const out = formatEnvelope({ project_id: 'p', budget_tokens: 320, degradation_flags: [], hits });
  const n = out.rendered_ids.length;
  expect(countTokens(out.envelope)).toBeLessThanOrEqual(320);
  expect(n).toBeGreaterThan(1); expect(n).toBeLessThan(5);
  expect(out.rendered_ids).toEqual(hits.slice(0, n).map((h) => h.doc_id));
  expect(out.envelope).toContain('"rank one observation"');
  for (const h of hits.slice(1, n)) expect(out.envelope).toContain(`### ${h.title}`);
  for (const h of hits.slice(n)) expect(out.envelope).not.toContain(h.title);
  expect(out.envelope).toContain(`## Local memory (${n - 1} results)`);
  expect(out.hit_count).toBe(n);
  expect(out.envelope).toContain(`k="${n}"`);
});

test('formatEnvelope — over budget, a snippet is redacted once per cap, not on every re-render of the fit', () => {
  // The bisect and the slack loop re-render every kept snippet; a credential-shaped one comes in as its whole chunk,
  // so each re-render re-ran the redaction and the tokenizer over all of it (213 redactions for these 50 hits).
  const hits = Array.from({ length: 50 }, (_, i) => memoryHit({
    doc_id: `memory:m${i}`, title: `runner ${i}`,
    snippet: `${'The runner deploy procedure: pull, build, restart the service. '.repeat(48)}\nDB_PASSWORD=fake${i}fake0000`,
  }));
  const spy = spyOn(redact, 'redactSecrets');
  try {
    const out = formatEnvelope({ project_id: 'p', budget_tokens: 400, hits, degradation_flags: [] });
    expect(out.hit_count).toBeGreaterThan(0);
    expect(out.envelope).not.toContain('fake0fake0000');
    // One per distinct cap a hit is rendered at (its size, its header-only fit, its final share), plus its title.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(hits.length * 4);
  } finally {
    spy.mockRestore();
  }
});

// 2026-09-29: a credential-shaped chunk comes in WHOLE (index.ts: cut before redaction, a secret split by the cap leaks
// its first half), and the tokenizer is superlinear on a long run of one letter — 40 000 'x' took 31 s, blocking the
// worker. So the snippet is cut to snippet_chars after redaction, before anything tokenizes it.
test('formatEnvelope — a whole credential-shaped snippet is cut to snippet_chars after redaction', () => {
  const prose = 'then restart the runner service. ';
  const snippet = `runner token glpat-AbCdEfGhIjKlMnOpQrSt12\n${prose.repeat(105)}SENTINELWORD ${prose.repeat(80)}`;
  expect(snippet.indexOf('SENTINELWORD')).toBeGreaterThan(3400);
  const out = formatEnvelope({ project_id: 'p', budget_tokens: 4000, degradation_flags: [], snippet_chars: 2880, hits: [memoryHit({ snippet })] });
  expect(out.envelope).toContain('runner token [REDACTED:gitlab-token]');
  expect(out.envelope).not.toContain('SENTINELWORD');   // under budget: without the cut the whole chunk renders
  expect(out.envelope).toContain('(1 credential-shaped value redacted — get_full("memory:feedback_no_null:abc123") for the document)');
});
