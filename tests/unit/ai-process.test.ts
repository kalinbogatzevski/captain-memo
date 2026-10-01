// aiProcessPid walks a fake /proc shaped like the trees verified live (2026-10-01, codex 0.156.1, gemini 0.61.0).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { aiProcessPid } from '../../src/shared/ai-process.ts';

let root = '';
const proc = (pid: number, ppid: number, comm: string, argv: string[]): void => {
  mkdirSync(join(root, String(pid)));
  writeFileSync(join(root, String(pid), 'comm'), comm + '\n');
  writeFileSync(join(root, String(pid), 'cmdline'), argv.join('\0') + '\0');
  writeFileSync(join(root, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 1 1 0 -1`);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fakeproc-'));
  proc(10, 1, 'claude', ['/home/u/.local/bin/claude']);
  proc(11, 10, 'bash', ['/bin/bash', '-c', 'codex']);
  // codex: npm launcher (node) -> native binary -> hook via sh -c -> bun hook; the MCP server is a direct child
  proc(20, 11, 'node', ['node', '/home/u/.npm-global/bin/codex', 'exec', 'hi']);
  proc(21, 20, 'codex', ['/x/vendor/x86_64-unknown-linux-musl/bin/codex', 'exec', 'hi']);
  proc(22, 21, 'sh', ['sh', '-c', 'bun /p/captain-memo-hook.js CodexPreToolUse m']);
  proc(23, 22, 'bun', ['bun', '/p/captain-memo-hook.js', 'CodexPreToolUse', 'm']);
  proc(24, 21, 'bun', ['bun', '/p/mcp-server.js']);
  // gemini: launcher node -> relaunched node (comm node, script after a node flag) -> hook and MCP children
  proc(30, 11, 'node', ['node', '/home/u/.npm-global/bin/gemini', '-p', 'hi']);
  proc(31, 30, 'node', ['/usr/bin/node', '--max-old-space-size=7924', '/home/u/.npm-global/bin/gemini', '-p', 'hi']);
  proc(32, 31, 'bun', ['bun', '/p/captain-memo-hook.js', 'GeminiBeforeTool', 'm']);
  // a codex 11 shells up: past the depth cap from the bottom, found from 7 shells down
  proc(40, 1, 'codex', ['codex']);
  for (let p = 41; p < 52; p++) proc(p, p - 1, 'sh', ['sh']);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('codex: the hook (through sh -c) and the MCP server both resolve to the native codex process', () => {
  expect(aiProcessPid(['codex'], 22, root, 'linux')).toBe(21);
  expect(aiProcessPid(['codex', 'gemini'], 21, root, 'linux')).toBe(21);
});

test('gemini: the hook and the MCP server resolve to the relaunched node, matched on its script', () => {
  expect(aiProcessPid(['gemini'], 31, root, 'linux')).toBe(31);
  expect(aiProcessPid(['codex', 'gemini'], 31, root, 'linux')).toBe(31);
});

test('only the named agents match: a codex hook never takes the claude above it', () => {
  expect(aiProcessPid(['gemini'], 22, root, 'linux')).toBeUndefined();
});

test('fails open: off Linux, past the depth cap, or a missing /proc entry', () => {
  expect(aiProcessPid(['codex'], 22, root, 'darwin')).toBeUndefined();
  expect(aiProcessPid(['codex'], 51, root, 'linux')).toBeUndefined();
  expect(aiProcessPid(['codex'], 47, root, 'linux')).toBe(40);
  expect(aiProcessPid(['codex'], 999, root, 'linux')).toBeUndefined();
});
