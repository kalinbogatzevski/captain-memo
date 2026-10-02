import { ObservationsStore } from '../../src/worker/observations-store.ts';
import { join } from 'path';
const dir = process.env.CAPTAIN_MEMO_DATA_DIR!;
const store = new ObservationsStore(join(dir, 'observations.db'));
// a small seeded generator so the corpus is the same on every run
let seed = 20261002; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
const areas = ['retry helper', 'session cache', 'login redirect', 'CSV export', 'rate limiter', 'migration runner', 'feature flags', 'webhook signer', 'search index', 'date parsing', 'config loader', 'job queue', 'pagination', 'audit log', 'file uploads', 'email templates', 'health endpoint', 'token refresh'];
const kinds: Array<{ type: 'discovery' | 'bugfix' | 'feature' | 'decision' | 'refactor' | 'change'; t: (a: string) => string; n: (a: string) => string }> = [
  { type: 'discovery', t: (a) => `The ${a} reads its settings once at startup`, n: (a) => `Traced how the ${a} gets its configuration and found it is read once, when the service starts.` },
  { type: 'bugfix', t: (a) => `Fixed the ${a} dropping the last item`, n: (a) => `The ${a} skipped the final entry on an exact multiple of the page size; the loop bound was off by one.` },
  { type: 'decision', t: (a) => `Keep the ${a} behind a flag until rollout`, n: (a) => `Agreed to ship the ${a} dark first and turn it on per team once the dashboards look right.` },
  { type: 'feature', t: (a) => `Added the ${a} to the admin panel`, n: (a) => `The admin panel now shows the ${a} with its current state and the last change.` },
  { type: 'refactor', t: (a) => `Split the ${a} into smaller modules`, n: (a) => `Moved the ${a} into three modules with one job each; behaviour is unchanged.` },
  { type: 'change', t: (a) => `Raised the ${a} timeout from 5 s to 10 s`, n: (a) => `Slow upstream calls were timing out under load, so the ${a} now waits twice as long.` },
];
const counts: Record<string, number> = { 'claude-code': 1486, codex: 318, gemini: 207, agy: 94 };
const now = Math.floor(Date.now() / 1000), span = 21 * 86400;
let n = 0;
for (const [agent, total] of Object.entries(counts)) {
  for (let i = 0; i < total; i++) {
    const a = pick(areas), k = pick(kinds);
    store.insert({
      session_id: `${agent}-s${Math.floor(i / 9)}`, project_id: 'default', prompt_number: (i % 9) + 1, type: k.type,
      title: k.t(a), narrative: k.n(a), facts: [], concepts: [a], files_read: [], files_modified: [],
      created_at_epoch: now - Math.floor(rnd() * span), branch: 'main', origin_agent: agent as never, work_tokens: 200 + Math.floor(rnd() * 900),
    });
    n++;
  }
}
console.log('seeded', n, JSON.stringify(store.countByOrigin()));
store.close();
