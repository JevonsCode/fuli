import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchGraphTool } from '../src/agent-tools/graph-handlers.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';
import { isProviderOutage } from '../src/graphiti/provider-outage.js';

const INPUT = { projectPath: '/synthetic/project', taskPrompt: 'Rename the sample button', sessionId: 'session-synthetic' };

function appFailingWith(error) {
  return { getCollaborationPreferences: async () => { throw error; } };
}

test('rec#105: an unanswered Provider gives a bounded preferences_unavailable entry, not a bare error', async () => {
  const result = await dispatchGraphTool(appFailingWith(new ProviderRequestError('Graphiti provider is unavailable.',
    { code: 'provider_unavailable' })), 'get_collaboration_preferences', INPUT);

  assert.equal(result.status, 'preferences_unavailable');
  assert.equal(result.reason, 'provider_unavailable');
  assert.equal(result.checkpoint_required, false);
  assert.deepEqual(result.preference_delivery, { status: 'unavailable' });
  assert.deepEqual(result.task_lifecycle, { status: 'not_started', reason: 'provider_unavailable' });
  assert.deepEqual(result.retry, { tool: 'get_collaboration_preferences', attempts: 1 });
  assert.equal(result.taskContextToken, undefined);
  assert.equal(result.agent_receipt, undefined);
  assert.match(result.guidance, /never invent them or reuse an earlier token/);
});

test('rec#105: a timeout and a gateway 503 count as an outage too', async () => {
  for (const error of [
    new ProviderRequestError('timed out', { code: 'provider_timeout', status: 504 }),
    new ProviderRequestError('bad gateway', { code: 'provider_http_5xx', status: 503 })
  ]) {
    const result = await dispatchGraphTool(appFailingWith(error), 'get_collaboration_preferences', INPUT);
    assert.equal(result.status, 'preferences_unavailable');
    assert.equal(result.reason, error.code);
  }
});

test('rec#105: a Provider refusal or an application error still fails as before', async () => {
  const refusal = new ProviderRequestError('bad input', { code: 'provider_http_5xx', status: 500 });
  await assert.rejects(dispatchGraphTool(appFailingWith(refusal), 'get_collaboration_preferences', INPUT), refusal);
  const other = new Error('boom');
  await assert.rejects(dispatchGraphTool(appFailingWith(other), 'get_collaboration_preferences', INPUT), other);
  assert.equal(isProviderOutage(new ProviderRequestError('not found', { code: 'provider_error', status: 404 })), false);
});

test('rec#105: a healthy entry passes through unchanged', async () => {
  const entry = { taskContextToken: 'fuli-task-synthetic', effective_preferences: [] };
  const result = await dispatchGraphTool({ getCollaborationPreferences: async () => entry },
    'get_collaboration_preferences', INPUT);
  assert.equal(result, entry);
});
