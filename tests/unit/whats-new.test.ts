// #129: the one-time upgrade banner lists what changed between the two versions, read from the CHANGELOG.
import { test, expect } from 'bun:test';
import { whatsNew, newsLines, NEWS_MAX } from '../../src/shared/whats-new.ts';
import { formatUpgradeBanner, formatAutoUpdateBanner } from '../../src/shared/self-update.ts';

const LOG = [
  '# Changelog', '', '## [Unreleased]', '', '- **Not shipped yet.** never listed', '',
  '## [0.5.0] — 2026-09-27', '', '### Added', '', '- **Homework in `top`.** The dashboard has a section.',
  '  - a nested bullet is detail, not a headline', '- A plain bullet with no bold lead. Its second sentence is dropped.', '',
  '## [0.4.1] — 2026-09-26', '', '### Fixed', '', '- **The hint bar fits:** it no longer wraps.', '',
  '## [0.4.0] — 2026-09-20', '', '- **Older than the range.** never listed', '',
].join('\n');

test('whatsNew — headlines after `from` up to and including `to`, newest first', () => {
  expect(whatsNew(LOG, '0.4.0', '0.5.0')).toEqual([
    { version: '0.5.0', text: 'Homework in `top`' },
    { version: '0.5.0', text: 'A plain bullet with no bold lead' },
    { version: '0.4.1', text: 'The hint bar fits' },
  ]);
  expect(whatsNew(LOG, '0.4.1', '0.4.1')).toEqual([]);                  // nothing after 0.4.1 up to 0.4.1
  expect(whatsNew(LOG, '0.4.0', '0.4.1').map((i) => i.version)).toEqual(['0.4.1']);
  expect(whatsNew('', '0.1.0', '0.2.0')).toEqual([]);
});

test('newsLines — capped, with how many more; the version shows only when several are listed', () => {
  expect(newsLines([])).toEqual([]);
  expect(newsLines([{ version: '1.0.0', text: 'a' }])).toEqual(['  What changed:', '  • a']);
  const many = Array.from({ length: NEWS_MAX + 3 }, (_, i) => ({ version: i < 2 ? '1.1.0' : '1.0.0', text: 't' + i }));
  const lines = newsLines(many);
  expect(lines[1]).toBe('  • t0 (1.1.0)');
  expect(lines).toHaveLength(1 + NEWS_MAX + 1);
  expect(lines.at(-1)).toBe('  … and 3 more in CHANGELOG.md');
});

test('both upgrade banners carry the lines, and read as before without them', () => {
  const news = newsLines(whatsNew(LOG, '0.4.0', '0.5.0'));
  const up = formatUpgradeBanner('0.4.0', '0.5.0', news).split('\n');
  expect(up[0]).toBe('⚓ Captain Memo self-upgraded: v0.4.0 → v0.5.0');
  expect(up[1]).toBe('  What changed:');
  expect(up).toContain('  • Homework in `top` (0.5.0)');
  expect(formatUpgradeBanner('0.4.0', '0.5.0')).not.toContain('What changed');
  expect(formatAutoUpdateBanner('0.4.0', '0.5.0', false, news)).toContain('  • The hint bar fits (0.4.1)');
});

test('the real CHANGELOG parses: every released entry yields headlines', async () => {
  const log = await Bun.file(new URL('../../CHANGELOG.md', import.meta.url)).text();
  const versions = [...log.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]!);
  const [newest, prev] = versions;
  expect(whatsNew(log, prev!, newest!).length).toBeGreaterThan(0);
});
