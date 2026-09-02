import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installSessionSkill, removeBundledSkill } from '../src/setup/session-skill.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fuli-session-skill-'));
  const sourcePath = join(root, 'source');
  mkdirSync(sourcePath, { recursive: true });
  writeFileSync(join(sourcePath, 'SKILL.md'), '---\nname: capturing-session-knowledge\n---\nnew\n');
  return {
    root,
    sourcePath,
    agent: {
      id: 'cursor',
      label: 'Cursor',
      skillPath: join(root, '.cursor', 'skills', 'capturing-session-knowledge')
    }
  };
}

test('session Skill is installed into an agent user directory', () => {
  const { root, sourcePath, agent } = fixture();
  const result = installSessionSkill(agent, { sourcePath, backupDir: join(root, 'backups') });

  assert.equal(result.status, 'installed');
  assert.equal(readFileSync(join(agent.skillPath, 'SKILL.md'), 'utf8').includes('new'), true);
});

test('session Skill keeps a recoverable backup before replacement', () => {
  const { root, sourcePath, agent } = fixture();
  mkdirSync(agent.skillPath, { recursive: true });
  writeFileSync(join(agent.skillPath, 'SKILL.md'), 'old\n');

  const result = installSessionSkill(agent, {
    sourcePath,
    backupDir: join(root, 'backups'),
    clock: () => new Date('2026-07-21T12:00:00.000Z')
  });

  assert.equal(result.status, 'installed');
  assert.equal(readFileSync(join(result.backupPath, 'SKILL.md'), 'utf8'), 'old\n');
  assert.equal(readFileSync(join(agent.skillPath, 'SKILL.md'), 'utf8').includes('new'), true);
});

test('session Skill is left untouched when already current', () => {
  const { root, sourcePath, agent } = fixture();
  mkdirSync(agent.skillPath, { recursive: true });
  writeFileSync(join(agent.skillPath, 'SKILL.md'), readFileSync(join(sourcePath, 'SKILL.md')));

  const result = installSessionSkill(agent, { sourcePath, backupDir: join(root, 'backups') });
  assert.deepEqual(result, { status: 'current', path: agent.skillPath, backupPath: null });
});

test('session Skill is updated when a supporting file changed', () => {
  const { root, sourcePath, agent } = fixture();
  const sourceReferences = join(sourcePath, 'references');
  const targetReferences = join(agent.skillPath, 'references');
  mkdirSync(sourceReferences, { recursive: true });
  mkdirSync(targetReferences, { recursive: true });
  writeFileSync(join(sourceReferences, 'guide.md'), 'current\n');
  writeFileSync(join(agent.skillPath, 'SKILL.md'), readFileSync(join(sourcePath, 'SKILL.md')));
  writeFileSync(join(targetReferences, 'guide.md'), 'old\n');

  const result = installSessionSkill(agent, {
    sourcePath,
    backupDir: join(root, 'backups')
  });

  assert.equal(result.status, 'installed');
  assert.equal(readFileSync(join(agent.skillPath, 'references', 'guide.md'), 'utf8'), 'current\n');
});

test('uninstall removes an unchanged bundled Skill but preserves a modified one', () => {
  const current = fixture();
  installSessionSkill(current.agent, {
    sourcePath: current.sourcePath,
    backupDir: join(current.root, 'backups')
  });
  assert.equal(removeBundledSkill(current.agent, {
    sourcePath: current.sourcePath
  }).status, 'removed');

  const modified = fixture();
  installSessionSkill(modified.agent, {
    sourcePath: modified.sourcePath,
    backupDir: join(modified.root, 'backups')
  });
  writeFileSync(join(modified.agent.skillPath, 'SKILL.md'), 'locally modified\n');
  assert.equal(removeBundledSkill(modified.agent, {
    sourcePath: modified.sourcePath
  }).status, 'preserved_modified');
  assert.equal(readFileSync(join(modified.agent.skillPath, 'SKILL.md'), 'utf8'),
    'locally modified\n');
});

test('bundled session Skill advertises both retrieval and capture triggers', () => {
  const skill = readFileSync(
    join(PROJECT_ROOT, 'skills', 'capturing-session-knowledge', 'SKILL.md'),
    'utf8'
  );
  const description = skill.match(/^description:\s*(.+)$/m)?.[1] ?? '';

  assert.match(description, /^Use when /);
  assert.match(description, /URLs?.*routes?.*requirements?.*prior decisions?.*runbooks?/i);
  assert.match(description, /reusable knowledge/i);
  assert.ok(description.length <= 500);
});

test('bundled session Skill uses hook context with an exact preference fallback', () => {
  const skill = readFileSync(
    join(PROJECT_ROOT, 'skills', 'capturing-session-knowledge', 'SKILL.md'),
    'utf8'
  );

  assert.match(skill, /start of every user task/i);
  assert.match(skill, /UserPromptSubmit.*begin_task_context/is);
  assert.match(skill, /do not redundantly call `get_collaboration_preferences`/i);
  assert.match(skill, /prompt-only fallback/i);
  assert.match(skill, /before any other tool or answer/i);
  assert.match(skill, /projectPath.*current working directory/is);
  assert.match(skill, /taskPrompt.*current user request/is);
  assert.match(skill, /task_knowledge_recall/);
  assert.match(skill, /one to four focused queries/is);
  assert.match(skill, /never pass the full conversational request as the sole\s+query/i);
  assert.match(skill, /attributes\.searchTerms/);
  assert.match(skill, /retrieval metadata, not new factual claims/i);
  assert.match(skill, /never stores or returns/i);
  assert.match(skill, /Do not infer\s+or guess `personalProjectId`/i);
  assert.match(skill, /write tools?.*actual payload/is);
  assert.match(skill, /final answer.*not compliance/is);
  assert.match(skill, /search_current_project_knowledge/);
  assert.match(skill, /searches that child project first.*inheritable knowledge/is);
  assert.match(skill, /checkpoint_task_knowledge.*capture_candidates.*retain_nothing/is);
});

test('bundled session Skill never gives the Agent a direct scope-expansion path', () => {
  const skill = readFileSync(
    join(PROJECT_ROOT, 'skills', 'capturing-session-knowledge', 'SKILL.md'),
    'utf8'
  );

  assert.doesNotMatch(skill, /set_personal_preference_scope/);
  assert.match(skill, /safe\s+narrowing.*global.*exact project/is);
  assert.match(skill, /broader.*parent.*personal global.*convergence/is);
  assert.match(skill, /HumanReviewer.*trusted local.*user-presence/is);
});

test('bundled session Skill gates all-local content lookup behind explicit consent', () => {
  const skill = readFileSync(
    join(PROJECT_ROOT, 'skills', 'capturing-session-knowledge', 'SKILL.md'),
    'utf8'
  );

  assert.match(skill, /obvious content-location request/i);
  assert.match(skill, /ask.*widen.*all\s+registered local\s+personal projects/is);
  assert.match(skill, /explicit confirmation.*all_local_confirmed/is);
  assert.match(skill, /does not expand.*public project/is);
  assert.match(skill, /current repository or\s+workspace files/is);
  assert.match(skill, /read-only `Grep`\/`Glob`\/`Read` or `rg`/i);
  assert.match(skill, /user home, filesystem root.*exact safe repository\/workspace root/is);
  assert.match(skill, /route string alone is not a live URL/i);
  assert.match(skill, /paths outside the root/i);
  assert.match(skill, /no supporting result.*noMatchSourceMarker/is);
  assert.match(
    skill,
    /no-match search.*noMatchSourceMarker\.markdown.*intentionally empty.*leadMarkdown/is
  );
});

test('bundled session Skill reports only provider-reported worker execution summaries', () => {
  const skill = readFileSync(
    join(PROJECT_ROOT, 'skills', 'capturing-session-knowledge', 'SKILL.md'),
    'utf8'
  );

  assert.match(skill, /executionSummary/);
  assert.match(skill, /one .*row.*worker|one .*line.*worker/i);
  assert.match(skill, /occupation.*emoji/i);
  assert.match(skill, /actual.*executor.*sourceApplication|sourceApplication.*actual/i);
  assert.match(skill, /work.*summary|summary.*work/i);
  assert.match(skill, /workerStatus|terminal.*status/i);
  assert.match(
    skill,
    /(?:workerStatus[\s\S]{0,120}terminal|terminal[\s\S]{0,120}workerStatus)[\s\S]{0,240}task status[\s\S]{0,120}running/i
  );
  assert.match(
    skill,
    /after[\s\S]{0,160}(?:worker|participant)[\s\S]{0,200}final task[\s\S]{0,160}completed/i
  );
  assert.match(skill, /Markdown table|table.*worker/i);
  assert.match(skill, /Token/i);
  assert.match(skill, /not reported|unreported/i);
  assert.match(skill, /sourceSessionId|session.*(?:ID|link)/i);
  assert.match(skill, /configured.*(?:allowed|available).*not.*evidence/i);
  assert.match(skill, /empty.*executionSummary.*omit|omit.*empty.*executionSummary/i);
});
