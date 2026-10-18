// Run by tests/unit/test-isolation.test.ts as `bun test ./tests/support/isolation-probe.ts`: it only reports where DATA_DIR and
// CONFIG_DIR resolve under the repo's own test preload. Not a test (no `.test.` in the name, so a plain `bun test` skips it).
import { DATA_DIR, CONFIG_DIR } from '../../src/shared/paths.ts';
console.log('PROBE ' + JSON.stringify({ DATA_DIR, CONFIG_DIR }));
