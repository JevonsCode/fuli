import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  adaptAgentForReviewSkill,
  reviewSkillTrigger
} from '../src/setup/review-skill-adapters.js';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const SKILL_PATH = join(PROJECT_ROOT, 'skills', 'flreview', 'SKILL.md');

test('flreview skill keeps one entry command and the agreed scope tree', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /^---\nname: flreview\ndescription: Use when /);
  assert.match(skill, /\/flreview/);
  assert.doesNotMatch(skill, /\/flreview\s+this/i);
  assert.match(skill, /全部/);
  assert.match(skill, /个人偏好/);
  assert.match(skill, /个人项目/);
  assert.match(skill, /全局偏好.*某一个本地个人项目/s);
  assert.match(skill, /一个本地个人项目.*全部本地个人项目/s);
});

test('flreview skill hard-short-circuits calibration for an impatient user', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /先询问.*耐心/s);
  assert.match(skill, /完全没耐心.*不要再询问.*心情.*时间.*token/is);
  assert.match(skill, /少量.*最高优先级.*关键/s);
  assert.match(skill, /没有上次完成.*全部历史/s);
  assert.match(skill, /只有.*完成.*推进.*上次.*时间/s);
});

test('review skill adaptations keep agent-specific triggers in one module', () => {
  const pathApi = {
    join: (...parts) => parts.join('/')
  };
  const codex = adaptAgentForReviewSkill({ id: 'codex' }, {
    homeDir: '/home/test',
    pathApi
  });
  const claude = adaptAgentForReviewSkill({ id: 'claude-code' }, {
    homeDir: '/home/test',
    pathApi
  });
  const cursor = adaptAgentForReviewSkill({ id: 'cursor' }, {
    homeDir: '/home/test',
    pathApi
  });

  assert.equal(codex.reviewSkillPath, '/home/test/.agents/skills/flreview');
  assert.equal(claude.reviewSkillPath, '/home/test/.claude/skills/flreview');
  assert.equal(cursor.reviewSkillPath, '/home/test/.cursor/skills/flreview');
  assert.deepEqual(reviewSkillTrigger('codex'), {
    userCommand: '/flreview',
    nativeInvocation: '$flreview',
    needsCommandBridge: true
  });
  assert.equal(reviewSkillTrigger('claude-code').nativeInvocation, '/flreview');
  assert.equal(reviewSkillTrigger('cursor').nativeInvocation, '/flreview');
});
