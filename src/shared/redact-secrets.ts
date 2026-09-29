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
// or 'sk-'/'eyJ-'/'glpat-' repeated 25 000 times made every repeat a start that rescanned the rest of the run.

const RULES: { kind: string; re: RegExp; keep?: (m: RegExpExecArray) => string }[] = [
  // A PEM key body is a few KB (RSA-8192 ~6.4 KB), so the scan for END stops at 10 000 chars: unbounded, 2 000 BEGINs with
  // no END took 160 ms, each one scanning to the end of the text.
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,10000}?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'gitlab-token', re: /(?<![A-Za-z0-9_-])gl(?:pat|rt|dt|ft|oas|soat|cbt|agent)-[A-Za-z0-9_-]{16,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { kind: 'anthropic-key', re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'slack-token', re: /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'bearer', re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, keep: (m) => `${m[1]} [REDACTED]` },
  // https://user:password@host — keep the user, drop the password. The scheme starts a run and is at most 32 chars.
  { kind: 'url-password', re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+):([^\s@/]{1,})@/gi, keep: (m) => `${m[1]}:[REDACTED]@` },
  // password=…, passwd: "…", secret=…, api_key = …, token=…, access_key=… (a value of 4+ non-space chars; quotes optional).
  { kind: 'kv', re: /\b((?:pass(?:word|wd|phrase)?|pwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?token|token)\s*[:=]\s*)(["']?)([^\s"',;]{4,})\2/gi, keep: (m) => `${m[1]}[REDACTED]` },
];

/** Replace every credential-shaped value in `text`; count = replacements made. */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const r of RULES) {
    out = out.replace(r.re, (...args) => {
      count++;
      const m = args as unknown as RegExpExecArray;
      return r.keep ? r.keep(m) : `[REDACTED:${r.kind}]`;
    });
  }
  return { text: out, count };
}

export function looksLikeCredential(text: string): boolean {
  return redactSecrets(text).count > 0;
}
