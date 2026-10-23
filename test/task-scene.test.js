import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { preferenceTaskApplicability } from '../src/graphiti/preference-task-scope.js';
import { TASK_SCENE_VERSION, taskSceneInput, taskWorkKind } from '../src/graphiti/task-scene.js';

// Shared with graph-provider/tests/test_task_scene.py.
const fixture = JSON.parse(readFileSync(new URL('../test-support/task-scene-cases.json', import.meta.url), 'utf8'));
const applicability = (qualifiers, task, instruction = 'Synthetic rule', aspect = 'taste') => preferenceTaskApplicability(
  { instruction, profile_aspect: aspect, preference_qualifiers: qualifiers },
  { sessionId: task.session_id, workKind: task.work_kind, workflow: task.workflow });

test('the scene table version is the one the shared cases were written for', () => {
  assert.equal(TASK_SCENE_VERSION, fixture.version);
});

test('shared cases: qualifier combinations, fail closed, general and hard-constraint rules', () => {
  for (const item of fixture.cases) {
    assert.equal(applicability(item.qualifiers, item.task, item.instruction, item.aspect), item.expected, item.name);
  }
});

test('shared cases: every tasteDomain row of the versioned table, and domains outside it', () => {
  for (const [domain, scenes] of Object.entries(fixture.taste_domains)) {
    for (const workKind of fixture.work_kinds) {
      const expected = scenes === '*' || scenes.includes(workKind) ? 'applies' : 'excluded';
      assert.equal(applicability({ tasteDomain: domain }, { work_kind: workKind }), expected, `${domain} in ${workKind}`);
    }
  }
});

test('prompt hints: frontend, design and chat; small talk only when the whole message is small talk', () => {
  for (const [prompt, kind] of [
    ['把设置页面的按钮改成圆角', 'frontend'], ['fix the Vue component layout', 'frontend'],
    ['先出一版设计稿和配色', 'design'], ['架构设计评审', 'architecture'],
    ['你好', 'chat'], ['谢谢！辛苦了', 'chat'], ['Hello!', 'chat'],
    ['你好，帮我修复登录 bug', 'implementation'], ['实现闲聊功能', 'implementation'],
    ['今天天气怎么样', null], ['', null], [null, null]
  ]) assert.equal(taskWorkKind(prompt), kind, String(prompt));
  assert.deepEqual(taskSceneInput('你好'), { workKind: 'chat' });
  assert.deepEqual(taskSceneInput('今天天气怎么样'), {});
});
