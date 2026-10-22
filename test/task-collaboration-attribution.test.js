import assert from 'node:assert/strict';
import test from 'node:test';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';

function scenario(collaboration) {
  let task = { token: 'fuli-task-synthetic-attribution', personalProjectId: 'project', projectAgentId: 'owner',
    sessionId: 'parent', sourceApplication: 'codex', workLogRequired: true, checkpoint: null };
  const app = { config: { personal: { spaceId: 'space' } },
    listProjectAgents() { throw new Error('An active directory entry is not participation evidence'); },
    taskContextRegistry: { context: async () => structuredClone(task), prepare: async () => task,
      checkpoint: async (_token, claim) => {
        task = { ...task, checkpoint: { ...claim, phase: 'complete', ...(collaboration ? { collaboration } : {}) } };
        return structuredClone(task);
      } } };
  const input = { taskContextToken: task.token, sourceApplication: 'codex', disposition: 'retain_nothing',
    reason: 'Synthetic receipt verification.', workLog: { status: 'completed', summary: 'Verified the receipt projection.' } };
  return { app, input };
}

test('public checkpoint names proven failed/cancelled workers once and replays the frozen receipt', async () => {
  const f = scenario({ version: 1, status: 'frozen', owner: { agent_id: 'owner', name: 'Original owner' },
    collaborators: [{ agent_id: 'helper', name: 'Actual helper', runs: [
      { session_id: 'native-one', status: 'failed' }, { session_id: 'native-two', status: 'cancelled' }
    ] }] });
  const first = await checkpointTaskKnowledge(f.app, f.input);
  assert.deepEqual(first.agent_receipt.collaborators.map(value => value.agent_id), ['helper']);
  assert.equal(first.agent_receipt.owner.agent_id, 'owner');
  const replay = await checkpointTaskKnowledge(f.app, { ...f.input, collaborators: ['queued-only', 'owner'] });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.agent_receipt, first.agent_receipt);
  assert.deepEqual(replay.ignored_collaborators, ['queued-only']);
});

test('legacy checkpoints and bare active candidates cannot create worker attribution', async () => {
  const f = scenario(null);
  const first = await checkpointTaskKnowledge(f.app, { ...f.input, collaborators: ['configured-only'] });
  const replay = await checkpointTaskKnowledge(f.app, f.input);
  assert.deepEqual(first.agent_receipt.collaborators, []);
  assert.deepEqual(first.ignored_collaborators, ['configured-only']);
  assert.deepEqual(replay.agent_receipt, first.agent_receipt);
});

for (const status of ['legacy', 'legacy_unknown']) {
  test(`${status} replay resolves only its original owner display name`, async () => {
    const f = scenario(status === 'legacy' ? null : { version: 1, status,
      owner: { agent_id: 'owner', name: null }, collaborators: [] });
    const lookups = [];
    f.app.personal = { getProjectAgent: async (...scope) => {
      lookups.push(scope);
      return { profile: { display_name: 'Original owner' } };
    } };
    await checkpointTaskKnowledge(f.app, f.input);
    const replay = await checkpointTaskKnowledge(f.app, { ...f.input, collaborators: ['configured-only'] });
    assert.equal(replay.replayed, true);
    assert.equal(replay.agent_receipt.owner.agent_id, 'owner');
    assert.equal(replay.agent_receipt.owner.name, 'Original owner');
    assert.deepEqual(replay.agent_receipt.collaborators, []);
    assert.deepEqual(replay.ignored_collaborators, ['configured-only']);
    assert.deepEqual(lookups, [['space', 'project', 'owner'], ['space', 'project', 'owner']]);
  });
}

test('a frozen owner is named first with its frozen role title', async () => {
  const f = scenario({ version: 1, status: 'frozen',
    owner: { agent_id: 'owner', name: 'Nova Reed', role: 'Synthetic Framework 负责人' }, collaborators: [] });
  const result = await checkpointTaskKnowledge(f.app, f.input);
  assert.match(result.agent_receipt.markdown, /^FULI Agent：\[Nova Reed \\\[Synthetic Framework 负责人\\\]\]\(/);
});

test('frozen owner display values never consult the current directory', async () => {
  for (const name of ['Frozen owner', null]) {
    const f = scenario({ version: 1, status: 'frozen', owner: { agent_id: 'owner', name }, collaborators: [] });
    let lookups = 0;
    f.app.personal = { getProjectAgent: async () => { lookups++; return { profile: { name: 'Current owner' } }; } };
    const result = await checkpointTaskKnowledge(f.app, f.input);
    assert.equal(result.agent_receipt.owner.name, name);
    assert.equal(lookups, 0);
  }
});

test('checkpoint retains frozen collaborator duties and execution references in both receipts', async () => {
  const run = { run_id: 'run-1', worker_id: 'worker-1', task_id: 'task-1', work_kind: 'code_review',
    worker_label: 'Review parser', application: 'codex', session_id: 'native-one',
    session_url: 'codex://threads/native-one', status: 'failed', event_id: 'event-1', observation_ids: [] };
  const f = scenario({ version: 1, status: 'frozen', owner: { agent_id: 'owner', name: 'Original owner' },
    collaborators: [{ agent_id: 'helper', name: 'Actual helper', responsibility: 'Review changes', runs: [run] }] });
  f.app.getCapturePolicy = () => ({ enabled: true });
  f.app.personal = { conversation: async () => ({ status: 'saved', conversation_id: 'parent-conversation' }) };
  const result = await checkpointTaskKnowledge(f.app, f.input);
  const helper = result.agent_receipt.collaborators[0];
  assert.equal(helper.responsibility, 'Review changes');
  const { event_id, observation_ids, worker_id, ...reference } = run;
  assert.deepEqual(helper.runs, [reference]);
  assert.equal(helper.run_count, 1);
  assert.equal(helper.omitted_run_count, 0);
  assert.match(result.agent_receipt.markdown, /Review parser/);
  assert.match(result.agent_receipt.markdown, /codex:\/\/threads\/native-one/);
  assert.match(result.agent_receipt.markdown, /失败/);
  assert.deepEqual(result.conversation.receipt, result.agent_receipt);
  const replay = await checkpointTaskKnowledge(f.app, { ...f.input, collaborators: ['unproven'] });
  assert.deepEqual(replay.agent_receipt, result.agent_receipt);
});
