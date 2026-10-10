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
  assert.equal(receipt.markdown, 'FULI Agent：负责人 [Alex Morgan](<http://127.0.0.1:3999/agents/synthetic-space/engineer>)');
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

test('the receipt names the lead and each collaborator once, never the lead twice', () => {
  const receipt = taskAgentReceipt(application, { ...owner, collaborators: [
    { agentId: 'employee.jefa', name: 'Jefa' }, { agentId: 'engineer', name: 'Alex Morgan' },
    { agentId: 'reviewer', name: 'Nova Reed' }
  ] });
  assert.equal(receipt.markdown, 'FULI Agent：负责人 [Alex Morgan](<http://127.0.0.1:3999/agents/synthetic-space/engineer>)'
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
