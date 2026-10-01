import { test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// The local sidecar loads voyage-4-nano's remote code, which transformers 5.x cannot run
// (AttributeError in auto_factory.register). These pin the two things that keep a fresh install from
// shipping a sidecar that installs cleanly and then embeds nothing.
const EMBED = join(import.meta.dir, '../../services/embed');
const reqs = readFileSync(join(EMBED, 'requirements.txt'), 'utf-8');
const installSh = readFileSync(join(import.meta.dir, '../../scripts/install-embedder.sh'), 'utf-8');

test('requirements.txt keeps transformers below 5 (voyage-4-nano fails to load on 5.x)', () => {
  const spec = reqs.split('\n').find((l) => /^transformers\b/.test(l.trim()));
  expect(spec).toBeDefined();
  expect(spec).toMatch(/<\s*5(\.0)?(\.0)?\s*($|,|;)/);
  expect(reqs).toContain('auto_factory');   // the comment says why, so nobody "fixes" the cap back to <6
});

test('install-embedder.sh loads the model before it touches the service, and refuses to report an unhealthy sidecar up', () => {
  const load = installSh.indexOf('get_model()');
  expect(load).toBeGreaterThan(0);
  expect(load).toBeLessThan(installSh.indexOf('"${SYSTEMCTL[@]}" enable'));
  expect(installSh).toContain('NOT starting the service');
  expect(installSh).toContain(`'"healthy":true'`);
  expect(installSh).toContain(`'"healthy":false'`);
});
