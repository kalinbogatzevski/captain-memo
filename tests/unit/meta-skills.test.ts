import { test, expect } from 'bun:test';
import { MetaStore } from '../../src/worker/meta.ts';

test('MetaStore keeps skills as first-class rows and cascades document deletion', () => {
  const meta = new MetaStore(':memory:');
  const document_id = meta.upsertDocument({
    source_path: '/h/.agents/skills/review/SKILL.md', channel: 'skill', project_id: 'p',
    sha: 'sha', mtime_epoch: 1, metadata: {},
  });
  meta.upsertSkill({
    document_id, skill_ref: 'codex:review:abc', skill_id: 'review', name: 'review',
    description: 'Review code', instructions: '# Review', raw_content: 'raw',
    source_path: '/h/.agents/skills/review/SKILL.md', source_agent: 'codex',
    content_sha: 'sha', frontmatter: { name: 'review' }, warnings: [],
  });
  expect(meta.getSkillByRef('codex:review:abc')?.description).toBe('Review code');
  expect(meta.listSkills()).toHaveLength(1);
  meta.deleteDocument('/h/.agents/skills/review/SKILL.md');
  expect(meta.listSkills()).toHaveLength(0);
  meta.close();
});
