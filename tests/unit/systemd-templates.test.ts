// tests/unit/systemd-templates.test.ts — the shipped unit templates must encode
// the always-on recovery policy. Pure file reads; runs on any platform.
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '../..');
const UNITS = [
  'services/worker/systemd/captain-memo-worker.user.service',
  'services/worker/systemd/captain-memo-worker.service',
  'services/embed/systemd/captain-memo-embed.user.service',
  'services/embed/systemd/captain-memo-embed.service',
];

describe('systemd unit templates', () => {
  for (const rel of UNITS) {
    test(`${rel} uses Restart=always and disables the start-rate limiter`, () => {
      const unit = readFileSync(join(ROOT, rel), 'utf-8');
      expect(unit).toContain('Restart=always');
      expect(unit).not.toContain('Restart=on-failure');
      expect(unit).toContain('StartLimitIntervalSec=0');
    });
  }
});
