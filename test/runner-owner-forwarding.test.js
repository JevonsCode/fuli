import assert from 'node:assert/strict';
import test from 'node:test';

import { FORWARDED_TO_OWNER } from '../src/runner/owner-forwarding.js';
import { errorAnswer, jsonAnswer, pairedFollower } from '../test-support/paired-follower.js';

// A change of a record of global this computer holds only as the host's copy,
// asked within a project it owns (owner-forwarding.js): handed to the host
// once, never queued. Synthetic data only.
const readOnly = () => errorAnswer('replica_read_only', 'This record is a read-only copy of global; nothing was written.');

async function follower(t, options = {}) {
  const paired = await pairedFollower(t, { localAnswer: readOnly, hostAnswer: () => ({ status: 'revised' }), ...options });
  paired.served.routes.setLocalProject('project:widgets', paired.projectPath);
  return paired;
}

test('every tool handed to the host says why the host may simply take it', () => {
  assert.ok(Object.keys(FORWARDED_TO_OWNER).length > 0);
  for (const [tool, why] of Object.entries(FORWARDED_TO_OWNER)) assert.ok(why.length > 10, tool);
});

test('a listed change the copy refused goes to the host once, without this computer\'s token, and says so', async (t) => {
  const paired = await follower(t);
  const input = { personalProjectId: 'widgets', taskContextToken: 'local-token-1', itemId: 'habit-1', action: 'update' };
  const answer = await paired.client.callTool({ name: 'fuli_call', arguments: { toolName: 'revise_personal_knowledge', input } });
  assert.equal(answer.isError, undefined);
  assert.equal(answer.structuredContent.status, 'revised');
  assert.equal(answer.structuredContent.runner.answeredBy, 'host');
  assert.match(answer.structuredContent.runner.message, /handed to Host A[\s\S]*已交给 Host A/);
  assert.deepEqual(paired.calls, [{ name: 'fuli_call', input: { toolName: 'revise_personal_knowledge',
    input: { personalProjectId: 'widgets', itemId: 'habit-1', action: 'update' } } }]);
  assert.equal(paired.local.calls.length, 1, 'tried here first');
});

test('with the host away nothing is changed or queued, and it says whose record it is', async (t) => {
  // Away before anything reached it: a call that may have reached it before the connection broke
  // answers outcome_unknown instead (runner-mcp.js withHost).
  const paired = await follower(t);
  paired.hostAway();
  const answer = await paired.client.callTool({ name: 'fuli_call', arguments: { toolName: 'rename_project_agent',
    input: { personalProjectId: 'widgets', agentId: 'agent-1', name: 'Synthetic' } } });
  const said = JSON.parse(answer.content[0].text);
  assert.equal(said.code, 'owner_unreachable');
  assert.match(said.message, /Host A is away, so nothing was changed[\s\S]*没改/);
  assert.equal(paired.served.store.outbox().queued, 0);
  assert.equal(paired.served.store.entries().length, 0);
});

test('a tool not listed keeps the refusal as this computer gave it', async (t) => {
  const paired = await follower(t);
  const before = paired.calls.length;
  const answer = await paired.client.callTool({ name: 'fuli_call', arguments: { toolName: 'search_current_project_knowledge',
    input: { personalProjectId: 'widgets', queries: ['x'] } } });
  assert.equal(answer.isError, true);
  assert.equal(answer.structuredContent.error.code, 'replica_read_only');
  assert.equal(paired.calls.length, before, 'nothing sent to the host');
});

test('an answer here that is not a refusal of the copy is never handed on', async (t) => {
  const paired = await follower(t, { localAnswer: () => jsonAnswer({ status: 'revised_here' }) });
  const answer = await paired.client.callTool({ name: 'fuli_call', arguments: { toolName: 'revise_personal_knowledge',
    input: { personalProjectId: 'widgets', itemId: 'project-item-1' } } });
  assert.equal(answer.structuredContent.status, 'revised_here');
  assert.equal(paired.calls.length, 0);
});
