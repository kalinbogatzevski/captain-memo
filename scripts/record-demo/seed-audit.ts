// A made-up recall history for the sample corpus, written with the product's own audit writer: a few weeks of sessions that
// recalled related observations (same area), the last one a few minutes ago.
import { Database } from 'bun:sqlite';
import { join } from 'path';
import { writeRecallAuditLine } from '../../src/worker/recall-audit.ts';
import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { loadTideConfig } from '../../src/worker/tide.ts';
const dir = process.env.CAPTAIN_MEMO_DATA_DIR!;
const db = new Database(join(dir, 'observations.db'), { readonly: true });
const store = new ObservationsStore(join(dir, 'observations.db'), { tideConfig: loadTideConfig(process.env) });   // the worker's own Tide config, so a replayed recall strengthens like a real one
const rows = db.query('SELECT id, title, concepts FROM observations').all() as Array<{ id: number; title: string; concepts: string }>;
const byArea = new Map<string, Array<{ id: number; title: string }>>();
for (const r of rows) { const a = (JSON.parse(r.concepts) as string[])[0] ?? 'misc'; (byArea.get(a) ?? byArea.set(a, []).get(a)!).push(r); }
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const hashes = new Map<number, string>();   // a chunk id is stable per observation
const hashOf = (id: number) => hashes.get(id) ?? (hashes.set(id, Array.from({ length: 8 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rnd() * 62)]).join('')), hashes.get(id)!);
// recall concentrates on what people keep coming back to: a third of each area's observations
for (const [a, pool] of byArea) byArea.set(a, pool.filter((_, i) => i % 3 === 0));
const areas = [...byArea.keys()], words = ['timeout', 'error', 'config', 'test', 'rollout', 'fix', 'retry', 'cache'];
const N = 940, now = Date.now(), span = 21 * 86400_000, last = now - 3 * 60_000;
const profile = 'v2';
for (let i = 0; i < N; i++) {
  const area = pick(areas), pool = byArea.get(area)!, k = 3 + Math.floor(rnd() * 4), seen = new Set<number>(), hits = [];
  while (hits.length < k && seen.size < pool.length) {
    const o = pick(pool); if (seen.has(o.id)) continue; seen.add(o.id);
    hits.push({ doc_id: `observation:${o.id}:${hashOf(o.id)}`, channel: 'observation', score: Math.round((0.8 - hits.length * 0.05 - rnd() * 0.03) * 1000) / 1000, snippet: o.title.slice(0, 200) });
  }
  const ts = Math.round(i === N - 1 ? last : now - span + (span - 3 * 60_000) * (i / (N - 1)));
  const injected = rnd() < 0.6;
  await writeRecallAuditLine({ ts, session_id: `session-${Math.floor(i / 6)}`, project_id: 'default', query: `${area} ${pick(words)}`, rank_profile: profile, hits, ...(injected ? { injected_tokens: 400 + Math.floor(rnd() * 1000) } : {}) });
  store.bumpRetrieval([...seen], injected ? 'auto' : 'search', Math.floor(ts / 1000));
}
store.close();
console.log('audit entries', N);
