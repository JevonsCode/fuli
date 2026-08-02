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

test('flreview skill keeps one entry command and lets the invoking Agent generate the review', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /^---\nname: flreview\ndescription: Use when /);
  assert.match(skill, /\/flreview/);
  assert.doesNotMatch(skill, /\/flreview\s+this/i);
  assert.match(skill, /list_personal_projects/);
  assert.match(skill, /start_knowledge_review/);
  assert.match(skill, /list_knowledge_review_candidates/);
  assert.match(skill, /visualize/i);
  assert.match(skill, /window\.openai\.sendFollowUpMessage/);
  assert.match(skill, /all candidates.*same.*interactive.*page/is);
  assert.doesNotMatch(skill, /127\.0\.0\.1:2727\/knowledge-review/);
  assert.doesNotMatch(skill, /codex_app__open_in_codex/);
});

test('flreview calibrates depth inside the setup visualization', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /patience first/i);
  assert.match(skill, /完全没耐心.*hide.*mood.*available-time.*token-budget/is);
  assert.match(skill, /small highest-priority batch/i);
  assert.match(skill, /mood.*available time.*token comfort.*same setup page/is);
  assert.match(skill, /batch size.*not a fixed total-question cap/is);
});

test('flreview renders the agreed fixed actions and no skip action', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  for (const label of [
    '确认保留', '修改', '调整范围', '失效', '稍后处理', '交给 AI 判断'
  ]) {
    assert.match(skill, new RegExp(label));
  }
  assert.match(skill, /all candidates.*at once/is);
  assert.doesNotMatch(skill, /跳过/);
  assert.doesNotMatch(skill, /\bskipped\b/);
});

test('flreview defines scope, invalidation, and AI-delegation semantics', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /global preference.*source project.*set_personal_preference_scope/is);
  assert.match(skill, /project-scoped preference.*global/is);
  assert.match(skill, /ordinary project knowledge.*never.*global preference/is);
  for (const reason of [
    '不应该沉淀为一条复利知识', '不知所云', '过期了', '只在当时生效'
  ]) {
    assert.match(skill, new RegExp(reason));
  }
  assert.match(skill, /custom.*reason/is);
  assert.match(skill, /no second confirmation/is);
  assert.match(skill, /currentQuadrant.*unknown_unknown/is);
  assert.match(skill, /never.*originQuadrant/is);
  assert.match(skill, /delegated_to_ai/);
  assert.match(skill, /revise_personal_knowledge.*before.*record_knowledge_review_progress/is);
});

test('flreview keeps mutations behind explicit visualization actions', () => {
  const skill = readFileSync(SKILL_PATH, 'utf8');

  assert.match(skill, /Do not mutate.*until.*explicit.*action/is);
  assert.match(
    skill,
    /setup action envelope.*must not invent.*review_id.*candidate_key.*item_id.*item_kind/is
  );
  for (const field of [
    'personal_space_id', 'review_id', 'candidate_key', 'item_id', 'item_kind'
  ]) {
    assert.match(skill, new RegExp(field));
  }
  assert.match(skill, /do not present.*one candidate at a time.*chat/is);
  assert.match(skill, /finish_knowledge_review.*paused.*completed/is);
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
