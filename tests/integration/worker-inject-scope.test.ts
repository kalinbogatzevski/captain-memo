import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWorker, type WorkerHandle } from '../../src/worker/index.ts';
import { projectSlugFromCwd } from '../../src/shared/paths.ts';
import { rmWorkDir } from '../support/worker-temp.ts';

// Two projects' Claude memory, both matching the prompt by keyword. With CAPTAIN_MEMO_RECALL_SCOPE=project a session in
// one of them must only be handed its own; without a cwd, or with the setting unset, recall is unchanged.
let worker: WorkerHandle;
let workDir: string;
let shopCwd: string;
const saved = { scope: process.env.CAPTAIN_MEMO_RECALL_SCOPE, dir: process.env.CAPTAIN_MEMO_CLAUDE_PROJECTS_DIR };

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'captain-memo-scope-'));
  const projectsDir = join(workDir, 'projects');
  shopCwd = join(workDir, 'code', 'shop');
  const billingCwd = join(workDir, 'code', 'billing');
  for (const [cwd, body] of [[shopCwd, 'Shop rounding rule: prices round to whole cents.'],
                             [billingCwd, 'Billing rounding rule: never round mid-calculation.']] as const) {
    const dir = join(projectsDir, projectSlugFromCwd(cwd), 'memory');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'feedback_rounding.md'), `---\ntype: feedback\ndescription: rounding\n---\n${body}\n`);
  }
  process.env.CAPTAIN_MEMO_CLAUDE_PROJECTS_DIR = projectsDir;

  worker = await startWorker({
    port: 0,
    projectId: 'scope-test',
    metaDbPath: ':memory:',
    embedderEndpoint: 'http://localhost:0/unused',
    embedderModel: 'voyage-4-nano',
    vectorDbPath: join(workDir, 'vec.db'),
    embeddingDimension: 8,
    skipEmbed: true,
    watchPaths: [join(projectsDir, '*', 'memory', '*.md')],
    watchChannel: 'memory',
    hookBudgetTokens: 2000,
  });
  await new Promise(r => setTimeout(r, 500));
});

afterAll(async () => {
  await worker.stop();
  rmWorkDir(workDir);
  for (const [k, v] of [['CAPTAIN_MEMO_RECALL_SCOPE', saved.scope], ['CAPTAIN_MEMO_CLAUDE_PROJECTS_DIR', saved.dir]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function inject(body: Record<string, unknown>) {
  const res = await fetch(`http://localhost:${worker.port}/inject/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'what is the rounding rule', top_k: 5, ...body }),
  });
  expect(res.status).toBe(200);
  return await res.json() as { envelope: string; degradation_flags: string[] };
}

test('scope unset: both projects are recalled, as before', async () => {
  delete process.env.CAPTAIN_MEMO_RECALL_SCOPE;
  const body = await inject({ cwd: shopCwd });
  expect(body.envelope).toContain('Shop rounding rule');
  expect(body.envelope).toContain('Billing rounding rule');
});

test('scope=project: only the session\'s own project memory is recalled', async () => {
  process.env.CAPTAIN_MEMO_RECALL_SCOPE = 'project';
  const body = await inject({ cwd: shopCwd, project_id: 'shop' });
  expect(body.envelope).toContain('Shop rounding rule');
  expect(body.envelope).not.toContain('Billing rounding rule');
  expect(body.degradation_flags).toContain('scope=project:dropped=1');
});

test('scope=project without a cwd filters nothing', async () => {
  process.env.CAPTAIN_MEMO_RECALL_SCOPE = 'project';
  const body = await inject({});
  expect(body.envelope).toContain('Billing rounding rule');
});
