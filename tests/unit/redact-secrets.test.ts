import { test, expect } from 'bun:test';
import { redactSecrets, looksLikeCredential } from '../../src/shared/redact-secrets.ts';

test('credential-shaped values are replaced, the surrounding prose is kept', () => {
  const r = redactSecrets([
    'GitLab token glpat-AbCdEfGhIjKlMnOpQrSt12 for the runner',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123 on GitHub',
    'clone https://kalin:s3cr3t-pw@gitlab.example/x.git',
    'password=hunter2 and PASSWD: "letmein" and api_key = abc123def456',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----',
  ].join('\n'));
  expect(r.count).toBeGreaterThanOrEqual(10);
  expect(r.text).not.toContain('glpat-AbCd');
  expect(r.text).not.toContain('ghp_ABCD');
  expect(r.text).not.toContain('s3cr3t-pw');
  expect(r.text).toContain('https://kalin:[REDACTED]@gitlab.example/x.git');
  expect(r.text).not.toContain('hunter2');
  expect(r.text).not.toContain('letmein');
  expect(r.text).not.toContain('abc123def456');
  expect(r.text).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0');
  expect(r.text).not.toContain('sk-ant-api03');
  expect(r.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
  expect(r.text).not.toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW');
  expect(r.text).toContain('[REDACTED:private-key]');
  expect(r.text).toContain('GitLab token [REDACTED:gitlab-token] for the runner');
  expect(r.text).toContain('password=[REDACTED]');
});

test('ordinary prose, hashes and ids are left alone', () => {
  for (const s of [
    'commit 91ad5af on master; port 39888; session_01AbCdEfGhIjKlMnOpQrStUv',
    'the password field is required; token counts drove 45% of spend',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'MY_SERVICE_TOKEN is read from worker.env (never echo it)',
    'Set-ScheduledTask; key = value pairs in the ledger',
  ]) {
    expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
    expect(looksLikeCredential(s)).toBe(false);
  }
  expect(looksLikeCredential('here: glpat-AbCdEfGhIjKlMnOpQrSt12')).toBe(true);
});

// Runs on every auto-recall candidate, remote hit and inbox body, synchronously on the worker's event loop, so no
// input may make it quadratic. Measured 2026-09-29: every case below 0.4-5 ms except the BEGIN run (47 ms, the key
// body scan is bounded at 10 000 chars); unanchored, 'eyJ-'/'sk-'/'glpat-' runs and dotted runs took seconds.
test('adversarial runs stay linear', () => {
  const cases = [
    ' '.repeat(100_000) + 'hello', 'eyJ-'.repeat(25_000), 'a.'.repeat(20_000), 'a-'.repeat(20_000), 'word-'.repeat(5_000),
    'password' + ' '.repeat(40_000), 'password' + '\t'.repeat(40_000), 'sk-'.repeat(25_000), 'sk-ant-'.repeat(15_000),
    'glpat-'.repeat(20_000), 'xoxb-'.repeat(20_000), 'github_pat_'.repeat(10_000), 'token='.repeat(20_000),
    'Bearer '.repeat(20_000), 'A\n'.repeat(100_000), 'https://'.repeat(10_000), 'a'.repeat(50_000) + '://x',
    '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(2_000),
  ];
  for (const c of cases) {
    const t = performance.now();
    redactSecrets(c);
    expect(performance.now() - t).toBeLessThan(400);
  }
});

test('the run-start anchors still catch a token after ordinary punctuation', () => {
  const key = 'sk-ant-' + 'a'.repeat(30);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  for (const s of [`key: ${key}`, `"${key}"`, `(${key})`, `=${key}`, `Authorization: ${jwt}`, `glpat-${'A'.repeat(20)}`]) {
    expect(redactSecrets(s).count).toBeGreaterThan(0);
  }
  expect(redactSecrets('see https://ci.example.com/job and https://bot:hunter2secret@git.example.com/repo').text)
    .toBe('see https://ci.example.com/job and https://bot:[REDACTED]@git.example.com/repo');
});
