import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchGraphTool } from '../src/agent-tools/graph-handlers.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';

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
