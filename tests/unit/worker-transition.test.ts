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
    expect(markTransition({ phase: 'updating', from: '0.50.1', to: '0.50.2' }, p, 1_000)).toBe(true);
    const t = readTransition(p, 1_500);
    expect(t?.phase).toBe('updating');
    expect(t?.from).toBe('0.50.1');
    expect(t?.to).toBe('0.50.2');
    expect(t?.ts).toBe(1_000);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('absent, cleared, corrupt, unknown-phase and undated breadcrumbs all read as null', () => {
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

    writeFileSync(p, JSON.stringify({ phase: 'reticulating', ts: 1_000 }), 'utf-8');
    expect(readTransition(p, 1_000)).toBeNull();                  // a phase we don't know how to honour

    // A truncated write of the synchronous pre-exit 'updating' entry. Without the isFinite guard
    // `now - undefined` is NaN, `NaN > TTL` is false, and this would shield a dead worker FOREVER.
    writeFileSync(p, JSON.stringify({ phase: 'updating' }), 'utf-8');
    expect(readTransition(p, 1_000)).toBeNull();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the TTL bounds the shield in BOTH directions', () => {
  const d = dir();
  try {
    const p = join(d, '.worker-transition');
    markTransition({ phase: 'updating', to: '0.50.2' }, p, 1_000);
    expect(readTransition(p, 1_000 + TRANSITION_TTL_MS)).not.toBeNull();      // boundary: still fresh
    expect(readTransition(p, 1_001 + TRANSITION_TTL_MS)).toBeNull();          // past TTL ⇒ heal normally

    // A clock that jumped backwards (NTP correction, restored snapshot) leaves a breadcrumb dated
    // ahead of `now`. One-sided arithmetic would never age it out — that is a permanent shield.
    writeFileSync(p, JSON.stringify({ phase: 'booting', ts: 500_000 }), 'utf-8');
    expect(readTransition(p, 500_000 - TRANSITION_TTL_MS - 1)).toBeNull();
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('overwriting a live breadcrumb keeps its start time and versions', () => {
  const d = dir();
  try {
    const p = join(d, '.worker-transition');
    markTransition({ phase: 'updating', from: '0.50.1', to: '0.50.2' }, p, 1_000);

    // The incoming worker announces itself 3s later. The TTL must still run from the moment the
    // worker went away (1_000), not from this write — otherwise a boot crash-loop, restarted every
    // few seconds by the supervisor, refreshes the shield forever and self-heal never resumes.
    markTransition({ phase: 'booting' }, p, 4_000);
    const t = readTransition(p, 4_000);
    expect(t?.phase).toBe('booting');       // the phase IS updated…
    expect(t?.ts).toBe(1_000);              // …but the window is anchored to the first write
    expect(t?.from).toBe('0.50.1');         // and the versions survive, so the banner keeps naming them
    expect(t?.to).toBe('0.50.2');

    // Simulate the crash loop: a supervisor restamping every 3s for the whole TTL must not push the
    // window out. (Past the TTL the breadcrumb is gone, so a later write legitimately starts a new
    // window — hence the loop stops at the boundary.)
    for (let now = 7_000; now <= 1_000 + TRANSITION_TTL_MS; now += 3_000) {
      markTransition({ phase: 'booting' }, p, now);
    }
    expect(readTransition(p, 1_001 + TRANSITION_TTL_MS)).toBeNull();

    // A breadcrumb written after the previous one aged out starts a fresh window.
    markTransition({ phase: 'booting' }, p, 900_000);
    expect(readTransition(p, 900_000)?.ts).toBe(900_000);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('the degraded flag is per session, fires once, and prunes day-old litter', () => {
  const d = dir();
  try {
    expect(markSessionDegraded('sess-a', d)).toBe(true);
    markSessionDegraded('sess-b', d);
    expect(consumeSessionDegraded('sess-a', d)).toBe(true);
    expect(consumeSessionDegraded('sess-a', d)).toBe(false);      // consumed — announced exactly once
    expect(consumeSessionDegraded('sess-b', d)).toBe(true);       // one session can't eat another's notice
    expect(consumeSessionDegraded('never-degraded', d)).toBe(false);
    expect(markSessionDegraded('', d)).toBe(false);               // no session id ⇒ nothing to flag

    // A session that never reaches a Stop hook leaves a flag behind; the next mark prunes it.
    const stale = join(d, '.degraded-old');
    writeFileSync(stale, '0', 'utf-8');
    const dayAgo = new Date(Date.now() - 25 * 60 * 60_000);
    utimesSync(stale, dayAgo, dayAgo);
    markSessionDegraded('sess-c', d);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(d).length).toBe(1);                        // only the fresh flag remains
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('a path-hostile session id cannot escape the data dir', () => {
  const d = dir();
  try {
    markSessionDegraded('../../etc/passwd', d);
    const written = readdirSync(d);
    expect(written.length).toBe(1);
    expect(written[0]).not.toContain('/');
    expect(written[0]).not.toContain('\\');
    expect(written[0]).not.toContain('..');
    expect(consumeSessionDegraded('../../etc/passwd', d)).toBe(true);   // and it still round-trips
  } finally { rmSync(d, { recursive: true, force: true }); }
});
