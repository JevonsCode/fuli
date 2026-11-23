// rec#146 item 2: a task of two commands was told every turn to call
// plan_agent_collaboration before implementing and to publish an execution
// plan. Synthetic prompts only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { SMALL, STANDARD, taskGuidanceFor, taskSize } from '../src/graphiti/task-size.js';
import { taskKnowledgeGuidance } from '../src/graphiti/task-knowledge-guidance.js';
import { compactTaskContext } from '../src/conversations/task-context-view.js';
import { entryRules } from '../src/conversations/entry-rules.js';

test('a question, a command run or one named change is small', () => {
  for (const prompt of ['查一下这张合成表的字段', '跑一下 npm run test:node', 'npm test',
    '改一个合成配置项', '把这个合成字段重命名', 'rename the synthetic flag', 'check the synthetic log',
    'run pytest', 'revert that one line']) {
    assert.equal(taskSize(prompt), SMALL, prompt);
  }
});

test('anything that builds, moves or asks for several things is standard', () => {
  for (const prompt of ['实现合成导出接口', '重构合成模块', '设计一个合成方案', '迁移合成数据',
    'implement the synthetic export endpoint', 'refactor the synthetic module',
    '改一个合成配置项，然后重构合成模块', '跑一下测试，接着把结果写进合成报告',
    'rename the synthetic flag and then migrate the data']) {
    assert.equal(taskSize(prompt), STANDARD, prompt);
  }
});

test('a prompt that describes work at length is standard even without a building word', () => {
  const long = `把合成表里的字段核对一遍${'，确认每一列的单位和取值范围都对得上'.repeat(8)}`;
  assert.ok(long.length > 120, `${long.length} chars`);
  assert.equal(taskSize(long), STANDARD);
});

test('FULI never guesses upward: anything it cannot place is standard', () => {
  assert.equal(taskSize(''), STANDARD);
  assert.equal(taskSize(null), STANDARD);
  assert.equal(taskSize(undefined), STANDARD);
  assert.equal(taskSize('合成任务'), STANDARD);
});

test('small talk is small', () => {
  assert.equal(taskSize('你好！'), SMALL);
  assert.equal(taskSize('谢谢'), SMALL);
});

test('a small task is not told how to divide work, and a standard one still is', () => {
  const whole = taskKnowledgeGuidance();
  const small = taskGuidanceFor(whole, SMALL);
  assert.equal(small.collaboration, undefined);
  assert.equal(small.execution_plan, undefined);
  assert.equal(small.checkpoint, whole.checkpoint, 'everything else stays');
  assert.equal(taskGuidanceFor(whole, STANDARD), whole);
  // The rules themselves still carry both, so nothing is lost.
  assert.match(entryRules().sections.task_guidance.collaboration, /plan_agent_collaboration/);
});

test('the compact entry references the whole section and names the rule it left out', () => {
  const entry = token => ({ taskContextToken: token, checkpoint_required: true,
    context: { personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project', project_agent_id: 'lead' } });
  const standard = compactTaskContext({ ...entry('task-standard'), task_guidance: taskKnowledgeGuidance() });
  assert.deepEqual(Object.keys(standard.task_guidance).sort(), ['rules', 'version']);
  assert.equal(standard.task_guidance.not_for_this_task, undefined);
  const small = compactTaskContext({ ...entry('task-small'),
    task_guidance: taskGuidanceFor(taskKnowledgeGuidance(), SMALL) });
  assert.equal(small.task_guidance.rules, standard.task_guidance.rules, 'the same section, by the same version');
  assert.equal(small.task_guidance.version, standard.task_guidance.version, 'the rules version does not move per task');
  assert.deepEqual(small.task_guidance.not_for_this_task, ['execution_plan', 'collaboration']);
  // The text itself is never repeated inline, whichever size the task is.
  assert.equal(JSON.stringify(small).includes('plan_agent_collaboration'), false);
});

test('a task_guidance with a key of its own is delivered as it is, never as a reference', () => {
  const own = { ...taskKnowledgeGuidance(), synthetic_extra: 'SYNTHETIC: something FULI did not write' };
  const view = compactTaskContext({ taskContextToken: 'task-own', checkpoint_required: true, task_guidance: own,
    context: { personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project', project_agent_id: 'lead' } });
  assert.equal(view.task_guidance.rules, undefined);
  assert.equal(view.task_guidance.synthetic_extra, own.synthetic_extra);
});
