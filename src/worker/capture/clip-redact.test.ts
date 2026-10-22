// A source cuts its text (clip(): 200 / 300 / 2 000 chars; agy: 2 000-char pieces) BEFORE the driver sees it, and a token the cut
// lands inside is a head too short for its rule to match. So the cut redacts first (shared.ts redactedHead). Placeholders only.
import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Database } from 'bun:sqlite';
import { clip } from './shared.ts';
import { redactSecrets } from '../../shared/redact-secrets.ts';
import { createCodexSource } from './codex-source.ts';
import { createAgySource } from './agy-source.ts';

const TOKEN = 'glpat-' + 'x'.repeat(20);
const VALUE = 'ZqXwEr7Ty1Ui5Op2As6Df0Gh';
const PEM = (lines: number) => '-----BEGIN RSA PRIVATE KEY-----\n' + 'PLACEHOLDERPLACEHOLDERPLACEHOLDER\n'.repeat(lines) + '-----END RSA PRIVATE KEY-----';
const TAIL = ' tail words '.repeat(400);   // text running far past the cut
/** Any 4 chars of the secret in the output: a head of it survived. */
const leaks = (out: string, secret: string): boolean => {
  for (let i = 0; i + 4 <= secret.length; i++) if (out.includes(secret.slice(i, i + 4))) return true;
  return false;
};

for (const max of [200, 300, 2000]) {
  test(`clip(…, ${max}): a token the cut lands in leaves no head, wherever it starts, with or without text after it`, () => {
    for (let off = max - 40; off <= max + 2; off++) {
      for (const tail of ['', TAIL]) {
        const out = clip('a'.repeat(off) + ' ' + TOKEN + tail, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(leaks(out, TOKEN)).toBe(false);
      }
    }
  });
}

const KINDS: Record<string, { text: string; secret: string }> = {
  'password=': { text: `password=${VALUE}`, secret: VALUE },
  'a password in a URL': { text: `https://deploy:${VALUE}@git.example.test/repo.git`, secret: VALUE },
  'a JWT': { text: 'eyJZqXwEr7Ty1Ui.Ab1Cd2Ef3Gh4Ij5K.Lm6Np7Qr8St9Uv0W', secret: 'eyJZqXwEr7Ty1Ui.Ab1Cd2Ef3Gh4Ij5K.Lm6Np7Qr8St9Uv0W' },
  'a bearer token': { text: `Authorization: Bearer ${VALUE}`, secret: VALUE },
  'a private key whose END is far past the cut': { text: PEM(120), secret: '-----BEGIN RSA PRIVATE KEY-----PLACEHOLDERPLACEHOLDER' },
};
for (const [name, k] of Object.entries(KINDS)) {
  test(`clip(…, 300): ${name} straddling the cut leaves no head`, () => {
    expect(clip(`run ${k.text} now`, 100_000)).toContain('[REDACTED');   // the shape is recognised at all: the sweep is not vacuous
    for (let off = 300 - Math.min(k.text.length, 90) - 2; off <= 302; off++) {
      for (const tail of ['', TAIL]) expect(leaks(clip('a'.repeat(off) + ' ' + k.text + tail, 300), k.secret)).toBe(false);
    }
  });
}

test('clip: a url password whose "@" lies 900 chars past the cut is still redacted (the reach past the cut)', () => {
  const url = 'https://deploy:' + 'Zq9'.repeat(300) + '@git.example.test/x';
  for (let off = 270; off <= 300; off++) expect(leaks(clip('a'.repeat(off) + ' ' + url, 300), 'Zq9Zq9')).toBe(false);
});

test('clip: redaction that removes text does not let a secret behind it slip across the cut', () => {
  // three PEM keys shrink to three markers, so the token that follows them lands at the cut only after redaction
  for (let filler = 220; filler <= 245; filler++) {
    expect(leaks(clip(PEM(120) + PEM(120) + PEM(120) + 'a'.repeat(filler) + ' ' + TOKEN + ' tail', 300), TOKEN)).toBe(false);
  }
});

test('clip: a private key ahead of a token puts it at the cut only after redaction; no window edge may land inside it', () => {
  // The test above does not discriminate: its token ends up ~12 KB past the cut, so it cannot leak whatever clip() does. Here the key
  // shrinks to one marker and the token starts at redacted offset s (straddling the 300 cut) at a RAW offset that moves with the
  // key's length, so sweeping both puts the edge of a fixed window, or of a loop that stops on raw instead of redacted length,
  // or of one that stops at `max` without the reach, inside the token somewhere in the sweep.
  const key = (n: number) => '-----BEGIN RSA PRIVATE KEY-----\n' + 'PLACEHOLDERPLACEH\n'.repeat(n) + '-----END RSA PRIVATE KEY-----';
  let cases = 0;
  for (let n = 1; n <= 260; n++) {
    const marker = redactSecrets(key(n)).text.length;
    for (let s = 262; s <= 296; s++) {
      cases++;
      expect(leaks(clip(key(n) + 'a'.repeat(s - marker - 1) + ' ' + TOKEN + ' tail words', 300), TOKEN)).toBe(false);
    }
  }
  expect(cases).toBeGreaterThan(9000);   // the sweep ran
});

test('clip: redaction that adds text still ends at max, and clean text is cut exactly as before', () => {
  const grown = clip('pwd=abcd '.repeat(200), 300);
  expect(grown.length).toBe(300);
  expect(grown).not.toContain('abcd');
  expect(clip('  hello world  ', 300)).toBe('hello world');
  expect(clip('word '.repeat(1000), 300)).toBe('word '.repeat(1000).trim().slice(0, 299) + '…');
});

test('clip: a multi-megabyte argument is clipped in about a millisecond, not by redacting all of it', () => {
  const huge = 'a'.repeat(280) + ' ' + TOKEN + ' ' + 'z'.repeat(6_000_000);   // whole-string redaction of this takes ~0.8 s
  const t0 = performance.now();
  const out = clip(huge, 300);
  expect(performance.now() - t0).toBeLessThan(100);
  expect(leaks(out, TOKEN)).toBe(false);
});

// ── the sources that cut: codex (a 2 000-char turn field, a 300-char tool argument) and agy (2 000-char pieces) ──
const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function codexEvents(user: string, toolInput?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-clip-codex-'));
  const path = join(dir, `rollout-2026-10-22T10-00-00-${UUID}.jsonl`);
  const lines: object[] = [{ type: 'event_msg', payload: { type: 'user_message', message: user } }];
  if (toolInput !== undefined) lines.push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: toolInput } });
  writeFileSync(path, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  return createCodexSource({ projectId: 'proj', warn: () => {} }).extract({ sessionId: UUID, path, marker: 'm', mtimeEpoch: 1 });
}

test('codex: a token the 2 000-char cut of the prompt lands in leaves no head', () => {
  for (let off = 1960; off <= 2002; off++) {
    const evs = codexEvents('a'.repeat(off) + ' ' + TOKEN);
    expect(evs).toHaveLength(1);
    expect(leaks(evs[0]!.tool_input_summary, TOKEN)).toBe(false);
  }
});

test('codex: a token the 300-char cut of a tool argument lands in leaves no head', () => {
  for (let off = 260; off <= 302; off++) {
    const evs = codexEvents('go', 'a'.repeat(off) + ' ' + TOKEN);
    expect(evs).toHaveLength(1);
    expect(leaks(evs[0]!.tool_result_summary, TOKEN)).toBe(false);
  }
});

test('agy: a token across the boundary between two 2 000-char pieces is not left as two halves', () => {
  for (let off = 1960; off <= 2002; off++) {
    const dir = mkdtempSync(join(tmpdir(), 'cm-clip-agy-'));
    const path = join(dir, 'aaaa-bbbb.db');
    const db = new Database(path);
    db.exec('CREATE TABLE steps (idx INTEGER, step_payload BLOB)');
    db.query('INSERT INTO steps (idx, step_payload) VALUES (?, ?)').run(0, Uint8Array.from([0x08, 0x0e, ...Buffer.from('a'.repeat(off) + ' ' + TOKEN + ' end'), 0x00]));
    db.close();
    const evs = createAgySource({ projectId: 'proj' }).extract({ sessionId: 'aaaa-bbbb', path, marker: 'm', mtimeEpoch: 1 });
    expect(evs.length).toBeGreaterThanOrEqual(1);
    for (const e of evs) expect(leaks(e.tool_result_summary, TOKEN)).toBe(false);
  }
});
