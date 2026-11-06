import assert from 'node:assert/strict';
import test from 'node:test';
import { keepStatedRules, statedProjectRules } from '../src/graphiti/task-stated-rules.js';
import { taskRecord } from '../src/mcp/provider-task-context-registry.js';

const POLICY = 'Our retry policy for every outbound channel: at most 3 attempts in total, waiting 200 ms before the second '
  + 'attempt and 400 ms before the third; retry only when the provider answers 5xx, never retry a 4xx.';

test('a stated policy, port, command or failure cause is a project rule; requests and questions are not', () => {
  assert.deepEqual(statedProjectRules(`Add retries to the email channel. ${POLICY} Add tests and make sure the suite passes.`), [POLICY]);
  assert.deepEqual(statedProjectRules('Point the smoke test at staging. The staging port is 4611.'), ['The staging port is 4611.']);
  assert.deepEqual(statedProjectRules('Fix the flaky suite. The specs fail because the fixtures are generated and not committed.'),
    ['The specs fail because the fixtures are generated and not committed.']);
  assert.deepEqual(statedProjectRules('We always run `npm run fixtures` before the tests.'), ['We always run `npm run fixtures` before the tests.']);
  assert.deepEqual(statedProjectRules('把重试加上。我们的重试策略：最多 3 次，间隔 200 和 400 毫秒。'), ['我们的重试策略：最多 3 次，间隔 200 和 400 毫秒。']);
  assert.deepEqual(statedProjectRules('测试失败的原因是没有生成 fixtures。'), ['测试失败的原因是没有生成 fixtures。']);
  for (const prompt of [
    'SMS messages get dropped whenever the provider has a hiccup. Give the SMS channel the same retry behaviour we use for email.',
    'Check that every channel follows our retry policy exactly and fix any drift.',
    'What is our retry policy?',
    '我们的重试策略是什么？',
    'Add `GET /healthz` and a test that starts the server on our e2e port.',
    'Environment: our test command is npm test.\nAdd a webhook channel.'
  ]) assert.deepEqual(statedProjectRules(prompt), [], prompt);
});

test('the stated rules are kept as pending project facts in the person\'s words, under their own idempotency key', async () => {
  const captured = [];
  const application = { config: { personal: { spaceId: 'space' } },
    async captureSessionKnowledge(input) { captured.push(input); return { status: 'committed' }; } };
  const task = taskRecord({ token: 'fuli-task-synthetic-9', session_id: 's', personal_project_id: 'tidewater',
    project_agent_id: 'lead', source_application: 'claude_code', entry_via: 'hook' });
  const allowed = async () => ({ allowed: true });
  assert.deepEqual(await keepStatedRules(application, task, `Add retries. ${POLICY}`, { decide: allowed }), { status: 'kept', count: 1 });
  assert.equal(captured.length, 1);
  const [input] = captured;
  assert.equal(input.personalProjectId, 'tidewater');
  assert.equal(input.idempotencyKey, 'fuli-task-synthetic-9:stated:current_project');
  assert.equal(input.entities.length, 1);
  assert.equal(input.entities[0].summary, POLICY);
  assert.equal(input.entities[0].type, 'ProjectFact');
  assert.equal(input.entities[0].confirmationStatus, 'pending');
  assert.equal(input.entities[0].contentSource, 'user_explicit');

  captured.length = 0;
  assert.equal(await keepStatedRules(application, task, 'Add a webhook channel.', { decide: allowed }), null);
  assert.deepEqual(await keepStatedRules(application, task, POLICY, { decide: async () => ({ allowed: false }) }),
    { status: 'capture_disabled', count: 0 });
  const unregistered = taskRecord({ token: 'fuli-task-synthetic-10', session_id: 's', personal_project_id: null, entry_via: 'hook' });
  assert.equal(await keepStatedRules(application, unregistered, POLICY, { decide: allowed }), null);
  assert.deepEqual(captured, []);
});
