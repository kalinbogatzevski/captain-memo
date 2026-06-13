import { test, expect } from 'bun:test';
import {
  TOOLS, buildRememberRequest, formatRememberResult, dispatchRemember,
} from '../../src/mcp-server.ts';

test('remember tool is registered beside search_memory', () => {
  const names = TOOLS.map((t) => t.name);
  expect(names).toContain('remember');
  expect(names).toContain('search_memory');
});

test('remember inputSchema requires body + type, allows name/description/slug, no cwd field', () => {
  const remember = TOOLS.find((t) => t.name === 'remember')!;
  expect(remember.inputSchema.type).toBe('object');
  expect((remember.inputSchema as { required: string[] }).required).toEqual(['body', 'type']);
  const props = remember.inputSchema.properties as Record<string, unknown>;
  expect(Object.keys(props).sort()).toEqual(
    ['body', 'description', 'name', 'slug', 'type'].sort(),
  );
  expect(props).not.toHaveProperty('cwd');
  expect(props).not.toHaveProperty('projectContext');
});

test('remember description steers toward durable curated memory (not scratch)', () => {
  const remember = TOOLS.find((t) => t.name === 'remember')!;
  const d = remember.description.toLowerCase();
  expect(d).toContain('durable');
  expect(d).toContain('memory');
});

test('buildRememberRequest injects flat cwd from the given cwd', () => {
  const body = buildRememberRequest(
    { body: 'Use Bun, not Node, for this repo.', type: 'decision' },
    '/home/kalin/projects/captain-memo',
  );
  expect(body).toEqual({
    body: 'Use Bun, not Node, for this repo.',
    type: 'decision',
    cwd: '/home/kalin/projects/captain-memo',
  });
});

test('buildRememberRequest forwards optional overrides verbatim and does not invent keys', () => {
  const body = buildRememberRequest(
    { body: 'b', type: 'preference', name: 'N', description: 'D', slug: 'my-slug' },
    '/tmp/proj',
  );
  expect(body).toEqual({
    body: 'b',
    type: 'preference',
    name: 'N',
    description: 'D',
    slug: 'my-slug',
    cwd: '/tmp/proj',
  });
});

test('buildRememberRequest omits absent optionals (no undefined keys leak to the worker)', () => {
  const body = buildRememberRequest({ body: 'b', type: 'reference' }, '/tmp/proj') as Record<string, unknown>;
  expect('name' in body).toBe(false);
  expect('description' in body).toBe(false);
  expect('slug' in body).toBe(false);
});

test('formatRememberResult on created returns action + path text', () => {
  const out = formatRememberResult({ ok: true, path: '/p/feedback_x.md', action: 'created', doc_id: 'd1' });
  expect(out.isError).toBeUndefined();
  const text = out.content[0]!.text;
  expect(text).toContain('created');
  expect(text).toContain('/p/feedback_x.md');
});

test('formatRememberResult on updated returns action + path text', () => {
  const out = formatRememberResult({ ok: true, path: '/p/decision_y.md', action: 'updated', doc_id: 'd2' });
  expect(out.content[0]!.text).toContain('updated');
  expect(out.content[0]!.text).toContain('/p/decision_y.md');
});

test('formatRememberResult on ok:false surfaces the reason as an MCP error', () => {
  const out = formatRememberResult({ ok: false, reason: 'EACCES: permission denied' });
  expect(out.isError).toBe(true);
  expect(out.content[0]!.text).toContain('EACCES: permission denied');
});

test('dispatchRemember injects cwd, posts /remember, returns formatted created result', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const post = async (path: string, body: unknown) => {
    calls.push({ path, body });
    return { ok: true, path: '/proj/.../memory/decision_use-bun.md', action: 'created', doc_id: 'd9' };
  };
  const out = await dispatchRemember(
    { body: 'Use Bun.', type: 'decision' },
    { post, cwd: () => '/home/kalin/projects/captain-memo' },
  );
  expect(calls).toEqual([
    {
      path: '/remember',
      body: {
        body: 'Use Bun.',
        type: 'decision',
        cwd: '/home/kalin/projects/captain-memo',
      },
    },
  ]);
  expect(out.isError).toBeUndefined();
  expect(out.content[0]!.text).toContain('created');
  expect(out.content[0]!.text).toContain('decision_use-bun.md');
});

test('dispatchRemember surfaces worker ok:false as an MCP error', async () => {
  const post = async () => ({ ok: false, reason: 'ENOSPC: no space left on device' });
  const out = await dispatchRemember(
    { body: 'b', type: 'reference' },
    { post, cwd: () => '/tmp/p' },
  );
  expect(out.isError).toBe(true);
  expect(out.content[0]!.text).toContain('ENOSPC: no space left on device');
});
