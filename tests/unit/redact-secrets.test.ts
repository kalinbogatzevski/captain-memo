import { test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { redactSecrets, looksLikeCredential } from '../../src/shared/redact-secrets.ts';
import { chunkMemoryFile } from '../../src/worker/chunkers/memory-file.ts';
import { splitForEmbed } from '../../src/worker/chunkers/safe-split.ts';

// Every value in this file is made up (FAKE…, or a hash of a FAKE string): the rules only need the shape.

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

test('.env and config shapes: prefixed and UPPERCASE env names, quoted keys, PHP =>, define(), index keys', () => {
  // Before: the \b in front of the keyword never fired after '_' (DB_PASSWORD), a quoted key failed on its closing
  // quote, and => was not a shape at all. Only the value goes; its quotes stay.
  const cases: Array<[string, string]> = [
    ['DB_PASSWORD=plainfakeword', 'DB_PASSWORD=[REDACTED]'],
    ['MYSQL_PWD=fake0000', 'MYSQL_PWD=[REDACTED]'],
    ['PGPASSWORD=fakefakefake', 'PGPASSWORD=[REDACTED]'],
    ['export VOYAGE_API_KEY=pa-FAKE0000fake0000', 'export VOYAGE_API_KEY=[REDACTED]'],
    ['{"password": "fake pw, with a comma"}', '{"password": "[REDACTED]"}'],
    ["$cfg = ['db_pass' => 'fakefake'];", "$cfg = ['db_pass' => '[REDACTED]'];"],
    ["$cfg['db_password'] = 'fakefake';", "$cfg['db_password'] = '[REDACTED]';"],
    ['os.environ["API_KEY"] = "fakefake"', 'os.environ["API_KEY"] = "[REDACTED]"'],
    ['x-api-key: FAKE0000fake', 'x-api-key: [REDACTED]'],
    ['spring.datasource.password=fakefake', 'spring.datasource.password=[REDACTED]'],
    ["{ dbPassword: 'fakefake' }", "{ dbPassword: '[REDACTED]' }"],
    ["define('DB_PASSWORD', 'FAKEfake0000');", "define('DB_PASSWORD', '[REDACTED]');"],
    ["define( 'DB_PASSWORD', 'fake pw' );", "define( 'DB_PASSWORD', '[REDACTED]' );"],
    ["define('OST_DB_PASS', 'fakeFAKE00');", "define('OST_DB_PASS', '[REDACTED]');"],
    ['SECRET_KEY=FAKEfake0000fake', 'SECRET_KEY=[REDACTED]'],
    ['APP_KEY=base64:FAKEfake0000FAKEfake0000FAKE=', 'APP_KEY=[REDACTED]'],
    ['ENCRYPTION_KEY=fakefakefakefake', 'ENCRYPTION_KEY=[REDACTED]'],
  ];
  for (const [input, want] of cases) expect(redactSecrets(input)).toEqual({ text: want, count: 1 });
  // A vendor rule that already took the value is not counted twice.
  expect(redactSecrets('token: glpat-AbCdEfGhIjKlMnOpQrSt12')).toEqual({ text: 'token: [REDACTED:gitlab-token]', count: 1 });
  // ...but a lowercase key before a comma is a list of names (Laravel's only()/$hidden), not define().
  for (const s of ["->only('email', 'password')", "$hidden = ['password', 'remember_token'];", "define('DB_NAME', 'wordpress');",
    'CAPTAIN_MEMO_HUB_TOKEN is read from worker.env (never echo it)']) {
    expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
  }
});

test('command lines and URLs: mysql -p, sshpass -p, curl -u, redis://:pw@', () => {
  const cases: Array<[string, string]> = [
    ['mysql -u root -pFAKEfake0 appdb', 'mysql -u root -p[REDACTED] appdb'],
    ['redis://:FAKEpw0000@cache.example:6379', 'redis://:[REDACTED]@cache.example:6379'],
    ['curl -u admin:FAKEpw0000 https://x.example', 'curl -u admin:[REDACTED] https://x.example'],
    ["curl --user 'svc:FAKE0000' x", "curl --user 'svc:[REDACTED]' x"],
    ["sshpass -p 'FAKEpw0000' ssh root@h", "sshpass -p '[REDACTED]' ssh root@h"],
  ];
  for (const [input, want] of cases) expect(redactSecrets(input)).toEqual({ text: want, count: 1 });
  for (const s of ['ssh -p2222 host', 'gcc -pthread x.c', 'mysql -u root -p appdb', 'curl -u "$USER:$TOKEN" x']) {
    expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
  }
});

test('prose: a secret-looking value after password / pw goes; the word password in a sentence stays', () => {
  const pw = 'Qz7FAKEfake9Lm2x';
  for (const [input, want] of [
    [`• OST_DB_HOST resolves to db.example.com with password ${pw}`, '• OST_DB_HOST resolves to db.example.com with password [REDACTED]'],
    [`the password is ${pw}.`, 'the password is [REDACTED].'],
    [`password \`${pw}\``, 'password `[REDACTED]`'],
    [`root password ${pw} on the OLT`, 'root password [REDACTED] on the OLT'],
    [`pw: ${pw}`, 'pw: [REDACTED]'],
    [`and password '${pw}'`, "and password '[REDACTED]'"],
    [`Password:\n${pw}`, 'Password:\n[REDACTED]'],
  ] as const) expect(redactSecrets(input)).toEqual({ text: want, count: 1 });
  for (const s of [
    'password field is required', 'password must be 12+ chars', 'password reset link', 'the passwords in the repo2026 folder',
    'Password:\n\nRotate it quarterly.', 'password argon2id', 'passphrase id_ed25519.pub', 'the password is sha256-hashed',
  ]) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
});

test('prose that only looks like a key=value stays: a bare word, short number, flag, score, placeholder or reference', () => {
  for (const s of [
    'Basic authentication-mechanism', 'max token: 4000', 'secret: true', 'pass: install', 'the secret: patience',
    'bypass: v2cache', 'compass=north', 'find . -print', 'let t = Token::Kind(0);',
    'All tests pass: 1875/1875', "Access denied for user 'root'@'localhost' (using password: YES)", 'PWD=/home/k/projects',
    'OLDPWD=/tmp', 'passwd: files systemd', 'password: $DB_PASSWORD', 'DB_PASSWORD=${DB_PASSWORD}', 'password: <your-password>',
    'token: "{{ .Token }}"', 'password=%(password)s', 'api_key: process.env.VOYAGE_API_KEY', 'apiKey: config.apiKey',
    'token: getToken()', "'password' => 'required|min:8'", "'password' => Hash::make($data['password']),",
    "bcrypt($data['password'])",
  ]) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
  // ...but the same keys with a secret-looking, quoted or long-number value still go.
  expect(redactSecrets('token: fake0000').count).toBe(1);
  expect(redactSecrets('pass: "fakeword"').count).toBe(1);
  expect(redactSecrets('pass: 12345678').text).toBe('pass: [REDACTED]');
  expect(redactSecrets('token: 834920184720').text).toBe('token: [REDACTED]');
  expect(redactSecrets('password: $2y$10$FAKEfakeFAKEfakeFAKEfake').text).toBe('password: [REDACTED]');   // a bcrypt hash
  expect(redactSecrets('token: FAKE29.a0FAKEfake0000.fakeFAKE').text).toBe('token: [REDACTED]');   // dotted, but a token
  expect(redactSecrets('Basic ZmFrZTpmYWtlZmFrZQ==').text).toBe('Basic [REDACTED]');
  // The keyword inside a word is a key when the value is not a plain word.
  for (const s of ['dbpass=Xk82pqzLm', 'adminpass: Xk82pqzLm', 'rootpassword=Xk82pqzLm']) expect(redactSecrets(s).text).toEndWith('[REDACTED]');
});

test('a bare Voyage key and PGP armour', () => {
  expect(redactSecrets('VOYAGE pa-FAKEfakeFAKEfake0000FAKEfake0000FAKEfake000'))
    .toEqual({ text: 'VOYAGE [REDACTED:voyage-key]', count: 1 });
  const body = ['FAKEkeyAAAAbbbbCCCCdddd0000eeeeFFFFgggg1111hhhhIIIIjjjj2222kkkkLL', 'FAKEkeyMMMMnnnnOOOOpppp3333qqqqRRRRssss4444ttttUUUUvvvv5555wwwwXX'];
  const pgp = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${body.join('\n')}\n=FaKe\n-----END PGP PRIVATE KEY BLOCK-----`;
  expect(redactSecrets(`key:\n${pgp}\nend`)).toEqual({ text: 'key:\n[REDACTED:private-key]\nend', count: 1 });
  expect(redactSecrets(`${body.join('\n')}\n=FaKe\n-----END PGP PRIVATE KEY BLOCK-----\nend`).text).toBe('[REDACTED:private-key]\nend');
});

test('a private key cut across chunks: the head chunk (no END) and the tail chunk (no BEGIN) are both redacted', () => {
  const body = ['FAKEkeyAAAAbbbbCCCCdddd0000eeeeFFFFgggg1111hhhhIIIIjjjj2222kkkkLL', 'FAKEkeyMMMMnnnnOOOOpppp3333qqqqRRRRssss4444ttttUUUUvvvv5555wwwwXX'];
  const head = redactSecrets(`Deploy key for the runner:\n-----BEGIN RSA PRIVATE KEY-----\n${body.join('\n')}`);
  expect(head).toEqual({ text: 'Deploy key for the runner:\n[REDACTED:private-key]', count: 1 });
  const tail = redactSecrets(`${body.join('\n')}\n-----END RSA PRIVATE KEY-----\n\nThen restart the runner.`);
  expect(tail).toEqual({ text: '[REDACTED:private-key]\n\nThen restart the runner.', count: 1 });
  // A service-account JSON key is one line with literal \n escapes; a chunk may even start on the n of one.
  const json = redactSecrets(`n${body.join('\\n')}\\n-----END PRIVATE KEY-----\\n", "client_email": "x@fake.example"}`);
  expect(json.text).toBe('[REDACTED:private-key]\\n", "client_email": "x@fake.example"}');
  // Indented (YAML block scalar).
  expect(redactSecrets(`  ${body.join('\n  ')}\n  -----END PRIVATE KEY-----`).text).toBe('  [REDACTED:private-key]');
});

// High-entropy fake key lines (hashes of FAKE strings): low-entropy ones tokenize compactly and never split.
const keyLines = Array.from({ length: 25 }, (_, i) => createHash('sha512').update(`FAKE-key-line-${i}`).digest('base64').slice(0, 64));
const pem = `-----BEGIN RSA PRIVATE KEY-----\n${keyLines.join('\n')}\nFAKEshortLastLine0000000000==\n-----END RSA PRIVATE KEY-----`;

test('a key split by a 512-token embedder (voyage-4-nano, nomic-embed-text): no whole body line survives in any chunk', () => {
  // The chunker splits a PEM body line by line and chops a JSON-escaped one every ~550 chars, so no chunk has both
  // BEGIN and END and most have neither; before, every body line of these came through unredacted.
  const files = {
    h2: `# Runner\n\nintro\n\n## Deploy key\n\nThe runner key:\n${pem}\n\nRestart after.\n`,
    fenced: `# Runner\n\n## Deploy key\n\n\`\`\`\n${pem}\n\`\`\`\n`,
    flat: `The runner key:\n${pem}\n`,
    json: `## Service account\n\n{"type": "service_account", "private_key": "${pem.replace(/\n/g, '\\n')}\\n", "client_email": "x@fake.example"}\n`,
  };
  // 16-char windows every 8 chars: a chop mid-line must not leak the half it keeps either.
  const windows = keyLines.flatMap((l) => [0, 8, 16, 24, 32, 40, 48].map((i) => l.slice(i, i + 16)));
  for (const [name, content] of Object.entries(files)) {
    const chunks = splitForEmbed(chunkMemoryFile(content, `/x/${name}.md`), 512);
    expect(chunks.length).toBeGreaterThan(3);   // it really was split
    const injected = chunks.map((c) => redactSecrets(c.text).text).join('\u0000');
    expect({ name, leaked: windows.filter((w) => injected.includes(w)) }).toEqual({ name, leaked: [] });
  }
});

test('a lone chunk of base64 lines is a key body; cut BEGIN/END edges too; prose, hashes and short lines are not', () => {
  const b = keyLines.slice(0, 3);
  expect(redactSecrets(b[0]!).text).toBe('[REDACTED:base64-block]');
  expect(redactSecrets(`8Qch\\n${b.join('\\n')}\\nhuvo`).text).toBe('[REDACTED:base64-block]');   // a JSON chop, cut ends
  expect(redactSecrets(`ATE KEY-----\\n${b.join('\\n')}`).text).toBe('[REDACTED:base64-block]');   // chopped in BEGIN
  expect(redactSecrets(`${b.join('\\n')}\\n-----EN`).text).toBe('[REDACTED:base64-block]');        // chopped in END
  for (const s of [
    'Deploy Runner2', 'Hello World 2026', 'Changelog\nv2Release', 'Version=Release2026Candidate', 'ReleaseCandidate2026Final',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n2a278ba00d97d8122a99b',
    'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789',
  ]) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
});

// Runs on every auto-recall candidate, remote hit and inbox body, synchronously on the worker's event loop, so no
// input may make it quadratic. Each blow-up guarded here was 263 ms to 5 s before its rule was bounded or anchored:
// unanchored 'eyJ-'/'sk-'/'glpat-' runs and dotted runs, the key-tail rule with every base64 line a start, lookbehinds
// rescanning a whitespace run, the mysql rule unbounded on one line.
test('adversarial runs stay linear', () => {
  const line = 'FAKEkeyAAAAbbbbCCCCdddd0000eeeeFFFFgggg1111hhhhIIIIjjjj2222kkkkLL';
  const sp = ' '.repeat(50_000);
  const cases: Record<string, string> = {
    'spaces+hello': ' '.repeat(100_000) + 'hello', 'eyJ-': 'eyJ-'.repeat(25_000), 'a.': 'a.'.repeat(20_000),
    'a-': 'a-'.repeat(20_000), 'word-': 'word-'.repeat(5_000), 'a_': 'a_'.repeat(20_000), 'A': 'A'.repeat(100_000),
    'A!': `${'A'.repeat(100_000)}!`, 'A\\n': 'A\n'.repeat(100_000), 'password+spaces': 'password' + ' '.repeat(40_000),
    'password+tabs': 'password' + '\t'.repeat(40_000), 'sk-': 'sk-'.repeat(25_000), 'sk-ant-': 'sk-ant-'.repeat(15_000),
    'glpat-': 'glpat-'.repeat(20_000), 'xoxb-': 'xoxb-'.repeat(20_000), 'github_pat_': 'github_pat_'.repeat(10_000),
    'pa-': 'pa-'.repeat(25_000), 'token=': 'token='.repeat(20_000), 'Bearer ': 'Bearer '.repeat(20_000),
    'https://': 'https://'.repeat(10_000), 'a…://x': 'a'.repeat(50_000) + '://x',
    'BEGIN×2000': '-----BEGIN RSA PRIVATE KEY-----\n'.repeat(2_000),
    'lines': `x y\n${`${line}\n`.repeat(3000)}`, 'escaped lines': `x y\n${`${line}\\n`.repeat(3000)}`,
    'one run': `x y ${line.repeat(3000)}`, 'lines!': `${`${line}\n`.repeat(3000)}!`, 'escaped lines!': `${`${line}\\n`.repeat(3000)} !`,
    'lines+END': `x y\n${`${line}\n`.repeat(3000)}x -----END RSA PRIVATE KEY-----`,
    'mysql': 'mysql -u root '.repeat(5000), 'curl': 'curl -u a '.repeat(5000), 'sshpass': 'sshpass x '.repeat(5000),
    'password:+spaces': `password:${sp}`, 'pass_': 'pass_'.repeat(10000), 'password ': 'password '.repeat(20000),
    'spaces': sp, 'tabs': '\t'.repeat(50000), 'password+spaces!': `password${sp}!`,
    "password'+spaces+,": `password'${sp},${sp}!`, 'key line, -, spaces': `${line}\n-${sp}!`,
    "define('": "define('".repeat(10000),
    // Review 2026-09-29: a trailing-punctuation trim that restarted at every char, and curl's '=' split two ways.
    'token=…x': 'token=' + '.'.repeat(25_000) + 'x', 'password )…': 'password: FAKE' + ')'.repeat(25_000) + '!',
    'curl -u =…': 'curl -u' + '='.repeat(20_000), 'curl×40 -u =…': 'curl '.repeat(40) + '-u' + '='.repeat(20_000),
    'a\\/ run': 'a\\/'.repeat(20_000) + '!', 'SSH2 BEGIN×2000': '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\n'.repeat(2_000),
    '> run': 'A\n' + '> '.repeat(50_000) + '!',
    // Review round 2: escaped-slash key lines with an END line present (1.2-2.8 s before slashRuns took '\/' out of the regexes).
    '\\/A lines+END': 'x -----END RSA PRIVATE KEY-----\n' + '\\/A\n'.repeat(16_000) + '!',
    '\\/ run+END': '\\/'.repeat(32_743) + '!-----END RSA PRIVATE KEY-----',
    '60-char \\/ lines+END': 'x -----END RSA PRIVATE KEY-----\n' + ('\\/' + 'A'.repeat(60) + '\n').repeat(1_039) + '!',    // Review round 3: a 64K+ run of '|a' or '.a' after token= fell off JSC's fast path in kvIsProse (22 → 323 ms at 128 KB).
    '|a after token=': 'token=a' + '|a'.repeat(65_536) + '!', '.a after token=': 'token=a' + '.a'.repeat(131_072) + '1',    // #192's rules: bounded command windows, the table pass, the XML / connect / env shapes, spaced and hex key bodies.
    'snmpwalk×': 'snmpwalk -c '.repeat(5_000), 'AUTH lines': 'AUTH x\n'.repeat(10_000), 'table rows': '| password |\n|---|\n' + '| a |\n'.repeat(10_000),
    'pipes': '|'.repeat(60_000), '<password>×': '<password>'.repeat(6_000), 'new PDO(': 'new PDO(' + 'a'.repeat(60_000),
    'b64 words': ('A'.repeat(60) + ' ').repeat(1_000) + '!', 'hex lines': ('0'.repeat(32) + '\n').repeat(2_000) + '!', '|a|+spaces': '|a|\n' + ' '.repeat(50_000) + 'x', 'spaces+|x|': ' '.repeat(50_000) + '|x|', 'setx KEY×': 'setx ' + 'KEY'.repeat(20_000) + '!', 'Environment=KEY×': 'Environment="A' + 'KEY'.repeat(20_000) + '=' + 'v'.repeat(1_000), 'pin columns': '|' + 'pin|'.repeat(8_192) + '\n|---|\n' + '||\n'.repeat(5_000),
    'парола+spaces': 'парола' + ' '.repeat(50_000) + '!', 'парола за×': 'парола за '.repeat(6_000),
  };
  const slow: string[] = [];
  for (const [name, s] of Object.entries(cases)) {
    const t0 = performance.now();
    redactSecrets(s);
    const ms = performance.now() - t0;
    if (ms > 400) slow.push(`${name}: ${ms.toFixed(0)} ms`);
  }
  expect(slow).toEqual([]);
});

test('the run-start anchors still catch a token after ordinary punctuation', () => {
  const key = 'sk-ant-' + 'a'.repeat(30);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
  for (const s of [`key: ${key}`, `"${key}"`, `(${key})`, `=${key}`, `Authorization: ${jwt}`, `glpat-${'A'.repeat(20)}`]) {
    expect(redactSecrets(s).count).toBeGreaterThan(0);
  }
  expect(redactSecrets('see https://ci.example.com/job and https://bot:hunter2secret@git.example.com/repo').text)
    .toBe('see https://ci.example.com/job and https://bot:[REDACTED]@git.example.com/repo');
  expect(redactSecrets('x_https://u:pw1234@h.example').text).toBe('x_https://u:[REDACTED]@h.example');
});

// Review 2026-09-29 (four adversarial hunters, each finding re-run): prose and code that must stay, and the shapes that
// must go. The Password:/token: ones with a plain or camelCase value stay redacted on purpose: a weak password is one.
test('review: verdicts, placeholders, type names, env-var names, sudoers and slugs are not secrets', () => {
  for (const s of [
    'PASS: price set', 'echo ($ok ? "PASS" : "FAIL") . "\\n";', 'curl -H "X-API-Key: ak_xxxxx_xxxxxxxx" https://erp.example/api',
    'api_key = YOUR_API_KEY_HERE', 'export OPENAI_API_KEY=sk-...', '"Token": "a1b2c3d4e5f6...64_hex_chars"',
    'Set `password: $DB_PASSWORD` in the compose file', 'password: string;', 'api_key: string', 'const token = parts[1]!;',
    'const refresh_token = await sign(payload);', "const KEYS = ['CAPTAIN_MEMO_HUB_TOKEN', 'CAPTAIN_MEMO_DEPLOY_TOKEN'];",
    "mysql -h db -u app -p'...' appdb", 'mysql -h [HOST] -u [USER] -p[PASS] appdb', 'mysql -u app -p<see config.php> appdb',
    'the password is SHA256-hashed before storage', 'password is Argon2id, cost 3',
    'CAPTAIN_MEMO_SKIP_EMBED=1 ANTHROPIC_API_KEY= timeout 6 bun src/worker/index.ts', 'kalin ALL=(ALL) NOPASSWD: /usr/bin/systemctl',
    'see docs/pa-dss-compliance-checklist-for-the-payment-gateway-2026.md', 'branch sk-learn-integration-with-pandas-dataframes-v2 merged',
    'xoxb-style-names-in-slack-docs', 'src/components/Dashboard/Widgets/RevenueChart2026Panel/index', 'AbstractSingletonProxyFactoryBean2Configuration',
    'git clone https://gitlab-ci-token:${CI_JOB_TOKEN}@gitlab.example/x.git', 'REDIS_URL=redis://:$REDIS_PASSWORD@cache:6379',
  ]) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
  expect(redactSecrets("const url = 'https://x.example/connect?token=abc123&code=xyz789';").text)
    .toBe("const url = 'https://x.example/connect?token=[REDACTED]&code=xyz789';");   // only the token, not the next parameter
});

test('review: markdown bold, a spaced "API key", quoted prose, token/secret prose, escaped JSON, Authorization schemes', () => {
  for (const s of [
    '**Password:** FAKEpw2026x', '**API Key**: fake0000fake0000fake0000fake0000', '**DB_PASSWORD**: FAKEpw2026x', 'API key: FAKEfake0000fake0000fake',
    'API Key = FAKEfake0000fake0000fake', 'username `fakeuser`, password `fakepw9999fakefake`', 'the password is "fakepw2026x"',
    'Re-minted: token `FAKEtok99FaKEfAkEFAKEfakE9`', 'Secret `fake999fakefake` is weak', 'the token is FAKEfake0000fake0000fake',
    'curl -H "X-Acme-Test: fake999fakefake" https://app.example/admin/', '{ extraHTTPHeaders: { "X-Acme-Test": "fake999fakefake" } }',
    'pw for the OLT: FAKEpw2026x', 'the password for admin is FAKEpw2026x', 'The password is: FAKEpw2026x', 'password was changed to FAKEpw2026x',
    'reset the root password to FAKEpw2026x', '{\\"password\\":\\"FAKEpw2026x\\"}', '{\\"apiKey\\":\\"FAKEpw2026x\\"}',
    'curl -H "Authorization: Token FAKEfake0000fake0000fake0000fake0000" https://netbox.example/api/', 'Authorization: ApiKey FAKEfake0000fake0000fake',
    'curl -H "Authorization: FAKEfake0000fake0000fake" https://x.example/',
  ]) {
    const r = redactSecrets(s);
    expect({ s, leaked: /FAKE|fake(?!user)/.test(r.text) }).toEqual({ s, leaked: false });
  }
});

test('review: split keys quoted, hard-broken, CRLF- or slash-escaped, glued to END; PuTTY, SSH2 and OpenVPN keys; glptt-', () => {
  const L = 'FAKEkeyAAAAbbbbCCCCdddd0000eeeeFFFFgggg1111hhhhIIIIjjjj2222kkkkLL';
  const S = 'FAKEkey/AAAbbbbCCCCdddd0000eeee/FFFgggg1111hhhhIIII/jjj2222kkkkLL';
  for (const s of [
    `> ${L}\n> ${L}\n> -----END RSA PRIVATE KEY-----`, `> ${L}`, `${L}  \n${L}  \n-----END EC PRIVATE KEY-----`, `${L}  \n${L}  \n${L}`,
    [L, L, L].join('\\r\\n'), [L, L, L, '-----END PRIVATE KEY-----\\r\\n", "client_email": "x@fake.example"}'].join('\\r\\n'),
    [S, S, S].join('\\n').replace(/\//g, '\\/'), [S, S, S, '-----END PRIVATE KEY-----\\n"}'].join('\\n').replace(/\//g, '\\/'),
    L + L + '-----END PRIVATE KEY-----',
    `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPublic-Lines: 1\nPUBLICpart\nPrivate-Lines: 2\n${L}\n${L}\nPrivate-MAC: 0fa4e0fa4e`,
    `---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nComment: "FAKE rsa-key"\n${[L, L].join('\n')}\n---- END SSH2 ENCRYPTED PRIVATE KEY ----\nafter`,
    '-----BEGIN OpenVPN Static key V1-----\n0000fa4eFAKE0000fa4e0000fa4e0000fa4e\n-----END OpenVPN Static key V1-----',
    'trigger with glptt-FAKEfake0000FAKEfake0000FAKEfake0000FAKE',
  ]) expect({ s, leaked: /FAKE/.test(redactSecrets(s).text) }).toEqual({ s, leaked: false });
  // PuTTY's MAC line and what follows the key stay.
  expect(redactSecrets(`Private-Lines: 1\n${L}\nPrivate-MAC: 0fa4e0fa4e`).text).toBe('[REDACTED:private-key]\nPrivate-MAC: 0fa4e0fa4e');
});


// Review round 2 (2026-09-29): 12 false-positive causes measured on the local corpus (141 of 1 069 replacements) and 15
// shapes that leaked.
test('review round 2: verdicts, code, constants, templates, concatenations, links and ratios stay', () => {
  const FP2 = [
    'echo ($ok ? "PASS" : "FAIL (got " . var_export($v, true) . ")") . "\\n";', 'echo "\\n" . ($fail === 0 ? "ALL PASS" : "{$fail} FAILURE(S)") . "\\n";',
    "echo ($x ? 'PASS' : 'FAIL (' . $m . ')');", 'PASS: id_product changed\nPASS: price set\nPASS: bill_lastdate zeroed', 'echo "PASS: dedupe_ok\\n";',
    '- [ ] **PASS = code-flow if this fails.**', '### Also fixed in the same pass: fixture-orderings tie-break',
    "$api_key = $cfg['general']['api_key'] ?? '';", "'authToken' => $msg['auth'],", "if (map['X_API_KEY']) cfg.embedderApiKey = map['X_API_KEY'];",
    "$token = (string)filter_input(INPUT_POST, 'reauth_token');", '$all_pass = !in_array(false, $asserts, true);',
    'token: TOKEN,', 'sessionSecret: SECRET, now: () => NOW,', 'occ talk:turn:add turn SERVER:3478 udp,tcp --secret=SECRET', 'sent post_token=EMPTY',
    'const token = getToken(1);', "const token = randomBytes(16).toString('hex');", 'const secret = deps.resolveCredential(opts.env?.WIN32_ACCOUNT_REF);',
    'ERP generates a Bearer token: `bin2hex(random_bytes(32))`',
    'The key file must start with -----BEGIN OPENSSH PRIVATE KEY----- on its own line.\n\nThen chmod 600 it, restart sshd and test with ssh -v host.\n\n## Next step\nRotate the runner token quarterly.',
    'curl -H "X-Acme-Test: {tenant_secret}" "https://{domain}/admin/"', '{if $t}data-reauth-token="{$reauth_token|escape}"{/if}', '"apiKey": "{env:OPENROUTER_API_KEY}"',
    'lines.push(`ANTHROPIC_API_KEY=${cfg.anthropicApiKey}`);', 'echo "API Key: " . substr($apiKey, 0, 10) . "...\\n";', "grep 'token:' | awk '{print $2}'",
    'async function login(id: string, secret: string): Promise<string> {', 'revoke(token: string): void {}', 'Access denied (using password: YES): check the grant',
    '- **Forgot Password:** https://portal.example/en/portal/reset', 'Now consumes the token: **4.52:1**.', 'Password: [your admin password]',
    "const KEYS = ['CAPTAIN_MEMO_EMBEDDER_API_KEY', 'CAPTAIN_MEMO_WATCH_SKILLS'];",
  ];
  for (const s of FP2) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
});

test('review round 2: backticked values, spaced compound keys, any Authorization scheme, more prose, CRLF edges, more armour', () => {
  const L = 'FAKEkeyAAAAbbbbCCCCdddd0000eeeeFFFFgggg1111hhhhIIIIjjjj2222kkkkLL';
  const MISS2 = [
    '**Password:** `FAKEpw2026x`', 'client_secret: `FAKEpw2026x`', '- **API key:** `FAKEfake0000fake0000fake`', 'DB_PASSWORD: `FAKEpw2026x`', 'api_key: `FAKEpw2026x`',
    'x-api-key: `FAKEpw2026x`', 'access_key: `FAKEfake0000fake`', 'password=`FAKEpw2026x`',
    'Access key ID: AKIAFAKEFAKEFAKEFAKE\nSecret access key: FAKEfake0000FAKEfake0000FAKEfake0000FAKE', 'Secret key: FAKEfake0000FAKEfake0000FAKE',
    'Private key: FAKEfake0000FAKEfake0000FAKE', 'Access key: FAKEfake0000FAKEfake0000FAKE', 'Encryption key: FAKEfake0000FAKEfake0000FAKE',
    'Authorization: SSWS 00FAKEfake0000FAKEfake0000FAKEfake0000FAKE', 'Authorization: Bot FAKEfake0000FAKEfake.Fake00.FAKEfake0000FAKEfake00',
    'Authorization: OAuth FAKEfake0000fake0000fake', 'Authorization: Key FAKEfake0000fake0000fake',
    '\\r\\n' + [L, L, L].join('\\r\\n'), [L, L, L].join('\\r\\n') + '\\r', [L, L, L].join('\\r\\n') + '\\r\\',
    'password for root on db1.example is FAKEpw2026x', 'password for backup user on nas2026.lan: FAKEpw2026x', 'the token for the runner on ci01.example is FAKEfake0000FAKEfake0000',
    'the root password has been changed to FAKEpw2026x', 'password got changed to FAKEpw2026x', 'the password is now FAKEpw2026x', 'password updated to FAKEpw2026x',
    'password was set as FAKEpw2026x', 'password is still FAKEpw2026x', 'password will be FAKEpw2026x',
    'the password is **fakepw2026x**', '**password** FAKEpw2026x', '*Password:* FAKEpw2026x', '__Password:__ FAKEpw2026x', '**PW:** FAKEpw2026x', '**Password** → FAKEpw2026x',
    'The API key is FAKEfake0000FAKEfake0000FAKEfake0000FAKE', 'API key FAKEfake0000FAKEfake0000FAKEfake0000FAKE', 'API key `FAKEfake0000FAKEfake0000FAKEfake0000FAKE`',
    'api key "FAKEfake0000FAKEfake0000FAKEfake0000FAKE"',
    '-----BEGIN OpenVPN tls-crypt-v2 client key-----\nFAKEfake0000FAKEfake0000FAKEfake0000FAKEfake\n-----END OpenVPN tls-crypt-v2 client key-----',
    `> Private-Lines: 2\n> ${L}\n> ${L}\n> Private-MAC: 0fa4e0fa4e`, `Private-Lines: 2\n${L}  \n${L}  \nPrivate-MAC: 0fa4e0fa4e`, `    Private-Lines: 2\n    ${L}\n    ${L}`,
    'glimt-FAKEfake0000FAKEfake00', 'glffct-FAKEfake0000FAKEfake00', 'glwt-FAKEfake0000FAKEfake00', 'glrtr-FAKEfake0000FAKEfake00',
    'X-Acme-Test header: FAKEfake0000fake0000fake', 'the X-Acme-Test value is FAKEfake0000fake0000fake', 'X-Acme-Test FAKEfake0000fake0000fake',
    'header X-Acme-Test set to FAKEfake0000fake0000fake',
  ];
  for (const s of MISS2) expect({ s, leaked: /FAKE|fake/.test(redactSecrets(s).text) }).toEqual({ s, leaked: false });
  expect(redactSecrets('{"url":"https:\\/\\/admin:FAKEpw2026@erp.example\\/api"}').text).toBe('{"url":"https:\\/\\/admin:[REDACTED]@erp.example\\/api"}');
});

// Review round 3 (2026-09-29): the last false positives on the local corpus (27 of 974 replacements) and a JSC cliff.
test('review round 3: prose between code spans, where a secret lives, CI lookups, algorithm names, labels, references stay', () => {
  const FP3 = [
    'Routes: `GET /portal/verify?token=` (single use), `POST /portal/forgot` sends the reset link.',
    'Set `DB_PASSWORD=` in the env file, then run `bun run migrate` once.',
    'The URL ends in "?token=" and the header is "X-Auth".',
    '- **JWT secret:** `/root/.jwt-secret` on the host (mode 0600)', 'Secret: `op://Engineering/GitLab/token`', 'token: `https://auth.example.com/oauth/token`',
    '- **Token:** `POST /api/auth/token` as the ERP user (Basic)', '"privateKey": "/home/deploy/.ssh/id_ed25519"', 'API key: `~/.config/voyage/key`',
    'Check the first line of the key file:\n```\n-----BEGIN OPENSSH PRIVATE KEY-----\n```\nIf it says RSA instead, convert it with ssh-keygen -p -m PEM -f key.\n\n## Next step\nRestart sshd and test with ssh -v host.',
    'API_KEY: "${{ secrets.API_KEY }}"', 'token: ${{secrets.GITHUB_TOKEN}}', 'docker run -e JWT_SECRET="$(cat /root/.jwt-secret)" app',
    '-e JWT_SECRET="$(cat /root/.app-jwt-secret)" \\',
    'the token is HS256-signed', 'the password is UTF8-encoded', 'Signing key: RS256', 'Encryption key: AES-256', 'secret: Base64-encoded',
    'Authorization: spatie/laravel-permission', 'Authorization: via middleware/RequireApiToken', 'HTTP Basic authentication/authorization is handled by nginx',
    'NOT part of that pass: `billing_period`, `invoice_notes`.', 'PASS = `verifyOwner`+`checkScope` succeed',
    'UPDATE users u1 JOIN legacy u2 ON u2.id = u1.id SET u1.password = u2.password;', 'const token = cfg?.token;', 'password: req.body?.password,',
    "grep -oP 'auth_token:\\s*\\K\\S+' config.yml", 'the `password=` flag and the `--user` flag', 'set `api_key:` then `export FOO=1` in the shell',
    "const runPass = async (state: 'active') => {", 'const refreshToken = async (req) => {', 'const cacheBypass = forceRefresh;', 'const authBypass = isLocal && devMode;',
    'run `mysql -u root -p` and type it at the prompt', '(mysql -u root -p) and', 'mysql -u root -pSECRET appdb', 'curl -u user:PASSWORD https://x.example', 'sshpass -p PASSWORD ssh root@h',
    '**PRIVATE key:** browser-held ONLY', 'token: read-only', 'secret: auto-generated', 'token: single-use, 10 seats', 'private_key: -----BEGIN …', 'secret: ------',
  ];
  for (const s of FP3) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
  // A real head chunk still goes: key lines, an encrypted PEM's headers, a PGP key after its blank line, a chunk ending at BEGIN.
  const L = 'FAKEkeyAAAAbbbbCCCCdddd0000eeeeFFFFgggg1111hhhhIIIIjjjj2222kkkkLL';
  for (const s of [`Deploy key:\n-----BEGIN RSA PRIVATE KEY-----\n${L}\n${L}`, `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${L}\n=FaKe\n-----END PGP PRIVATE KEY BLOCK-----`,
    `x\n-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,FAKE\n\n${L}`, 'The runner key:\n-----BEGIN RSA PRIVATE KEY-----\n']) {
    expect({ s, leaked: /FAKEkey|BEGIN/.test(redactSecrets(s).text) }).toEqual({ s, leaked: false });
  }
});

// #192 (2026-09-29): command-line flags, config and XML shapes, db connect calls, markdown password columns, more keywords,
// env values with ';' ',' or spaces, Telegram tokens, Bulgarian prose, keys joined by spaces, hex key bodies, quoted PGP keys.
test('#192: the shapes the first review deferred are redacted, and their look-alikes are not', () => {
  const L = 'FAKEkeyAAAAbbbbCCCCdddd0000eeeeFFFFgggg1111hhhhIIIIjjjj2222kkkkLL';
  const MISS192 = [
    'redis-cli -h cache -p 6379 -a FAKEpw2026x ping', 'redis-cli --pass FAKEpw2026x ping', '127.0.0.1:6379> AUTH FAKEpw2026x', 'AUTH FAKEpw2026x',
    'requirepass FAKEpw2026x', 'masterauth FAKEpw2026x', '    command: redis-server --requirepass FAKEpw2026x', 'mongo -u admin -p FAKEpw2026x --authenticationDatabase admin',
    'mongosh "mongodb://h" --username admin --password FAKEpw2026x', 'snmpwalk -v2c -c FAKEcomm2026 10.0.0.1', 'snmp-server community FAKEcomm2026 RO',
    'ipmitool -I lanplus -H 10.0.0.5 -U ADMIN -P FAKEpw2026x chassis status', 'smbclient //nas/share -U admin%FAKEpw2026x', 'docker login -u fakeuser -p FAKEpw2026x registry.example',
    "echo 'root:FAKEpw2026x' | chpasswd", 'echo "kalin:FAKEpw2026x" | sudo chpasswd', 'setx DB_PASSWORD FAKEpw2026x',
    '<password>FAKEpw2026x</password>', '<db:password>FAKEpw2026x</db:password>', '<apiKey>FAKEfake0000FAKE</apiKey>',
    "$db = mysqli_connect('localhost', 'root', 'FAKEpw2026x', 'erp');", "$c = new mysqli('db', 'app', 'FAKEpw2026x', 'erp');", "mysqli_real_connect($link, 'db', 'app', 'FAKEpw2026x');",
    "$pdo = new PDO('mysql:host=db;dbname=erp', 'app', 'FAKEpw2026x');",
    '| host | user | password |\n|------|------|----------|\n| olt1 | admin | FAKEpw2026x |', '| password | FAKEpw2026x |', '| **Password** | FAKEpw2026x |',
    'REDIS_AUTH=FAKEpw2026x', 'SMTP_CREDENTIALS=FAKEpw2026x', 'PASSCODE=FAKEpw2026x', "define('AUTH_KEY', 'FAKEpw2026xFAKEsalt');", 'MASTER_KEY=FAKEpw2026x',
    'network={\n  ssid="home"\n  psk="FAKEpw2026x"\n}', 'DB_PASSWORD=FAKE;pw2026x', 'DB_PASSWORD=FAKE,pw2026x', 'Environment="DB_PASSWORD=FAKE pw2026x"',
    'bot 123456789:AAFAKEfake0000FAKEfake0000FAKEfake00', 'парола: FAKEpw2026x', 'паролата за OLT-а е FAKEpw2026x', 'Парола за root: FAKEpw2026x', 'паролата е сменена на FAKEpw2026x',
    `JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY----- ${L} ${L} ${L} -----END PRIVATE KEY-----"`, `${L} ${L} ${L}`, `${L} ${L} -----END PRIVATE KEY-----"`,
    '> -----BEGIN PGP PRIVATE KEY BLOCK-----\n>\n' + Array(152).fill('> ' + L).join('\n') + '\n> -----END PGP PRIVATE KEY BLOCK-----\nafter',
  ];
  for (const s of MISS192) expect({ s, leaked: /FAKE|fa4e|FaKe/.test(redactSecrets(s).text) }).toEqual({ s, leaked: false });
  const FP192 = [
    'OAuth: supported', 'auth: required', 'Auth: via the gateway', 'snmpwalk -v2c -c public 10.0.0.1', 'mongo -p --authenticationDatabase admin',
    '| Field | Type | Required |\n|---|---|---|\n| password | string | yes |', '| password | required |', '| token | The API token used for auth |', '| Name | Value |\n|---|---|\n| a | b |',
    'AUTH required', 'the AUTH command takes a password', '<password></password>', '<password>${DB_PASS}</password>', "mysqli_connect($host, $user, $pass, $db);",
    'docker login registry.example', 'credentials: stored in 1Password', 'Credentials: see the vault', 'requirepass yes', 'The bot 123 posted a message',
    'парола: задължителна', 'паролата е в сейфа', 'DB_HOST=db,replica', 'API_KEY=${API_KEY}', 'Environment="PATH=/usr/bin:/bin"',
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 d41d8cd98f00b204e9800998ecf8427ed41d8cd98f00b204e9800998ecf8427e',
    // A chunk of UUIDs or MD5s is not an OpenVPN static key body (that rule was dropped for exactly this).
    ['550e8400e29b41d4a716446655440000', 'd41d8cd98f00b204e9800998ecf8427e', '098f6bcd4621d373cade4e832627b4f6', '5d41402abc4b2a76b9719d911017c592'].join('\n'),
  ];
  for (const s of FP192) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
  // Only the secret goes: the table, the call, the user and a trailing comment stay.
  expect(redactSecrets('| host | user | password |\n|------|------|----------|\n| olt1 | admin | FAKEpw2026x |').text)
    .toBe('| host | user | password |\n|------|------|----------|\n| olt1 | admin | [REDACTED] |');
  expect(redactSecrets("$db = mysqli_connect('localhost', 'root', 'FAKEpw2026x', 'erp');").text).toBe("$db = mysqli_connect('localhost', 'root', '[REDACTED]', 'erp');");
  expect(redactSecrets('smbclient //nas/share -U admin%FAKEpw2026x').text).toBe('smbclient //nas/share -U admin%[REDACTED]');
  expect(redactSecrets('DB_PASSWORD=FAKE;pw2026x # note').text).toBe('DB_PASSWORD=[REDACTED] # note');
});

test('#192 review: the shapes it found leaking are redacted, and the look-alikes it found redacted stay', () => {
  const MISS2 = [
    "$db = mysqli_connect($host, 'root', 'FAKEpw2026x', 'erp');", "$c = new mysqli($host, 'app', 'FAKEpw2026x', 'erp');", "$db = mysqli_connect(DB_HOST, 'root', 'FAKEpw2026x');",
    "$pdo = new PDO($dsn, $user, 'FAKEpw2026x');", 'AUTH default FAKEpw2026x', '127.0.0.1:6379> AUTH alice FAKEpw2026x',
    'curl https://api.telegram.org/bot123456789:AAFAKEfake0000FAKEfake0000FAKEfake00/sendMessage', '{"cmd":"redis-cli -a \\"FAKEpw2026x\\" ping"}',
    '{"cmd":"docker login -u u -p \\"FAKEpw2026x\\" reg"}', '<Password xsi:type="xsd:string">FAKEpw2026x</Password>', '<Pass encoding="base64">RkFLRXB3MjAyNng=</Pass>',
    '<password><![CDATA[FAKEpw2026x]]></password>', '<password>\n  FAKEpw2026x\n</password>', 'Pre-shared key: FAKEpw2026x', 'Pre Shared Key: FAKEpw2026x',
    'Парола:FAKEpw2026x', 'парола=FAKEpw2026x', '**Парола**: FAKEpw2026x', 'парола: fakepw2026x', 'паролата на root е FAKEpw2026x', 'паролата ми е FAKEpw2026x',
    'паролата е променена на FAKEpw2026x', '| Device | Admin password |\n|---|---|\n| olt1 | FAKEpw2026x |', '| Host | User | Root Password |\n|---|---|---|\n| olt1 | root | FAKEpw2026x |',
    'host | user | password\n--- | --- | ---\nolt1 | admin | FAKEpw2026x', '| Setting | Value | Notes |\n|---|---|---|\n| password | FAKEpw2026x | rotate |',
    'environment:\n  - DB_PASSWORD=Qz7FAKE;pw2026x', 'ENV DB_PASSWORD=Qz7FAKE;pw2026x', 'docker run -e DB_PASSWORD=Qz7FAKE;pw2026x app',
    'Environment="DB_USER=app" "DB_PASSWORD=Qz7FAKE pw2026x"', 'Environment=DB_PASSWORD=Qz7FAKE;pw2026x', '%any %any : PSK "FAKEpw2026x"',
  ];
  for (const s of MISS2) expect({ s, leaked: /FAKE|fake(?!user)/.test(redactSecrets(s).text) }).toEqual({ s, leaked: false });
  const FP2 = [
    "mysqli_connect($host, 'app', $pass, 'erp');", 'Смених паролата на Mikrotik1 акаунта.', 'Нулирах паролата на Router2 машината', 'паролата на db1 е в .pgpass',
    '| Token | Description | Example |\n|---|---|---|\n| `{YYYY}` | year | 2026 |\n| `--ink` | ink colour | #000 |', '| Pass | Count |\n|---|---|\n| run | 1875 |',
    '| Pin | Function |\n|---|---|\n| GPIO17 | LED |', '| Name | Secret |\n|---|---|\n| hub | GITLAB_TOKEN |', '| Field | Type |\n|---|---|\n| password | `string` |',
    '| Setting | Value |\n|---|---|\n| password | (none) |', "fetch('/api', { method: 'POST', credentials: 'include' })", '"credentials": "same-origin"', 'Old DB credentials: host=db1 user=kkb',
    'psk: 8-63 characters', 'Look for -----BEGIN PRIVATE KEY----- /etc/ssl/private/server.key and chmod it', '// Pre-auth: only a valid hello', 'Post-auth: all frames are sealed',
    're-auth: 24 hours', 'smtp_auth: login', 'BASIC_AUTH=true', 'AUTH now uses setDescription', 'AUTH is required when requirepass is set', 'requirepass redis.conf',
    '> AUTH needed first', 'AUTH WRONGPASS', 'redis-cli -a prints a warning', 'docker login -p insecure', 'head -c 100 file', 'setx MAX_TOKENS 4000',
    'T_PASS=0; T_FAIL=0', 'ALLOWED_AUTH=basic,token', 'SSH_AUTH_SOCK=/tmp/ssh-x', 'XAUTHORITY=/home/k/.Xauthority', 'MAX_TOKENS=4000', 'PGPASSFILE=/home/k/.pgpass',
    'CAPTAIN_MEMO_TOKEN_FILE=/etc/x', '<password>string</password>', '<password>?</password>', '<savePassword>true</savePassword>', '<nextPageToken>abc123XYZ</nextPageToken>',
    '<max_token>4096</max_token>', '<password>%DB_PASS%</password>', '<password>#{db.pass}</password>', '<password>@DB_PASS@</password>', "// mysqli_connect('host', 'user', 'PASSWORD', 'db');",
    "echo 'user:PASSWORD' | chpasswd", 'CA_CERT="-----BEGIN CERTIFICATE----- MIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJRTESMBAGA1UEChMJQmFsdGltb3JlMRMwEQYDVQQLEwpDeWJlclRydXN0MSIwIAYD MIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBaMQswCQYDVQQGEwJJRTESMBAGA1UEChMJQmFsdGltb3JlMRMwEQYDVQQLEwpDeWJlclRydXN0MSIwIAYD -----END CERTIFICATE-----"',
  ];
  for (const s of FP2) expect(redactSecrets(s)).toEqual({ text: s, count: 0 });
});
