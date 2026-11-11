import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchGraphTool } from '../src/agent-tools/graph-handlers.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { checkpointTaskKnowledge } from '../src/graphiti/agent-knowledge-workflows.js';

const INPUT = { taskContextToken: 'fuli-task-synthetic', disposition: 'retain_nothing', reason: 'Renamed the sample button' };

function appFailingWith(error) {
  return { checkpointTaskKnowledge: async () => { throw error; } };
}

test('rec#39: an unanswered checkpoint asks for the same input again instead of a bare timeout', async () => {
  const result = await dispatchGraphTool(appFailingWith(new ProviderRequestError('Graphiti provider request timed out.',
    { code: 'provider_timeout', status: 504 })), 'checkpoint_task_knowledge', INPUT);

  assert.equal(result.status, 'checkpoint_incomplete');
  assert.equal(result.reason, 'provider_timeout');
  assert.equal(result.checkpoint_required, true);
  assert.deepEqual(result.retry, { tool: 'checkpoint_task_knowledge', same_input: true, attempts: 1 });
  assert.equal(result.agent_receipt, undefined);
  assert.match(result.guidance, /exactly the same arguments/);
  assert.match(result.guidance, /do not claim the task was saved/);
});

test('rec#39: a checkpoint refusal still fails as before', async () => {
  const refusal = new ProviderRequestError('bad input', { code: 'provider_http_5xx', status: 500 });
  await assert.rejects(dispatchGraphTool(appFailingWith(refusal), 'checkpoint_task_knowledge', INPUT), refusal);
});

test('rec#39: a finished checkpoint passes through unchanged', async () => {
  const done = { status: 'checkpointed' };
  const result = await dispatchGraphTool({ checkpointTaskKnowledge: async () => done }, 'checkpoint_task_knowledge', INPUT);
  assert.equal(result, done);
});

// rec#110 item 8: a token refused when the checkpoint first reads its task,
// before any write, says this call saved nothing and how to resend; a refusal
// after writing began (DOT on #880) fails as before. Through the real
// checkpoint workflow over a synthetic task registry.
function checkpointApp({ refuseAt }) {
  const refusal = status => new ProviderRequestError('Task context not found: C:\synthetic\path sk-synthetic-0123456789',
    { code: 'provider_error', status });
  const steps = [];
  let checkpoint = null;
  const task = () => ({ token: INPUT.taskContextToken, sessionId: 'synthetic-session', personalProjectId: null,
    projectAgentId: null, sourceApplication: 'other', agentAssignment: null, projectScope: null, workLogRequired: false, checkpoint });
  const step = (name, status, answer) => async (_token, value) => { steps.push(name);
    if (refuseAt?.step === name) throw refusal(refuseAt.status); return answer(value); };
  const app = { config: { personal: { spaceId: 'synthetic-space' } }, getCapturePolicy: () => ({ enabled: true }),
    taskContextRegistry: {
      context: step('context', null, () => task()),
      prepare: step('prepare', null, value => { checkpoint = { ...value, phase: 'prepare' }; return task(); }),
      checkpoint: step('complete', null, value => { checkpoint = { ...checkpoint, ...value, phase: 'complete' }; return task(); }) },
    personal: { conversation: async () => ({ status: 'saved', conversation_id: 'synthetic-conversation' }) } };
  app.checkpointTaskKnowledge = input => checkpointTaskKnowledge(app, input);
  return { app, steps };
}

test('a token refused before any write says this call saved nothing and to resend with a token of this connection', async () => {
  for (const status of [403, 404]) {
    const { app, steps } = checkpointApp({ refuseAt: { step: 'context', status } });
    const result = await dispatchGraphTool(app, 'checkpoint_task_knowledge', INPUT);
    assert.deepEqual(steps, ['context']);
    assert.equal(result.status, 'checkpoint_not_saved');
    assert.equal(result.reason, 'task_token_refused');
    assert.equal(result.http_status, status);
    assert.deepEqual(result.retry, { tool: 'checkpoint_task_knowledge', same_content: true, new_token: true });
    assert.match(result.guidance, /this call saved nothing/);
    assert.match(result.guidance, /get_collaboration_preferences/);
    assert.equal(JSON.stringify(result).includes('synthetic'), false);
  }
});

test('a token refused after prepare wrote fails as before, never claiming nothing was saved', async () => {
  for (const status of [403, 404]) {
    const { app, steps } = checkpointApp({ refuseAt: { step: 'complete', status } });
    await assert.rejects(dispatchGraphTool(app, 'checkpoint_task_knowledge', INPUT), { status });
    assert.deepEqual(steps.slice(-2), ['prepare', 'complete']);
  }
});

test('a content refusal still fails as before', async () => {
  const refusal = new ProviderRequestError('bad content', { code: 'provider_error', status: 422 });
  await assert.rejects(dispatchGraphTool(appFailingWith(refusal), 'checkpoint_task_knowledge', INPUT), refusal);
});
