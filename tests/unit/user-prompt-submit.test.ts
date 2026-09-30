import { test, expect } from 'bun:test';

// Guard 2 (2026-09-30): only the USER lifts a work-board block, by typing `override: <file>` as the first line.
import { parseOverridePrompt } from '../../src/hooks/user-prompt-submit.ts';
test('override: resolves a relative path, keeps a remote target, and must open the prompt', () => {
  expect(parseOverridePrompt('override: hr/rpc.php', '/nonexistent-cwd')).toEqual(['/nonexistent-cwd/hr/rpc.php']);
  expect(parseOverridePrompt('  Override : a.php, root@deploy.example.com:/var/www/a.php', '/w')).toEqual(['/w/a.php', 'root@deploy.example.com:/var/www/a.php']);
  expect(parseOverridePrompt('please override: hr/rpc.php', '/w')).toBeNull();
  expect(parseOverridePrompt('fix it\noverride: hr/rpc.php', '/w')).toBeNull();
});
