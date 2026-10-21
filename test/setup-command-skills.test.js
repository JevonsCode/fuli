import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  adaptAgentForCommandSkills,
  reviewSkillTrigger
} from '../src/setup/command-skill-adapters.js';
import { installAgent } from '../src/setup/install-agent.js';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
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

  assert.doesNotMatch(skill, /set_personal_preference_scope/);
  assert.match(skill, /Agent.*must not.*direct scope write/is);
  assert.match(skill, /global preference.*safe narrowing.*exact project/is);
  assert.match(skill, /trusted local.*human-review UI/is);
  assert.match(
    skill,
    /project-scoped preference.*parent.*personal global.*convergence.*HumanReviewer/is
  );
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
  const codex = adaptAgentForCommandSkills({ id: 'codex' }, {
    homeDir: '/home/test',
    pathApi
  });
  const claude = adaptAgentForCommandSkills({ id: 'claude-code' }, {
    homeDir: '/home/test',
    pathApi
  });
  const cursor = adaptAgentForCommandSkills({ id: 'cursor' }, {
    homeDir: '/home/test',
    pathApi
  });

  assert.equal(codex.reviewSkillPath, '/home/test/.agents/skills/flreview');
  assert.equal(claude.reviewSkillPath, '/home/test/.claude/skills/flreview');
  assert.equal(cursor.reviewSkillPath, '/home/test/.cursor/skills/flreview');
  assert.deepEqual(reviewSkillTrigger('codex'), {
    userCommand: 'fuli review',
    nativeInvocation: '$flreview'
  });
  assert.equal(reviewSkillTrigger('claude-code').nativeInvocation, '/flreview');
  assert.equal(reviewSkillTrigger('cursor').nativeInvocation, '/flreview');
});

// rec#5 C3b: /fuli start|stop|restart|status is a native command where the client turns
// a Skill into one; the prompt hook answers the line, so the Skill never runs on its own.
test('the FULI session command Skill is installed only where a client takes it as /fuli', () => {
  const pathApi = { join: (...parts) => parts.join('/') };
  const adapt = id => adaptAgentForCommandSkills({ id }, { homeDir: '/home/test', pathApi });
  assert.equal(adapt('claude-code').sessionCommandSkillPath, '/home/test/.claude/skills/fuli');
  assert.equal(adapt('cursor').sessionCommandSkillPath, '/home/test/.cursor/skills/fuli');
  assert.equal(Object.hasOwn(adapt('codex'), 'sessionCommandSkillPath'), false,
    'Codex rejects user-defined slash commands; the person types `fuli stop` there');

  const skill = readFileSync(join(PROJECT_ROOT, 'skills', 'fuli', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: fuli\ndescription: .+\ndisable-model-invocation: true\nargument-hint: start\|stop\|restart\|status\n---\n/);
  assert.match(skill, /do not say FULI was started or stopped/);
  assert.doesNotMatch(skill, /Codex|Claude|Cursor/, 'no client branching in the shared Skill');
});

test('connecting a client installs its /fuli Skill next to the others', async () => {
  const installed = [];
  const paths = { backupDir: '/backups', sessionSkillPath: '/pkg/skills/capturing-session-knowledge',
    projectSkillPath: '/pkg/skills/grilling-project', reviewSkillPath: '/pkg/skills/flreview',
    operationSkillPath: '/pkg/skills/operating-fuli', sessionCommandSkillPath: '/pkg/skills/fuli' };
  const pathApi = { join: (...parts) => parts.join('/') };
  for (const id of ['claude-code', 'codex']) {
    installed.length = 0;
    const agent = adaptAgentForCommandSkills({ id, label: id, skillPath: `/home/${id}/skills/capturing-session-knowledge` },
      { homeDir: `/home/${id}`, pathApi });
    await installAgent(agent, {}, paths, { backupConfig: () => null, connect: () => ({ status: 'connected' }),
      installSkill: (target, { sourcePath }) => { installed.push([target.skillPath, sourcePath]); return { status: 'installed' }; },
      inspectInstallations: null });
    const fuli = installed.filter(([, source]) => source === '/pkg/skills/fuli');
    assert.deepEqual(fuli, id === 'codex' ? [] : [[`/home/${id}/.claude/skills/fuli`, '/pkg/skills/fuli']], id);
  }
});
