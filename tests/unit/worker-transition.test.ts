import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  markTransition, readTransition, clearTransition, TRANSITION_TTL_MS,
  markSessionDegraded, consumeSessionDegraded,
} from '../../src/shared/worker-transition.ts';

function dir(): string { return mkdtempSync(join(tmpdir(), 'cm-transition-')); }

test('a fresh breadcrumb reads back with its phase and versions', () => {
  const d = dir();
  try {
    const p = join(d, '.worker-transition');
    markTransition({ phase: 'updating', from: '0.50.1', to: '0.50.2' }, p, 1_000);
    const t = readTransition(p, 1_500);
    expect(t?.phase).toBe('updating');
    expect(t?.from).toBe('0.50.1');
    expect(t?.to).toBe('0.50.2');
    expect(t?.ts).toBe(1_000);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('absent, cleared, corrupt and stale breadcrumbs all read as null', () => {
  const d = dir();
  try {
    const p = join(d, '.worker-transition');
    expect(readTransition(p, 1_000)).toBeNull();                  // never written

    markTransition({ phase: 'booting' }, p, 1_000);
    clearTransition(p);
    expect(existsSync(p)).toBe(false);
    expect(readTransition(p, 1_000)).toBeNull();                  // cleared: the worker is serving

    writeFileSync(p, 'not json at all', 'utf-8');
    expect(readTransition(p, 1_000)).toBeNull();                  // corrupt ⇒ no shield

    // A crashed holder must not shield a genuinely dead worker forever.
    markTransition({ phase: 'updating', to: '0.50.2' }, p, 1_000);
    expect(readTransition(p, 1_000 + TRANSITION_TTL_MS)).not.toBeNull();      // boundary: still fresh
    expect(readTransition(p, 1_001 + TRANSITION_TTL_MS)).toBeNull();          // past TTL ⇒ heal normally
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the degraded flag is per session, fires once, and prunes day-old litter', () => {
  const d = dir();
  try {
    markSessionDegraded('sess-a', d);
    markSessionDegraded('sess-b', d);
    expect(consumeSessionDegraded('sess-a', d)).toBe(true);
    expect(consumeSessionDegraded('sess-a', d)).toBe(false);      // consumed — announced exactly once
    expect(consumeSessionDegraded('sess-b', d)).toBe(true);       // one session can't eat another's notice
    expect(consumeSessionDegraded('never-degraded', d)).toBe(false);

    // A session that never reaches a Stop hook leaves a flag behind; the next mark prunes it.
    const stale = join(d, '.degraded-old');
    writeFileSync(stale, '0', 'utf-8');
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(stale, dayAgo, dayAgo);
    markSessionDegraded('sess-c', d);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(d)).toEqual(['.degraded-sess-c']);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a path-hostile session id cannot escape the data dir', () => {
  const d = dir();
  try {
    markSessionDegraded('../../etc/passwd', d);
    expect(readdirSync(d)).toEqual(['.degraded-etcpasswd']);
    expect(consumeSessionDegraded('../../etc/passwd', d)).toBe(true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
