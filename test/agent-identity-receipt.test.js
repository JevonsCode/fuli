import assert from 'node:assert/strict';
import test from 'node:test';
import { taskAgentReceipt } from '../src/agents/identity-receipt.js';
import { successToolResult, hookAdditionalContextToolResult } from '../src/mcp/tool-result.js';
import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

const application = { consoleUrl: 'http://127.0.0.1:3999', config: { personal: { spaceId: 'synthetic-space' } } };
const owner = { projectId: 'synthetic-project', agentId: 'engineer', name: 'Alex Morgan' };

test('generated taste Skills preserve the current task receipt', async () => {
  const receipt = taskAgentReceipt(application, owner);
  const result = await FederatedGraphApplication.prototype.getUserTasteSkill.call({
    getCollaborationPreferences: async () => ({ effective_preferences: [], agent_receipt: receipt,
      context: { personal_space_id: 'synthetic-space', personal_project_id: 'synthetic-project' } })
  });
  assert.deepEqual(result.agent_receipt, receipt);
});

test('every task receives a required, directly renderable owner receipt', () => {
  const receipt = taskAgentReceipt(application, owner);
  assert.equal(receipt.required, true);
  assert.equal(receipt.markdown, 'FULI Agent：[Alex Morgan](<http://127.0.0.1:3999/agents/synthetic-space/engineer>)');
  assert.match(receipt.guidance, /every final user-visible reply/i);
  assert.match(receipt.guidance, /greetings/i);
  assert.match(receipt.guidance, /exactly once/i);
  assert.equal(receipt.work_status, null);
  assert.equal(receipt.persistence, null);
});

test('owner labels are escaped and missing names use the authorized identifier', () => {
  const receipt = taskAgentReceipt(application, { ...owner, name: 'Alex [review]\n<b>*' });
  assert.equal(receipt.markdown.split('\n').length, 1);
  assert.match(receipt.markdown, /Alex \\\[review\\\] &lt;b&gt;\\\*/);
  assert.match(taskAgentReceipt(application, { ...owner, name: null }).markdown, /\[engineer\]/);
});

test('the owner is named first with its role title once, never as "负责人 role"', () => {
  const role = 'Synthetic Framework 负责人';
  assert.equal(taskAgentReceipt(application, { ...owner, name: 'Nova Reed', role }).markdown,
    'FULI Agent：[Nova Reed \\[Synthetic Framework 负责人\\]](<http://127.0.0.1:3999/agents/synthetic-space/engineer>)');
  assert.equal(taskAgentReceipt(application, { ...owner, name: null, role }).markdown,
    'FULI Agent：[Synthetic Framework 负责人](<http://127.0.0.1:3999/agents/synthetic-space/engineer>)');
});

test('the receipt names the lead and each collaborator once, never the lead twice', () => {
  const receipt = taskAgentReceipt(application, { ...owner, collaborators: [
    { agentId: 'employee.jefa', name: 'Jefa' }, { agentId: 'engineer', name: 'Alex Morgan' },
    { agentId: 'reviewer', name: 'Nova Reed' }
  ] });
  assert.equal(receipt.markdown, 'FULI Agent：[Alex Morgan](<http://127.0.0.1:3999/agents/synthetic-space/engineer>)'
    + ' · 协作 [Jefa](<http://127.0.0.1:3999/agents/synthetic-space/employee.jefa>)、'
    + '[Nova Reed](<http://127.0.0.1:3999/agents/synthetic-space/reviewer>)');
  assert.deepEqual(receipt.collaborators.map(item => item.agent_id), ['employee.jefa', 'reviewer']);
});

test('an unavailable owner is explicit and never fabricated', () => {
  const receipt = taskAgentReceipt(application, { projectId: 'synthetic-project', agentId: null });
  assert.equal(receipt.required, true);
  assert.equal(receipt.markdown, 'FULI Agent：分配未完成（任务没有可用负责人）');
  assert.equal(receipt.owner, null);
  assert.equal(receipt.continuation, null);
});

for (const delivery of ['mcp', 'hook']) {
  test(`${delivery} preserves the full mandatory receipt when other context is oversized`, () => {
    const receipt = taskAgentReceipt(application, { ...owner, name: '合成角色'.repeat(80) });
    const value = { ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`extra${i}`, 'x'.repeat(5000)])), agent_receipt: receipt };
    const result = delivery === 'mcp' ? successToolResult(value, { limitBytes: 4096 })
      : hookAdditionalContextToolResult(value, { label: 'Synthetic', hookEventName: 'UserPromptSubmit', limitBytes: 4096 });
    assert.equal(result.structuredContent.truncated, true);
    assert.deepEqual(result.structuredContent.agent_receipt, receipt);
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 4096);
  });
}

test('delivery rejects a budget that cannot hold the mandatory receipt', () => {
  const receipt = taskAgentReceipt(application, owner);
  assert.throws(() => successToolResult({ agent_receipt: receipt }, { limitBytes: 100 }),
    error => error.code === 'validation' && /required Agent receipt/i.test(error.message));
});

test('collaborator details remain one escaped line with only safe reported session links', () => {
  const receipt = taskAgentReceipt(application, { ...owner, collaborators: [
    { agentId: 'reviewer', name: 'Earlier' },
    { agentId: 'reviewer', name: 'Nova', runs: [
      { worker_label: 'Review\n[x](bad)<script>', application: 'codex', session_id: 'one', session_url: 'codex://threads/one', status: 'completed' },
      { application: 'codex', session_id: 'one', session_url: 'codex://threads/one', status: 'completed' },
      ...['javascript:alert(1)', 'https://user:password@example.com/a', 'https://example.com/?token=secret',
        'https://example.com/#token', 'file:///private/data'].map((session_url, i) => ({ session_url, session_id: `bad-${i}` }))
    ] }
  ] });
  assert.equal(receipt.collaborators.length, 1);
  assert.equal(receipt.markdown.split('\n').length, 1);
  assert.match(receipt.markdown, /Review \\\[x\\\]/);
  assert.match(receipt.markdown, /&lt;script&gt;/);
  assert.equal(receipt.markdown.match(/codex:\/\/threads\/one/g).length, 1);
  assert.doesNotMatch(receipt.markdown, /javascript:|password|token=|file:/);
});

test('many executions and long links cannot overflow the mandatory receipt', () => {
  const runs = Array.from({ length: 21 }, (_, i) => ({ run_id: `run-${i}`, task_id: 'task',
    worker_label: 'Review'.repeat(100), application: 'codex', session_id: `native-${i}`,
    session_url: 'https://example.com/' + 'x'.repeat(1900), status: i % 2 ? 'failed' : 'completed',
    observation_ids: Array.from({ length: 30 }, (_, j) => `observation-${j}`) }));
  const receipt = taskAgentReceipt(application, { ...owner, collaborators: [
    { agentId: 'reviewer', name: 'Nova', responsibility: 'Review '.repeat(500), runs }
  ] });
  const result = successToolResult({ agent_receipt: receipt }, { limitBytes: 16384, itemLimit: 20 });
  assert.deepEqual(result.structuredContent.agent_receipt, receipt);
  assert.equal(receipt.collaborators[0].run_count, 21);
  assert.equal(receipt.collaborators[0].omitted_run_count, 18);
  assert.match(receipt.markdown, /另18次/);
  assert.equal(runs.length, 21);
});

test('execution summaries share a total budget without dropping collaborator identities', () => {
  const collaborators = Array.from({ length: 4 }, (_, i) => ({ agentId: `helper-${i}`, name: `Helper ${i}`,
    responsibility: '职责'.repeat(80), runs: Array.from({ length: 3 }, (_, j) => ({
      run_id: `run-${i}-${j}`, task_id: 'task', worker_label: '审'.repeat(80), application: 'codex',
      session_id: `session-${i}-${j}`, session_url: 'https://example.com/' + 'a'.repeat(480), status: 'completed'
    })) }));
  const receipt = taskAgentReceipt(application, { ...owner, collaborators });
  const result = successToolResult({ agent_receipt: receipt }, { limitBytes: 16384, itemLimit: 20 });
  assert.deepEqual(result.structuredContent.agent_receipt, receipt);
  assert.equal(receipt.collaborators.length, 4);
  assert.ok(receipt.collaborators.some(item => item.omitted_run_count > 0));
  for (const item of receipt.collaborators) assert.equal(item.run_count, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 12 * 1024);
});
