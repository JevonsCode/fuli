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
