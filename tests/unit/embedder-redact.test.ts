import { test, expect, beforeAll, afterAll } from 'bun:test';
import { Embedder, embedRedactEnabled } from '../../src/worker/embedder.ts';
import { redactSecrets } from '../../src/shared/redact-secrets.ts';
import { countTokens } from '../../src/shared/tokens.ts';

// CAPTAIN_MEMO_EMBED_REDACT: what is handed to a hosted embedder is redacted, nothing else is. Every secret here is made up.

const FAKE_GITLAB = 'glpat-AbCdEfGhIjKlMnOpQrSt12';
const SECRET_TEXT = `GitLab token ${FAKE_GITLAB} for the runner, password=hunter2 in the unit file`;
const PLAIN_TEXT = 'the retry queue drains every five seconds; commit 91ad5af on master';

let server: ReturnType<typeof Bun.serve>;
let url: string;
let rawBody = '';
let sent: { input?: string[]; texts?: string[] } = {};

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      rawBody = await req.text();
      sent = JSON.parse(rawBody);
      const n = (sent.input ?? sent.texts ?? []).length;
      const vecs = Array.from({ length: n }, (_, i) => [i + 1, 2, 3]);
      return Response.json({ data: vecs.map((embedding, index) => ({ embedding, index })), embeddings: vecs, model: 'm' });
    },
  });
  url = `http://127.0.0.1:${server.port}/v1/embeddings`;
});
afterAll(() => server.stop());

async function withEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const was = process.env.CAPTAIN_MEMO_EMBED_REDACT;
  if (value === undefined) delete process.env.CAPTAIN_MEMO_EMBED_REDACT; else process.env.CAPTAIN_MEMO_EMBED_REDACT = value;
  try { return await fn(); } finally {
    if (was === undefined) delete process.env.CAPTAIN_MEMO_EMBED_REDACT; else process.env.CAPTAIN_MEMO_EMBED_REDACT = was;
  }
}

test('default: with the setting absent the request body is byte-identical to what the caller passed', async () => {
  await withEnv(undefined, async () => {
    const e = new Embedder({ endpoint: url, model: 'm' });
    expect(e.redactsInput).toBe(false);
    await e.embed([SECRET_TEXT, PLAIN_TEXT], 'document');
    expect(rawBody).toBe(JSON.stringify({ input: [SECRET_TEXT, PLAIN_TEXT], model: 'm', input_type: 'document', truncation: false }));
  });
});

test('on: only the copy that is sent is redacted, 1:1 and in order; the caller\'s strings are untouched', async () => {
  const texts = [PLAIN_TEXT, SECRET_TEXT, PLAIN_TEXT];
  const before = [...texts];
  const e = new Embedder({ endpoint: url, model: 'm', redactInput: true });
  const out = await e.embed(texts, 'document');
  expect(out).toHaveLength(3);
  expect(sent.input).toHaveLength(3);
  expect(sent.input![0]).toBe(PLAIN_TEXT);
  expect(sent.input![1]).toBe('GitLab token [REDACTED:gitlab-token] for the runner, password=[REDACTED] in the unit file');
  expect(rawBody).not.toContain('glpat-');
  expect(rawBody).not.toContain('hunter2');
  expect(texts).toEqual(before);
});

test('on: a query and the aelita request shape are redacted as well', async () => {
  const e = new Embedder({ endpoint: url, model: 'm', redactInput: true });
  await e.embed([`why does ${FAKE_GITLAB} fail`], 'query');
  expect(sent.input![0]).not.toContain('glpat-');
  const a = new Embedder({ endpoint: url, model: 'm', apiFormat: 'aelita', redactInput: true });
  await a.embed([SECRET_TEXT], 'document');
  expect(sent.texts![0]).not.toContain('glpat-');
  expect(sent.texts![0]).toContain('[REDACTED:gitlab-token]');
});

test('metering counts what was sent, not the original', async () => {
  const long = `key sk-ant-api03-${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7'.repeat(12)} end`;
  const redacted = redactSecrets(long).text;
  expect(countTokens(redacted)).toBeLessThan(countTokens(long));
  const on = new Embedder({ endpoint: url, model: 'm', redactInput: true });
  await on.embed([long], 'document');
  expect(on.usage().tokens).toBe(countTokens(redacted));
  const off = new Embedder({ endpoint: url, model: 'm', redactInput: false });
  await off.embed([long], 'document');
  expect(off.usage().tokens).toBe(countTokens(long));
});

test('the size check judges the redacted text, which is what the provider would receive', async () => {
  const long = `key sk-ant-api03-${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7'.repeat(40)} end`;
  const limit = Math.ceil(countTokens(redactSecrets(long).text) / 0.85) + 20;   // fits once redacted, not as written
  expect(countTokens(long)).toBeGreaterThan(Math.floor(limit * 0.85));
  await new Embedder({ endpoint: url, model: 'm', redactInput: true, maxInputTokens: limit }).embed([long], 'document');
  await expect(new Embedder({ endpoint: url, model: 'm', redactInput: false, maxInputTokens: limit }).embed([long], 'document'))
    .rejects.toThrow(/too large/);
});

test('known limit: two chunks that differ only inside a redacted value are sent as the same text', async () => {
  const a = 'rotated the runner token to glpat-AbCdEfGhIjKlMnOpQrSt12 today';
  const b = 'rotated the runner token to glpat-ZyXwVuTsRqPoNmLkJiHg98 today';
  const c = 'rotated the runner token to glpat-AbCdEfGhIjKlMnOpQrSt12 yesterday';
  const e = new Embedder({ endpoint: url, model: 'm', redactInput: true });
  await e.embed([a, b, c], 'document');
  expect(sent.input![0]).toBe(sent.input![1]!);
  expect(sent.input![2]).not.toBe(sent.input![0]!);   // any other difference still tells them apart
});

test('embedRedactEnabled: exactly `1`, and only for an endpoint that is not on this machine', () => {
  const on = { CAPTAIN_MEMO_EMBED_REDACT: '1' };
  for (const hosted of ['https://api.voyageai.com/v1/embeddings', 'http://192.168.1.20:8124/v1/embeddings', 'http://embed.lan:8124/embed', 'not a url']) {
    expect(embedRedactEnabled(hosted, on)).toBe(true);
  }
  for (const local of ['http://127.0.0.1:8124/v1/embeddings', 'http://localhost:8124/v1/embeddings', 'http://localhost:11434/v1/embeddings', 'http://127.0.1.1:8124/x', 'http://[::1]:8124/x']) {
    expect(embedRedactEnabled(local, on)).toBe(false);
  }
  for (const off of [undefined, '', '0', 'true', 'yes', 'on']) {
    expect(embedRedactEnabled('https://api.voyageai.com/v1/embeddings', { CAPTAIN_MEMO_EMBED_REDACT: off })).toBe(false);
  }
});

test('an Embedder built with no option follows the environment and its endpoint', async () => {
  const hosted = 'https://api.voyageai.com/v1/embeddings';
  await withEnv('1', () => {
    expect(new Embedder({ endpoint: hosted, model: 'm' }).redactsInput).toBe(true);
    expect(new Embedder({ endpoint: url, model: 'm' }).redactsInput).toBe(false);   // the loopback mock stands for the sidecar
    expect(new Embedder({ endpoint: hosted, model: 'm', redactInput: false }).redactsInput).toBe(false);
  });
  await withEnv(undefined, () => {
    expect(new Embedder({ endpoint: hosted, model: 'm' }).redactsInput).toBe(false);
  });
});
