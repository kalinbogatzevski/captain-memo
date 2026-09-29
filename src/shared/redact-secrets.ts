// src/shared/redact-secrets.ts — credential-shaped values out, everything else untouched.
//
// Auto-recall injected a full GitLab API token (from a memory file) into an unrelated Windows session by fuzzy
// match (2026-09-17). The envelope is read by the model AND lands in transcripts, observations and hub relays;
// a secret in it is a secret everywhere. So everything that shows a snippet redacts, and `get_full` (an explicit ask
// for that document) does not. Shape-based, deliberately conservative:
// a hash, a commit, a session id, the WORD "password" stay; a token prefix a vendor issues, a key=value with a
// secret-looking key, a userinfo password in a URL, a bearer / JWT, a PEM private key go.
// ponytail: one regex table. Entropy scoring if a real leak ever gets past it.
// Kept byte-identical in both captain-memo release lines: change both or neither.
// Linear time: a token rule whose run may contain '-' starts only where a run starts ((?<![A-Za-z0-9_-]), not \b),
// or 'sk-'/'eyJ-'/'glpat-' repeated 25 000 times made every repeat a start that rescanned the rest of the run. Every
// rule below is held to that by the 'adversarial runs stay linear' tests.

type Rule = {
  kind: string; re: RegExp; skip?: (m: RegExpExecArray) => boolean;
  /** The secret inside the match: only it becomes [REDACTED] (the key, the user, the command stay). Absent: the whole
   *  match becomes [REDACTED:kind]. */
  value?: (m: RegExpExecArray) => string | undefined;
  /** What the text must contain: without it the rule is not run at all. A literal-led test is a fast scan, where a rule
   *  that opens with a lookbehind is tried at every position. Over 87 704 real chunks (24.6 MB, 2026-09-29) they took the
   *  redactor from 31.1 to 20.7 µs per chunk, byte-identical output, and one recall of 150 candidates of 1-2 KB from 14.7
   *  to 10.3 ms (0.65.2: 16.3 µs, 7.3 ms, with 287 chunks redacted where this catches 761). */
  needs?: RegExp;
  /** Also read json_encode's escaped slash '\/' as '/' (see slashRuns). */
  slashes?: true;
};

const KV_KEYWORD = 'secret[_ -]access[_ -]key|secret[_ -]?key|signing[_ -]?key|encryption[_ -]?key|app[_ -]?key|'
  + 'pass(?:word|wd|phrase)?|pwd|secret|api[_ -]?key|access[_ -]?key|private[_ -]?key|auth[_ -]?token|token|'
  + 'x-[a-z0-9]+(?:-[a-z0-9]+){0,3}-test';   // a custom X-<name>-Test header whose value is a shared secret

/** A value that is a word, a flag, a score or a rule list, not a secret: secret: true, (using password: YES),
 *  All tests pass: 1875/1875, 'password' => 'required|min:8', "PASS" : "FAIL", password: string, token = await sign(…). */
const NOT_A_SECRET = /^(?:true|false|null|none|nil|undefined|yes|no|required|optional|pass(?:ed)?|fail(?:ed)?|warn(?:ing)?|ok|error|skip(?:ped)?|string|number|boolean|bigint|unknown|any|bytes|str|int|buffer|uint8array|await|async|new|this|self|typeof|\d+\/\d+|[a-z_]+(?::[^|]*)?(?:\|[a-z_]+(?::[^|]*)?)+)$/i;
/** A placeholder for a secret, not one: $DB_PASSWORD, ${DB_PASSWORD}, <your-password>, {{ .Token }}, %(password)s.
 *  Anchored whole: a bcrypt hash ($2y$10$…) is not a placeholder. */
const PLACEHOLDER = /^(?:\$\{?\w+\}?|<[^<>]+>|\{\{.*\}\}|%\(\w+\)s)$/;
/** A stand-in written in docs, not a secret: sk-..., a1b2…, ak_xxxxx, YOUR_API_KEY_HERE, changeme, [PASS], <see config.php>. */
const DUMMY = /\.\.\.|…|x{4,}|your[_ -]?(?:api|key|token|pass|secret)|_here$|changeme|^\[[^\]]*\]$|^</i;

/** kv: is this match prose rather than a credential? `m[1]` the key, `m[2]` its keyword, `m[3]` the separator,
 *  `m[4..8]` the value (escaped-quoted, double-quoted, single-quoted, backticked, bare). */
function kvIsProse(m: RegExpExecArray): boolean {
  const key = m[1]!, keyword = m[2]!;
  const value = (m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8])!;
  const bare = m[8] !== undefined;
  if (value.startsWith('[REDACTED')) return true;   // a rule above already took it (private_key: -----BEGIN …)
  // No word, flag, reference or constant the checks below know is this long, and past ~64K groups their backtracking
  // falls off JSC's fast path ('token=a' + '|a'×65 536: 22 → 323 ms; local bodies are uncapped).
  if (value.length > 1024) return false;
  // A quoted or backticked "value" with space at an edge is the prose between two code spans or strings, opened by the
  // quote that closed the key's own span: `DB_PASSWORD=` in the env file, then `bun run migrate`.
  if (!bare && /^\s|\s$/.test(value)) return true;
  // Where a secret lives, not the secret: a file path, a URL or op:// reference, a token endpoint, a CI/shell lookup.
  if (/^(?:~?\/|\.\.?\/)|^[a-z][a-z0-9+.-]*:\/\/|^(?:GET|POST|PUT|PATCH|DELETE) \/|^\$\{\{|^\$\(/i.test(value)) return true;
  if (HASH_NAME.test(value) || /^-+$|^-----/.test(value)) return true;   // Signing key: RS256; a dash rule or a cut armour line
  // (using password: YES): the ')' closes the prose; so do 'string):' and a bold '**'. Trimmed by hand: /[)\]}.]+$/
  // restarts at every char of a run it then fails on ('token=' + 25 000 '.' + 'x': 1.2 s).
  let start = 0, end = value.length;
  while (bare && start < end && '*_'.includes(value[start]!)) start++;
  while (bare && end > start && ')]}.:*'.includes(value[end - 1]!)) end--;
  const word = value.slice(start, end);
  if (NOT_A_SECRET.test(word) || PLACEHOLDER.test(word) || DUMMY.test(value)) return true;
  // It starts with a variable: gitlab-ci-token:${CI_JOB_TOKEN}@gitlab…, $DB_PASS. Upper case only: $2y$10$… (bcrypt) and
  // $ecretPass1 are values.
  if (/^\$(?:\{\w+\}|[A-Z_][A-Z0-9_]*)(?![\w$])/.test(value)) return true;
  // A template, not a value: ${cfg.apiKey}, {tenant_secret}, Smarty {$token|escape}, opencode {env:API_KEY}.
  if (/^\$?\{[^{}\s]{1,80}\}/.test(value)) return true;
  // Code, not a value: a quoted "value" that is the code between two string literals (" . substr($k, 0, 10) . "),
  // an index or call left open by the value's end (map[, $cfg[, filter_input(), a cast or negation ((string)x(, !f().
  if (!bare && /^\s*[.+|&]\s/.test(value)) return true;
  if (bare && (/^\(|^!\w+\(|[[(]$/.test(value))) return true;
  // A constant or a status (token: TOKEN, --secret=SECRET, post_token=EMPTY), a link, a ratio, a '[…' stand-in, a path.
  if (bare && (/^[A-Z]{2,20}$/.test(word) || /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(word) || /^\[/.test(value)
    || /^\\[sSKwd]/.test(value))) return true;   // …, a PCRE fragment (grep -oP 'auth_token:\s*\K\S+')
  // A column or property reference ending in a secret's name: u2.password, cfg?.token, req.body?.password.
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\??\.(?:pass(?:word|wd)?|pwd|token|secret|api_?key)$/i.test(value)) return true;
  // After a comma, an env-style NAME is the next item of a list of names: ['…_API_KEY', 'CAPTAIN_MEMO_WATCH_SKILLS'].
  if (m[3] === ',' && /^[A-Z][A-Z0-9_]+$/.test(value)) return true;
  // ANTHROPIC_API_KEY= timeout 6 bun …: an empty assignment, the next word is not its value.
  if (bare && /^=[ \t]/.test(m[0].slice(key.length))) return true;
  // sudoers NOPASSWD: /usr/bin/…, sshd_config without-password: directives, not secrets.
  if (/^(?:NOPASSWD|without-password|prohibit-password)$/i.test(key)) return true;
  // A NAME, not its value: 'CAPTAIN_MEMO_DEPLOY_TOKEN', $this->dbPass = ERP_DB_PASS; an index expression: parts[1]!.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|KEY|PASS|PASSWORD|PWD|SECRET)$/.test(value)) return true;
  if (bare && /^[\w$.]+\[[^\]]*\]/.test(value)) return true;
  // A reference, not a value: apiKey: config.apiKey, api_key: process.env.X, token: getToken(), Hash::make($data[…
  // A dotted run with a digit is a token (ya29.…), not a reference. ponytail: a bare password written like a call
  // (Passw0rd(1)) passes too; quoted, it does not.
  const code = bare || m[7] !== undefined;   // bare, or in a markdown code span
  if (code && (/^[A-Za-z_$]+(?:\.[A-Za-z_$]+)+$/.test(value) || /^[\w$.:\\>-]+\(/.test(value))) return true;
  if (/^(?:OLD)?PWD$/i.test(key) && value.startsWith('/')) return true;   // PWD=/home/…: the shell's cwd
  // DB_PASSWORD, PGPASSWORD, MYSQL_PWD, ENCRYPTION_KEY: config, never prose. A bare PASS / TOKEN is not a name: 'PASS: price set'.
  const envName = key === key.toUpperCase() && (key.length > keyword.length || /[_-]/.test(key));
  // A test verdict, not a password: PASS: id_product changed, "PASS" : "FAIL (got …)", same pass: fixture-orderings.
  if (key.toLowerCase() === 'pass' && (/^(?:fail|error|skip|warn)/i.test(value) || (code && /^[a-z][A-Za-z_-]*(?:\\n)?$/.test(word)))) return true;
  // define('DB_PASSWORD', '…') is config; ->only('email', 'password') and ['password', 'remember_token'] are not.
  if (m[3] === ',' && !envName) return true;
  const prefix = key.slice(0, key.length - keyword.length);
  const plain = bare && /^(?:[A-Za-z][a-z]*(?:-[a-z]+)*|\d{1,6})$/.test(word);   // a word (read-only too) or a short number (max token: 4000)
  // The keyword inside a word: bypass: v2cache, compass=north. dbPassword / clientSecret (a camelCase hump) is a key,
  // and so is dbpass=Xk82pqzLm: inside a word only a plain value, or an English word as the key, is prose.
  if (prefix && !/[_.-]$/.test(prefix) && !envName && !/^[A-Z]/.test(keyword)
    && (plain || /(?:by|com|encom|sur|over|under|tres)pass$/i.test(key))) return true;   // cacheBypass, authBypass
  // A bare keyword (no prefix, not an env name) with a plain word or short number is prose: 'pass: install', 'max token:
  // 4000', 'the secret: patience', 'passwd: files systemd', 'API key: rotate'. Quoted, or qualified (db_pass,
  // x-auth-token), or 'pass: 12345678', it is not; nor is 'password: <word>' (a weak password is still one).
  return !prefix && !envName && !/^(?:password|passphrase|pwd)$|^x-/i.test(keyword) && plain;
}

/** The base64-block candidate is a key body only with a capital, a small letter and a digit, and whole lines of 40+
 *  chars where the chunker left whole lines (the first and last may be cut short, one at least is whole). Hex hashes
 *  (one case), commit lists (short), prose and paths (spaces, '.', '-', '_', which the shape refuses) never pass.
 *  ponytail: a PEM's short last line alone in a chunk stays — a few bytes of a key whose every other line is gone. */
function notKeyBody(m: RegExpExecArray): boolean {
  const body = m[1]!;
  if (!/[A-Z]/.test(body) || !/[a-z]/.test(body) || !/\d/.test(body)) return true;
  const lines = body.split(/\r?\n|\\r\\n|\\n/).map((s) => s.trim().replace(/^>\s*/, ''));
  // Alone, a line must be key-line long (PEM 64, OpenSSH 70) and not a path: 'src/components/…/RevenueChart2026Panel/index'
  // and 'AbstractSingletonProxyFactoryBean2Configuration' are not keys. ponytail: a 60+ char identifier with a digit is.
  if (lines.length === 1 && (lines[0]!.length < 60 || (lines[0]!.match(/\//g)?.length ?? 0) > 4)) return true;
  return !lines.slice(1, -1).every((s) => s.length >= 40) || !lines.some((s) => s.length >= 40);
}

// A secret-looking prose value: 8+ chars with a digit, no '/' and no leading '.' or '~' (a path), not ending in
// punctuation, and (notMixedCase: the prose rule is /i for its keyword) a capital and a small letter.
// 'password argon2id', 'passphrase id_ed25519.pub' stay; so does an all-lowercase password written as prose
// (password=… still goes, by kv). At most 200 chars, so the scan stops there.
const PROSE_VALUE = String.raw`(?:[\x60'"]|\*{1,2}|__)?(?=[^\s'"\x60]{8,200}(?![^\s'"\x60]))(?=[^\s'"\x60]*\d)(?![^\s'"\x60]*\/)([^\s'"\x60.~*][^\s'"\x60]*[^\s'"\x60.,;:!?)\]*])`;
const notMixedCase = (m: RegExpExecArray) => !/[A-Z]/.test(m[1]!) || !/[a-z]/.test(m[1]!);
/** A kebab slug, not a key: 'sk-learn-integration-with-pandas', 'pa-dss-compliance-checklist', 'xoxb-style-names'. Vendor keys
 *  carry a capital or a long random run. */
const isSlug = (m: RegExpExecArray) => !/[A-Z]/.test(m[0]) && m[0].split('-').every((s) => s.length <= 15);
/** The prose value was quoted, backticked or bolded: a deliberate value, whatever its letter case. */
const quotedValue = (m: RegExpExecArray) => /[\x60'"*]/.test(m[0][m[0].lastIndexOf(m[1]!) - 1] ?? '');
/** A hash, KDF, signing or encoding name: SHA256-hashed, Argon2id, Base64-encoded, HS256-signed, AES-256, Ed25519. */
const HASH_NAME = /^(?:sha\d*|md5|argon2(?:id|i|d)?|bcrypt|scrypt|pbkdf2|base64|hex|aes\d*|rsa|hmac|[hrep]s\d{3}|ed25519|utf-?8|wpa\d?)(?:-|$)/i;
const B64_LINE = '[A-Za-z0-9+/]+=*';   // '=' is padding, only at a line's end: key=value is not base64
/** Private-key armour: PEM, PKCS8, OpenSSH, EC, PGP ('… PRIVATE KEY BLOCK'), SSH2 ('SSH2 ENCRYPTED …'), OpenVPN's keys. */
const ARMOR = String.raw`(?:[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?|OpenVPN [\w -]{0,40}?key(?: V\d)?)`;
const NL = String.raw`(?:\r?\n|\\r\\n|\\n)`;   // a real newline, or a JSON-escaped one (\n, \r\n)
/** What follows a BEGIN line of a real key: a key line (16+ base64 chars) or a header (Proc-Type:, Comment:, Version:) on the
 *  next line, after at most one blank line (PGP), or the end of the text (the chunk holds only the head), or the body glued
 *  to it. Not prose: '-----BEGIN … KEY----- on its own line', nor a header alone in a code fence followed by the note. */
const BEGIN_END = String.raw`(?=[ \t]*(?:${NL}[ \t]*(?:>[ \t]*)?(?:${NL}[ \t]*(?:>[ \t]*)?)?(?:[A-Za-z0-9+/]{16}|[A-Z][A-Za-z-]+: )|(?:${NL}[ \t]*)?$)|[A-Za-z0-9+/])`;
/** A key line's frame: trailing spaces (a markdown hard break) before the newline, indent and a '> ' quote after it. */
const LINE_TAIL = String.raw`[ \t]*${NL}[ \t]*(?:>[ \t]*)?`;

const RULES: Rule[] = [
  // Paired, or a lone BEGIN through the end of the text: a key the chunker split keeps its head in one chunk. PGP's
  // armour ends in 'PRIVATE KEY BLOCK-----'. A PEM key body is a few KB (RSA-8192 ~6.4 KB), so the scan stops at
  // 10 000 chars: unbounded, 2 000 BEGINs with no END took 160 ms, each one scanning to the end of the text.
  // ponytail: a lone BEGIN more than 10 000 chars before the end of a longer text stays; chunks are far shorter.
  // SSH2's armour is '---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----'; OpenVPN's static key is mixed case.
  // One rule per armour, each END a single literal: the lazy scan finds a literal fast, and one char at a time a quantifier
  // (-{4,5}: 2 000 BEGINs 47 ms → 421 ms) or even two literals (205 ms).
  { kind: 'private-key', needs: /-----BEGIN /, re: new RegExp(String.raw`-----BEGIN ${ARMOR}-----${BEGIN_END}[\s\S]{0,10000}?(?:-----END ${ARMOR}-----|$)`, 'g') },
  { kind: 'private-key', needs: /---- BEGIN /, re: new RegExp(String.raw`---- BEGIN ${ARMOR} ----${BEGIN_END}[\s\S]{0,10000}?(?:---- END ${ARMOR} ----|$)`, 'g') },
  // ...and its tail in another: base64 lines (real or JSON-escaped \n, optionally indented) ending in the END line.
  // It starts only where a block of such lines starts (a chunk may start with the n of a cut \n), never on a line
  // inside one, so a long base64 blob with no END is one linear scan: 3 000 lines took 2.6 s with every line a start
  // (165 ms capped at 100 lines), now ~10 ms, as fast as 200 KB of prose. The class lookahead keeps the lookbehind off
  // whitespace runs (a 50 000-space run: 5 s without it). At most 1 000 lines (a 16 384-bit key is ~200): unbounded,
  // 'A\n'×100 000 took 434 ms in the backtrack, bounded 2 ms. Its scan is the costliest rule on prose, so it runs only
  // on text with an END line: 150 recall candidates of 1.5 KB, 5.0 ms → 0.
  // Its lines may be quoted ('> '), end in a markdown hard break ('  '), escape their CRLF ('\r\n') or their slashes
  // ('\/', slashRuns), and the last one may run straight into the END line.
  { kind: 'private-key', needs: /-----END |---- END /, slashes: true, re: new RegExp(String.raw`(?=[A-Za-z0-9+/=])(?<![A-Za-z0-9+/=]\\?)(?<![A-Za-z0-9+/=]${LINE_TAIL})(?:[A-Za-z0-9+/=]+${LINE_TAIL}){0,1000}[A-Za-z0-9+/=]*(?:-----|---- )END ${ARMOR} ?-{4,5}`, 'g') },
  // A PuTTY .ppk: its private half follows 'Private-Lines: <n>'. Lines joined by a newline each, never '\n?' (nested '+').
  { kind: 'private-key', needs: /Private-Lines:/, re: new RegExp(String.raw`Private-Lines: \d+${LINE_TAIL}[A-Za-z0-9+/=]+(?=[ \t]*(?:${NL}|$))(?:${LINE_TAIL}[A-Za-z0-9+/=]+(?=[ \t]*(?:${NL}|$))){0,200}`, 'g') },
  // ...and its body, with neither: under a 512-token embedder (voyage-4-nano, nomic-embed-text, any model not in
  // EMBEDDER_MAX_TOKENS) a PEM body is split LINE BY LINE and a JSON-escaped one chopped every ~550 chars, so most
  // chunks are nothing but base64 lines. So the WHOLE text (no m flag) being base64 lines, with at most the cut
  // tail of a BEGIN line in front and the cut head of an END line behind, is a key body (notKeyBody has the rest).
  // Every line ends at a newline the class cannot eat, so a near-miss backtracks once per line, not per split; at most
  // 1 000 lines, as above ('A\n'×100 000: 476 ms unbounded, 5 ms bounded). The leading \s* ends on a non-space and a cut
  // END line on a letter, so no two pieces share a whitespace run: 20 000 leading spaces took 1.5 s, a trailing
  // '-' + 20 000 spaces 0.77 s (a cut END line allowed to end on a space: 50 000 spaces, 4.9 s).
  { kind: 'base64-block', skip: notKeyBody, slashes: true,
    re: new RegExp(String.raw`^\s*(?=\S)(?:[A-Z ]*-{1,5}${NL})?(?:\\r\\n|\\n)?[ \t]*(?:>[ \t]*)?(${B64_LINE}(?:${LINE_TAIL}${B64_LINE}){0,1000})(?:${NL}(?:-{1,5}(?:[A-Z ]*[A-Z])?)?|\\r\\?|\\)?\s*$`, 'g') },
  { kind: 'gitlab-token', needs: /gl[a-z]{1,5}-/, re: /(?<![A-Za-z0-9_-])gl(?:pat|ptt|imt|ffct|wt|rtr|rt|dt|ft|oas|soat|cbt|agent)-[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', needs: /gh[pousr]_|github_pat_/, re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'anthropic-key', needs: /sk-ant-/, re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', needs: /sk-/, re: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, skip: isSlug },
  { kind: 'slack-token', needs: /xox[abprs]-/, re: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g, skip: isSlug },
  { kind: 'aws-key', needs: /AKIA/, re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google-key', needs: /AIza/, re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', needs: /eyJ/, re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Voyage AI (the embedder key this product asks for). Starts a run, like jwt.
  { kind: 'voyage-key', needs: /pa-/, re: /(?<![A-Za-z0-9_-])pa-[A-Za-z0-9_-]{40,}/g, skip: isSlug },
  // A credential has a digit, a capital or base64 padding; 'Basic authentication-mechanism' is prose.
  { kind: 'bearer', needs: /Bearer|Basic/, re: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{16,})/g, value: (m) => m[1], skip: (m) => !/[0-9A-Z+=]/.test(m[1]!) },
  // Authorization: <a capitalised scheme word> … (Token, ApiKey, SSWS, Bot, OAuth…) or a raw value. Bearer and Basic went
  // above, so their [REDACTED] never matches here. A credential has a digit, a capital or padding: 'spatie/laravel-permission'
  // and 'via middleware/RequireApiToken' are labels.
  { kind: 'auth-header', needs: /[Aa]uthorization/, re: /\b[Aa]uthorization["']?[ \t]*[:=][ \t]*["']?(?:[A-Z][\w-]{0,40}[ \t]+)?([A-Za-z0-9._~+/=-]{16,})/g,
    value: (m) => m[1], skip: (m) => !/[0-9+=]/.test(m[1]!) && !/[a-z][A-Z]|^[A-Z0-9]+$/.test(m[1]!) },
  // https://user:password@host, redis://:password@host — keep the user, drop the password. The scheme starts a run and
  // is at most 32 chars.
  { kind: 'url-password', needs: /:\\?\/\\?\//, re: /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\\?\/\\?\/[^\s/:@\\]*:([^\s@/\\]{1,})@/gi, value: (m) => m[1],
    skip: (m) => PLACEHOLDER.test(m[1]!) || DUMMY.test(m[1]!) },   // https://gitlab-ci-token:${CI_JOB_TOKEN}@…, redis://:$REDIS_PASSWORD@…
  // password=…, DB_PASSWORD=…, PGPASSWORD=…, export VOYAGE_API_KEY=…, {"password": "…"}, 'db_pass' => '…', x-api-key: …,
  // define('DB_PASSWORD', '…') (a quoted key, a comma, a quoted value), $cfg['db_password'] = '…', os.environ["API_KEY"] = …,
  // {\"password\":\"…\"} (JSON inside a JSON string), **Password:** … (markdown bold). A bare value stops at '&' (a URL's
  // next query parameter) and at a backtick (the end of a code span). ponytail: a password with '&' in it is cut there.
  // The key is a run of up to 64 [A-Za-z0-9_.-] ending in the keyword, starting where such a run starts (so a long
  // identifier is one attempt, not one per character); a quoted value runs to its closing quote; '::' is a path
  // (Token::Kind), not an assignment. kvIsProse drops prose. The comma's lookbehind runs on a comma only: ahead of it,
  // it rescanned the whitespace run at every backtrack ('password' + 20 000 spaces: 0.78 s).
  { kind: 'kv', needs: /pass|pwd|secret|key|token|-test/i, re: new RegExp(`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?(${KV_KEYWORD}))(?:\\\\?["'])?\\]?(?:\\*{1,2}|__)?[ \\t]*(=>|[:=](?!:)|,(?<=["'][ \\t]*,)(?=[ \\t]*["']))(?:\\*{1,2}|__)?[ \\t]*(?:\\\\"([^"\\\\\\n]{4,})\\\\"|"([^"\\n]{4,})"|'([^'\\n]{4,})'|\\x60([^\\x60\\n]{4,})\\x60|["']?([^\\s"',;\\x60&]{4,}))`, 'gi'),
    value: (m) => m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8], skip: kvIsProse },
  // A password on a command line: mysql -u root -pSECRET (glued to -p: `mysql -p word` names a database), sshpass -p
  // SECRET, curl -u user:SECRET. Only after that command (ssh -p2222, gcc -pthread), within 200 chars of it:
  // unbounded, 'mysql -u root '×5 000 on one line took 470 ms. curl's user is one separator then at most 256 chars: a
  // '[ \t=]*' beside a user class that also takes '=' split a '=' run every way ('curl -u' + 20 000 '=': 293 ms).
  { kind: 'cli-password', needs: /mysql|mariadb|sshpass|curl/, re: /(?:\b(?:mysql|mysqldump|mysqladmin|mariadb(?:-dump|-admin)?)\b[^\n|;&]{0,200}?\s-p|\bsshpass\b[^\n|;&]{0,200}?\s-p[ \t]*|\bcurl\b[^\n|;&]{0,200}?\s(?:-u|--user)(?:[ \t]+|=)?['"]?[^\s:'"]{1,256}:)(?:'([^'\n]*)'|"([^"\n]*)"|([^\s'"\x60),]+))/g,
    value: (m) => m[1] ?? m[2] ?? m[3], skip: (m) => { const v = (m[1] ?? m[2] ?? m[3])!; return PLACEHOLDER.test(v) || DUMMY.test(v) || /^[$<[{]/.test(v) || /^[A-Z]{2,20}$/.test(v); } },   // -pSECRET: a stand-in
  // Prose, the way observations write it: "…with password Qz7…", "the password is …", "pw for the OLT: …", "the root
  // password has been changed to …", "the password is now …", "token \x60…\x60", "**password** …". Only a secret-looking value
  // (PROSE_VALUE) goes: 'password field is required', 'password must be 12+ chars', 'the password is SHA256-hashed', a
  // call (const token = getToken(1)) stay. 'for <who>' needs its 'is' or ':' so a word of <who> is never taken for the
  // value. Every optional piece is bounded (four words, four connectives), so a run of spaces is scanned a fixed
  // number of times.
  { kind: 'prose-password', needs: /pass|pw|token|secret|api|-test/i, re: new RegExp(String.raw`(?:\b(?:password|passwd|passphrase|pw|token|secret|api[ _-]?key)|(?<![\w-])x-[a-z0-9]+(?:-[a-z0-9]+){0,3}-test(?:[ \t]+(?:header|value))?)\b(?:\*{1,2}|__)?(?:[ \t]+for(?:[ \t]+[^\s:]{1,40}){1,4}?(?:[ \t]+(?:is|was)\b|[ \t]*[:=]))?(?:[ \t]+(?:is|was|been|has|got|now|still|will|be|changed|set|reset|updated|as|to)\b){0,4}(?:[ \t]*[:=—–→-])?(?:\*{1,2}|__)?(?:[ \t]+|[ \t]*\n[ \t]*)${PROSE_VALUE}`, 'gi'),
    value: (m) => m[1], skip: (m) => HASH_NAME.test(m[1]!) || m[1]!.includes('(') || !/[A-Za-z]/.test(m[1]!) || (!quotedValue(m) && notMixedCase(m)) },
];

/** A rule's whole-match replacements in `text` read with '\/' as '/', mapped back onto `text`: a key body json_encode
 *  escaped is still a key body. Only for rules that replace their whole match. The rules' classes stay plain: '\/' as
 *  an alternation in them made a 64 KiB run of escaped slashes cost 450 ms, one backtracking frame per slash. */
function slashRuns(text: string, r: Rule): { text: string; count: number } {
  const at: number[] = [];   // at[i]: where the unescaped text's char i sits in `text`
  let u = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '/') continue;
    at.push(i);
    u += text[i];
  }
  at.push(text.length);
  let out = '', last = 0, count = 0;
  for (const m of u.matchAll(r.re)) {
    if (r.skip?.(m)) continue;
    out += `${text.slice(last, at[m.index])}[REDACTED:${r.kind}]`;
    last = at[m.index + m[0].length]!;
    count++;
  }
  return { text: out + text.slice(last), count };
}

/** Replace every credential-shaped value in `text`; count = replacements made. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const r of RULES) {
    if (r.needs && !r.needs.test(out)) continue;
    if (r.slashes && out.includes('\\/')) { const s = slashRuns(out, r); out = s.text; count += s.count; continue; }
    out = out.replace(r.re, (...args) => {
      const m = args as unknown as RegExpExecArray;
      if (r.skip?.(m)) return m[0];
      if (!r.value) { count++; return `[REDACTED:${r.kind}]`; }
      const v = r.value(m);
      if (!v) return m[0];
      count++;
      const i = m[0].lastIndexOf(v);   // the value ends the match (bar a closing quote or '@')
      return `${m[0].slice(0, i)}[REDACTED]${m[0].slice(i + v.length)}`;
    });
  }
  return { text: out, count };
}

export function looksLikeCredential(text: string): boolean {
  return redactSecrets(text).count > 0;
}
