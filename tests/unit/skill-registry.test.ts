import { test, expect } from 'bun:test';
import { parseSkillDocument, parseSkillFrontmatter } from '../../src/worker/skill-registry.ts';

test('parseSkillFrontmatter handles folded and quoted scalars', () => {
  const parsed = parseSkillFrontmatter(`---\nname: "deploy"\ndescription: >-\n  Ship a release\n  safely.\nlicense: Apache-2.0\n---\n\n# Deploy\n`);
  expect(parsed.fields.name).toBe('deploy');
  expect(parsed.fields.description).toBe('Ship a release safely.');
  expect(parsed.fields.license).toBe('Apache-2.0');
  expect(parsed.body).toContain('# Deploy');
});

test('parseSkillDocument is lossless and records provenance', () => {
  const raw = `---\nname: deploy\ndescription: Ship it\n---\n\nUse \${CLAUDE_PROJECT_DIR}.\n`;
  const skill = parseSkillDocument(raw, '/home/u/.claude/skills/deploy/SKILL.md');
  expect(skill.skill_id).toBe('deploy');
  expect(skill.source_agent).toBe('claude-code');
  expect(skill.raw_content).toBe(raw);
  expect(skill.warnings.length).toBeGreaterThan(0);
  expect(skill.skill_ref).toStartWith('claude-code:deploy:');
});
