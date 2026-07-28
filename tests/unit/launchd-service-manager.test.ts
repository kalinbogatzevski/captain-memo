// tests/unit/launchd-service-manager.test.ts
//
// macOS support, verified from Linux. The parts that can silently produce a BROKEN
// install are pure: label derivation, argv → ProgramArguments, and plist rendering. A
// malformed plist fails at load time with a message that names no cause, so the render
// is worth pinning precisely.
//
// Reported from the field 2026-07-28: the installer wrote a systemd unit on macOS, ran
// three systemctl calls that all failed with ENOENT, and printed "worker service enabled
// + started" anyway — after its own pre-flight had already reported "systemctl not
// found". These tests cover the replacement path.

import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  bareName, labelFor, xmlEscape, programArgsXml, renderPlist,
} from '../../src/services/service-manager/launchd.ts';
import type { ServiceSpec } from '../../src/services/service-manager/types.ts';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const TEMPLATE = readFileSync(join(REPO_ROOT, 'services/worker/launchd/captain-memo-worker.plist'), 'utf-8');

const spec = (over: Partial<ServiceSpec> = {}): ServiceSpec => ({
  name: 'captain-memo-worker',
  description: 'Captain Memo worker',
  exec: ['/Users/rehash/.bun/bin/bun', 'src/worker/index.ts'],
  workingDir: '/Volumes/dev/captain-memo',
  envFile: '/Users/rehash/.config/captain-memo/worker.env',
  autostart: true,
  restartOnFailure: true,
  logDir: '/Users/rehash/Library/Logs/captain-memo',
  ...over,
});

test('a systemd-style .service suffix never leaks into the plist name', () => {
  // doctor/uninstall pass both forms because the Linux impl accepts both; without this
  // the file would be written as com.captainmemo.worker.service.plist and never found.
  expect(bareName('captain-memo-worker.service')).toBe('captain-memo-worker');
  expect(bareName('captain-memo-worker')).toBe('captain-memo-worker');
  expect(labelFor('captain-memo-worker.service')).toBe('com.captainmemo.worker');
  expect(labelFor('captain-memo-embed')).toBe('com.captainmemo.embed');
});

test('ProgramArguments is an ARRAY, one node per argv element', () => {
  // launchd does not parse a shell string. A path with a space must survive as one
  // element rather than being split — which is exactly what a naive join would do.
  const xml = programArgsXml(['/Applications/My Tools/bun', 'src/worker/index.ts']);
  expect(xml).toContain('<string>/Applications/My Tools/bun</string>');
  expect(xml).toContain('<string>src/worker/index.ts</string>');
  expect(xml.split('<string>').length - 1).toBe(2);
});

test('XML metacharacters in a path are escaped', () => {
  expect(xmlEscape('/Volumes/a&b/<dev>')).toBe('/Volumes/a&amp;b/&lt;dev&gt;');
  const out = renderPlist(spec({ workingDir: '/Volumes/R&D/captain-memo' }), TEMPLATE);
  expect(out).toContain('<string>/Volumes/R&amp;D/captain-memo</string>');
  expect(out).not.toContain('R&D');          // the raw ampersand would break the parse
});

test('the rendered plist leaves no placeholder behind', () => {
  const out = renderPlist(spec(), TEMPLATE);
  // A stray __FOO__ is the failure mode that produces a plist launchd rejects with a
  // message naming only the file, so assert on the pattern rather than each name.
  expect(out).not.toMatch(/__[A-Z_]+__/);
});

test('the rendered plist carries the real values', () => {
  const out = renderPlist(spec(), TEMPLATE);
  expect(out).toContain('<string>com.captainmemo.worker</string>');
  expect(out).toContain('<string>/Users/rehash/.bun/bin/bun</string>');
  expect(out).toContain('<string>/Volumes/dev/captain-memo</string>');
  expect(out).toContain('/Users/rehash/Library/Logs/captain-memo/captain-memo-worker.log');
  expect(out).toContain('/Users/rehash/Library/Logs/captain-memo/captain-memo-worker.err.log');
});

test('autostart and restart map onto RunAtLoad and KeepAlive', () => {
  const on = renderPlist(spec({ autostart: true, restartOnFailure: true }), TEMPLATE);
  expect(on).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  expect(on).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);

  const off = renderPlist(spec({ autostart: false, restartOnFailure: false }), TEMPLATE);
  expect(off).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  expect(off).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
});

test('the plist is well-formed XML with balanced tags', () => {
  const out = renderPlist(spec(), TEMPLATE);
  expect(out.startsWith('<?xml')).toBe(true);
  expect(out).toContain('<!DOCTYPE plist');
  expect(out.trimEnd().endsWith('</plist>')).toBe(true);
  for (const tag of ['dict', 'array', 'plist']) {
    const open = (out.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
    const close = (out.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    expect(`${tag}:${open}`).toBe(`${tag}:${close}`);
  }
});

test('a missing logDir falls back rather than rendering an empty path', () => {
  // An empty StandardOutPath makes launchd fail to spawn the job with a bare
  // "Operation not permitted" that names nothing.
  const out = renderPlist(spec({ logDir: '' }), TEMPLATE);
  expect(out).not.toContain('<string>/captain-memo-worker.log</string>');
  expect(out).toMatch(/Library\/Logs\/captain-memo\/captain-memo-worker\.log/);
});

test('the embed template renders too, with its own name', () => {
  const embedTpl = readFileSync(join(REPO_ROOT, 'services/embed/launchd/captain-memo-embed.plist'), 'utf-8');
  const out = renderPlist(spec({ name: 'captain-memo-embed' }), embedTpl);
  expect(out).toContain('<string>com.captainmemo.embed</string>');
  expect(out).toContain('captain-memo-embed.log');
  expect(out).not.toMatch(/__[A-Z_]+__/);
});

test('the launchctl timeout outlasts the plist ThrottleInterval', () => {
  // The field failure, as an invariant. launchd refuses to respawn a job more than once
  // per ThrottleInterval and `kickstart` BLOCKS while inside it. The spawn timeout was
  // 10s and the plist's interval is 10s, so an ordinary throttle wait surfaced as
  // "spawnSync launchctl ETIMEDOUT" and aborted the install. If someone raises the
  // interval, or lowers the timeout, this fails before a user sees it.
  const src = readFileSync(join(REPO_ROOT, 'src/services/service-manager/launchd.ts'), 'utf-8');
  const timeout = Number((src.match(/LAUNCHCTL_TIMEOUT_MS\s*=\s*([0-9_]+)/)?.[1] ?? '0').replace(/_/g, ''));
  const throttle = Number(TEMPLATE.match(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/)?.[1] ?? '0');
  expect(timeout).toBeGreaterThan(0);
  expect(throttle).toBeGreaterThan(0);
  expect(timeout).toBeGreaterThanOrEqual(throttle * 1000 * 3);   // room for several waits
});

test('install does not stack a second launch inside the throttle window', () => {
  // bootstrap + RunAtLoad already starts the job. The extra kickstart made it launch #2,
  // and the caller's restart() made it #3 — all within one 10s window.
  const src = readFileSync(join(REPO_ROOT, 'src/services/service-manager/launchd.ts'), 'utf-8');
  const install = src.slice(src.indexOf('async install('), src.indexOf('async remove('));
  expect(/if \(!spec\.autostart\)/.test(install)).toBe(true);   // kickstart is conditional
  // and the caller must not add one of its own
  const cli = readFileSync(join(REPO_ROOT, 'src/cli/commands/install.ts'), 'utf-8');
  // Anchor on the install SECTION, not on `if (isMac) {` — that also matches the
  // pre-flight block earlier in the file, and the resulting slice swallowed the Windows
  // path's legitimate restart() call.
  // lastIndexOf: the Windows path has its own "Installing worker service" header
  // earlier in the file, and its restart() call there is correct — Scheduled Tasks are
  // IgnoreNew, so a plain start would no-op over a running stale worker.
  const secStart = cli.lastIndexOf("header('Installing worker service');");
  const macBranch = cli.slice(secStart, cli.indexOf('installWorkerService(paths, bunPath);', secStart));
  expect(secStart).toBeGreaterThan(-1);
  expect(macBranch).not.toMatch(/getServiceManager\(\)\.restart\(/);
});
